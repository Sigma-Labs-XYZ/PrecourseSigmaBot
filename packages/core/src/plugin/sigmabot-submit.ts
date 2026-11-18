export * as SigmaBotSubmit from "./sigmabot-submit.js"

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "crypto"
import fs from "fs/promises"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/process"
import type { AppProcess } from "@opencode/util/process"
import { ShellSelect } from "../shell/select.js"
import type { SigmaBotCourse } from "./sigmabot-course.js"

/** Quiz pass mark used until the course manifest sets `gates.quiz`. */
export const DEFAULT_QUIZ_GATE = 0.8

/** How long the provided test suite may run before it is stopped and scored as it stands. */
export const TEST_TIMEOUT = "5 minutes"
const OUTPUT_LIMIT = 20_000

export interface TestResult {
  readonly command: string
  readonly exitCode: number | undefined
  readonly output: string
  readonly passed: number
  readonly failed: number
  /** Fraction of tests that passed, or undefined when pytest reported no tests. */
  readonly score: number | undefined
}

/** Runs the challenge's provided test suite from its folder and scores it from the pytest summary line. */
export const tests = Effect.fn("SigmaBotSubmit.tests")(function* (
  proc: AppProcess.Interface,
  input: { readonly shell: string; readonly directory: string; readonly command: string },
) {
  const result = yield* proc
    .run(
      ChildProcess.make(input.shell, ShellSelect.args(input.shell, input.command), {
        cwd: input.directory,
        env: { PYTHONDONTWRITEBYTECODE: "1", PYTEST_ADDOPTS: "--color=no" },
        extendEnv: true,
        stdin: "ignore",
      }),
      { combineOutput: true, maxOutputBytes: 1_000_000, timeout: TEST_TIMEOUT },
    )
    .pipe(Effect.result)
  const text =
    result._tag === "Success"
      ? (result.success.output ?? Buffer.concat([result.success.stdout, result.success.stderr])).toString("utf8")
      : `The test command did not complete. ${result.failure.message}`
  return {
    command: input.command,
    exitCode: result._tag === "Success" ? result.success.exitCode : undefined,
    ...score(text),
  } satisfies TestResult
})

/** Reads pytest's final summary line, such as `3 passed, 1 failed in 0.12s`. */
export function score(output: string) {
  const summary = output.split(/\r?\n/).findLast((line) => /\b\d+ (passed|failed|error|errors)\b/.test(line))
  const count = (word: string) => Number(summary?.match(new RegExp(`\\b(\\d+) ${word}\\b`))?.[1] ?? 0)
  const passed = count("passed")
  const failed = count("failed") + count("errors?")
  const total = passed + failed
  return {
    output: output.length > OUTPUT_LIMIT ? `${output.slice(0, OUTPUT_LIMIT)}\n[output truncated]` : output,
    passed,
    failed,
    score: total > 0 ? passed / total : undefined,
  }
}

export class RubricError extends Schema.TaggedError<RubricError>()("SigmaBotSubmit.RubricError", {
  message: Schema.String,
}) {}

/** The challenge's marking rubric in plain text, decrypted in memory when shipped encrypted. */
export const rubric = Effect.fn("SigmaBotSubmit.rubric")(function* (challenge: SigmaBotCourse.Challenge) {
  if (!challenge.rubric) return yield* new RubricError({ message: `${challenge.key} has no rubric in its manifest` })
  const file = challenge.rubric
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(file.path, "utf8"),
    catch: () => new RubricError({ message: `The rubric file is missing: ${file.path}` }),
  })
  if (!file.encrypted && !isEncrypted(content)) return content
  return yield* Effect.try({
    try: () => decrypt(content),
    catch: () => new RubricError({ message: `The rubric could not be decrypted: ${file.path}` }),
  })
})

/** The quiz guidance in plain text, decrypted in memory when shipped encrypted, or undefined when it cannot be read. */
export const guidance = Effect.fn("SigmaBotSubmit.guidance")(function* (file: string) {
  const content = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
  if (content === undefined || !isEncrypted(content)) return content
  return yield* Effect.try(() => decrypt(content)).pipe(Effect.orElseSucceed(() => undefined))
})

const HEADER_END = "-----END HEADER-----"
const PASSWORD = "sigmalabs"
const SALT_MAGIC = Buffer.from("Salted__")

/** Whether the file carries the explanatory header the course repository puts on its encrypted marking material. */
export function isEncrypted(content: string) {
  return content.includes(HEADER_END)
}

/**
 * Encrypted marking material matches `openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -a -pass pass:sigmalabs`:
 * a text header ending in the `-----END HEADER-----` line, then base64 of `"Salted__" || salt (8 bytes) || ciphertext`.
 */
export function decrypt(content: string) {
  const body = content.includes(HEADER_END) ? content.slice(content.indexOf(HEADER_END) + HEADER_END.length) : content
  const data = Buffer.from(body.trim(), "base64")
  if (!data.subarray(0, SALT_MAGIC.length).equals(SALT_MAGIC)) throw new Error("Missing OpenSSL salt header")
  const { key, iv } = derive(data.subarray(8, 16))
  const decipher = createDecipheriv("aes-256-cbc", key, iv)
  return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString("utf8")
}

export function encrypt(plaintext: string) {
  const salt = randomBytes(8)
  const { key, iv } = derive(salt)
  const cipher = createCipheriv("aes-256-cbc", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([SALT_MAGIC, salt, encrypted]).toString("base64")
}

function derive(salt: Buffer) {
  const bytes = pbkdf2Sync(PASSWORD, salt, 100_000, 48, "sha256")
  return { key: bytes.subarray(0, 32), iv: bytes.subarray(32) }
}
