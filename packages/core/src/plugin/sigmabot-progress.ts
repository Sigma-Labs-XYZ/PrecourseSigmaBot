export * as SigmaBotProgress from "./sigmabot-progress.js"

import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { DateTime, Effect, Option, Schema } from "effect"

/** One graded submission. Scores are fractions in 0..1. */
export const Attempt = Schema.Struct({
  challenge: Schema.String,
  at: Schema.String,
  functional: Schema.Number,
  nonFunctional: Schema.Number,
  quiz: Schema.Number,
  passed: Schema.Boolean,
  summary: Schema.String,
})
export type Attempt = typeof Attempt.Type

export interface Interface {
  /** Every attempt at a challenge, oldest first. */
  readonly attempts: (course: string, challenge: string) => Effect.Effect<readonly Attempt[]>
  /** Records an attempt and returns its number, counting from 1. */
  readonly record: (course: string, attempt: Omit<Attempt, "at">) => Effect.Effect<number>
  /** Keys of every challenge with at least one passing attempt. */
  readonly passed: (course: string) => Effect.Effect<ReadonlySet<string>>
}

/**
 * TODO(airtable): the pre-course records every attempt in Airtable so the dashboard and SigmaBot share one
 * position. Until that client exists, attempts live in SigmaBot's local plugin storage on the trainee's laptop,
 * which is enough for gating and attempt counts but is lost when the laptop changes.
 */
export function local(storage: StorageDomain): Interface {
  const key = (course: string, challenge: string) => `submission:${course}:${challenge}`
  const decode = Schema.decodeUnknownOption(Schema.Array(Attempt))
  const attempts = Effect.fn("SigmaBotProgress.attempts")(function* (course: string, challenge: string) {
    return Option.getOrElse(decode(yield* storage.get(key(course, challenge))), () => [])
  })
  return {
    attempts,
    record: Effect.fn("SigmaBotProgress.record")(function* (course, attempt) {
      const previous = yield* attempts(course, attempt.challenge)
      const at = DateTime.formatIso(yield* DateTime.now)
      yield* storage.set(key(course, attempt.challenge), [...previous, { ...attempt, at }])
      return previous.length + 1
    }),
    passed: Effect.fn("SigmaBotProgress.passed")(function* (course) {
      const prefix = key(course, "")
      const passed = new Set<string>()
      let after: string | undefined
      do {
        const page = yield* storage.scan({ prefix, after, limit: 100 })
        for (const entry of page.entries) {
          const list = Option.getOrElse(decode(entry.value), () => [])
          if (list.some((attempt) => attempt.passed)) passed.add(entry.key.slice(prefix.length))
        }
        after = page.next
      } while (after !== undefined)
      return passed
    }),
  }
}
