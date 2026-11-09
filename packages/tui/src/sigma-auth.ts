import { chmod, rm } from "fs/promises"
import path from "path"
import { Option, Schema } from "effect"
import { createRemoteJWKSet, jwtVerify } from "jose"

export type Settings = { domain: string; clientID: string }

// Native-app client IDs are public. dev.sh/build.sh export AUTH0_DOMAIN and AUTH0_CLIENT_ID from .env; the hardcoded values are the fallback.
export const SIGMA_AUTH0: Settings = {
  domain: process.env.AUTH0_DOMAIN || "dev-m8tn1yrucsayq6nn.us.auth0.com",
  clientID: process.env.AUTH0_CLIENT_ID || "CoBqwjUaChJZzl3juivHfvoKqrx0NUX7",
}

export const ALLOWED_EMAIL_DOMAIN = "sigmalabs.co.uk"
export type DeviceCode = typeof DeviceCodeResponse.Type
export type SessionFile = string

export class SigmaAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
})

const TokenResponse = Schema.Struct({
  id_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optional(Schema.String),
})

const Stored = Schema.Struct({ email: Schema.String, refresh_token: Schema.String })

const decodeDeviceCode = Schema.decodeUnknownSync(DeviceCodeResponse)
const decodeToken = Schema.decodeUnknownSync(TokenResponse)
const decodeError = Schema.decodeUnknownOption(ErrorResponse)
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored))

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function sessionFile(stateDirectory: string): SessionFile {
  return path.join(stateDirectory, "sigma-auth.json")
}

export function isAllowedEmail(email: string) {
  const parts = email.trim().toLowerCase().split("@")
  return parts.length === 2 && parts[0] !== "" && parts[1] === ALLOWED_EMAIL_DOMAIN
}

/** Exchanges a stored refresh token for a freshly signed ID token, so a hand-edited session file cannot unlock the app. */
export async function restore(config: Settings, file: SessionFile) {
  const stored = decodeStored(
    await Bun.file(file)
      .text()
      .catch(() => ""),
  )
  if (Option.isNone(stored)) return
  const tokens = await token(config, { grant_type: "refresh_token", refresh_token: stored.value.refresh_token }).catch(
    async (error) => {
      if (error instanceof SigmaAuthError && ["invalid_grant", "unauthorized_client"].includes(error.code)) {
        await signOut(file)
        return
      }
      throw error
    },
  )
  if (!tokens) return
  const email = await identify(config, tokens.id_token).catch(async (error) => {
    await signOut(file)
    throw error
  })
  await save(file, email, tokens.refresh_token ?? stored.value.refresh_token)
  return email
}

export async function startDeviceLogin(config: Settings) {
  const response = await fetch(`https://${config.domain}/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientID, scope: "openid email profile offline_access" }),
  })
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw oauthError(body, response.status)
  return decodeDeviceCode(body)
}

/** Polls Auth0 until the user approves the device code, then verifies and persists the Sigma Labs identity. */
export async function completeDeviceLogin(config: Settings, file: SessionFile, code: DeviceCode, signal: AbortSignal) {
  const deadline = Date.now() + code.expires_in * 1000
  const poll = async (interval: number): Promise<string> => {
    await Bun.sleep(interval * 1000)
    if (signal.aborted) throw new SigmaAuthError("aborted", "Sign-in cancelled.")
    if (Date.now() > deadline) throw new SigmaAuthError("expired_token", "The sign-in code expired. Try again.")
    const tokens = await token(config, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: code.device_code,
    }).catch((error) => {
      if (!(error instanceof SigmaAuthError)) throw error
      if (error.code === "authorization_pending") return interval
      if (error.code === "slow_down") return interval + 5
      throw error
    })
    if (typeof tokens === "number") return poll(tokens)
    const email = await identify(config, tokens.id_token)
    if (!tokens.refresh_token)
      throw new SigmaAuthError(
        "missing_refresh_token",
        "Auth0 did not return a refresh token. Enable the Refresh Token grant on the SigmaBot Auth0 application.",
      )
    await save(file, email, tokens.refresh_token)
    return email
  }
  return poll(code.interval ?? 5)
}

export async function signOut(file: SessionFile) {
  await rm(file, { force: true })
}

async function identify(config: Settings, idToken: string) {
  const keys = jwks.get(config.domain) ?? createRemoteJWKSet(new URL(`https://${config.domain}/.well-known/jwks.json`))
  jwks.set(config.domain, keys)
  const verified = await jwtVerify(idToken, keys, {
    issuer: `https://${config.domain}/`,
    audience: config.clientID,
  }).catch((error) => {
    throw new SigmaAuthError("invalid_token", `Could not verify the sign-in token: ${String(error)}`)
  })
  const email = verified.payload.email
  if (typeof email !== "string" || verified.payload.email_verified !== true)
    throw new SigmaAuthError("unverified_email", "Your account does not have a verified email address.")
  if (!isAllowedEmail(email))
    throw new SigmaAuthError(
      "forbidden_domain",
      `${email} is not a Sigma Labs email address. Sign in with your @${ALLOWED_EMAIL_DOMAIN} account.`,
    )
  return email
}

async function token(config: Settings, body: Record<string, string>) {
  const response = await fetch(`https://${config.domain}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientID, ...body }),
  })
  const json = await response.json().catch(() => undefined)
  if (!response.ok) throw oauthError(json, response.status)
  return decodeToken(json)
}

async function save(file: SessionFile, email: string, refreshToken: string) {
  await Bun.write(file, JSON.stringify({ email, refresh_token: refreshToken }))
  await chmod(file, 0o600)
}

function oauthError(body: unknown, status: number) {
  const error = decodeError(body)
  if (Option.isNone(error)) return new SigmaAuthError("http_error", `Auth0 request failed with status ${status}.`)
  return new SigmaAuthError(error.value.error, error.value.error_description ?? error.value.error)
}
