export * as SigmaBotSubmit from "./sigmabot-submit.js"

import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
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

/** The challenge's marking rubric in plain text, decrypted with the key built into SigmaBot when shipped encrypted. */
export const rubric = Effect.fn("SigmaBotSubmit.rubric")(function* (
  challenge: SigmaBotCourse.Challenge,
  key: string | undefined,
) {
  if (!challenge.rubric) return yield* new RubricError({ message: `${challenge.key} has no rubric in its manifest` })
  const file = challenge.rubric
  const content = yield* Effect.tryPromise({
    try: () => fs.readFile(file.path, "utf8"),
    catch: () => new RubricError({ message: `The rubric file is missing: ${file.path}` }),
  })
  if (!file.encrypted) return content
  if (!key) return yield* new RubricError({ message: "The rubric is encrypted but SigmaBot has no rubric key" })
  return yield* Effect.try({
    try: () => decrypt(content, key),
    catch: () => new RubricError({ message: `The rubric could not be decrypted: ${file.path}` }),
  })
})

/**
 * Rubric encryption: AES-256-GCM with a 32-byte key given as 64 hex characters. The file holds base64 of
 * `iv (12 bytes) || ciphertext || tag (16 bytes)`. The course repository encrypts with the same layout.
 */
export function encrypt(plaintext: string, key: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv)
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString("base64")
}

export function decrypt(encoded: string, key: string) {
  const data = Buffer.from(encoded.trim(), "base64")
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(data.length - 16))
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8")
}
