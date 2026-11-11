export * as SigmaBotAccount from "./sigmabot-account.js"

import { Global } from "@opencode/util/global"
import { Effect, Option, Schema } from "effect"
import path from "path"

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ email: Schema.String })))

/**
 * The Sigma Labs email the trainee signed in with. The terminal's Auth0 sign-in (packages/tui/src/sigma-auth.ts)
 * verifies it and keeps it in `sigma-auth.json` in the state directory; undefined until the trainee has signed in.
 * Always lower case, so the same person is never two identities.
 */
export const email = (state = Global.Path.state) =>
  Effect.promise(() =>
    Bun.file(path.join(state, "sigma-auth.json"))
      .text()
      .catch(() => ""),
  ).pipe(
    Effect.map((text) =>
      decode(text).pipe(
        Option.map((stored) => stored.email.trim().toLowerCase()),
        Option.getOrUndefined,
      ),
    ),
  )
