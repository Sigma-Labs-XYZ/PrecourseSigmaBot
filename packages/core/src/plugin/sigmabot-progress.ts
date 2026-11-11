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

/** What is known about an attempt beyond its scores; the dashboard shows it next to the attempt. */
export interface Submission {
  readonly course: { readonly id: string; readonly version?: string }
  readonly challenge: { readonly key: string; readonly title: string; readonly module: string }
  readonly functional: number
  readonly nonFunctional: number
  readonly quiz: number
  readonly passed: boolean
  readonly summary: string
}

export interface Recorded {
  /** The attempt number, counting from 1. */
  readonly attempt: number
  /** False when Airtable could not be reached, so the attempt is only on this laptop. */
  readonly synced: boolean
}

export interface Interface {
  /** Every attempt at a challenge, oldest first. */
  readonly attempts: (course: string, challenge: string) => Effect.Effect<readonly Attempt[]>
  readonly record: (submission: Submission) => Effect.Effect<Recorded>
  /** Keys of every challenge with at least one passing attempt. */
  readonly passed: (course: string) => Effect.Effect<ReadonlySet<string>>
}

/** The shared record of attempts: the Airtable table the coach dashboard reads. */
export interface Remote {
  /** Every attempt the trainee has made at any course, oldest first. */
  readonly list: () => Effect.Effect<readonly (Attempt & { readonly course: string })[], Error>
  readonly create: (submission: Submission & { readonly at: string }) => Effect.Effect<void, Error>
}

/**
 * Attempts are always written to SigmaBot's local plugin storage and, when `remote` is given, to Airtable too.
 * Airtable is the source of truth when it answers; the local copy keeps `/submit` working offline, so an attempt
 * made without a connection counts for gating but is not on the dashboard (`synced: false`).
 */
export function make(storage: StorageDomain, remote?: Remote): Interface {
  const key = (course: string, challenge: string) => `submission:${course}:${challenge}`
  const decode = Schema.decodeUnknownOption(Schema.Array(Attempt))

  const localAttempts = Effect.fn("SigmaBotProgress.localAttempts")(function* (course: string, challenge: string) {
    return Option.getOrElse(decode(yield* storage.get(key(course, challenge))), () => [])
  })

  const sharedAttempts = (course: string) =>
    remote
      ? remote.list().pipe(
          Effect.map((all) => all.filter((attempt) => attempt.course === course)),
          Effect.option,
        )
      : Effect.succeed(Option.none<readonly (Attempt & { readonly course: string })[]>())

  const attempts = Effect.fn("SigmaBotProgress.attempts")(function* (course: string, challenge: string) {
    const shared = yield* sharedAttempts(course)
    if (Option.isSome(shared)) return shared.value.filter((attempt) => attempt.challenge === challenge)
    return yield* localAttempts(course, challenge)
  })

  return {
    attempts,
    record: Effect.fn("SigmaBotProgress.record")(function* (submission) {
      const id = submission.course.id
      const at = DateTime.formatIso(yield* DateTime.now)
      const local = yield* localAttempts(id, submission.challenge.key)
      const shared = yield* sharedAttempts(id)
      const number = Option.isSome(shared)
        ? shared.value.filter((attempt) => attempt.challenge === submission.challenge.key).length + 1
        : local.length + 1
      yield* storage.set(key(id, submission.challenge.key), [
        ...local,
        {
          challenge: submission.challenge.key,
          at,
          functional: submission.functional,
          nonFunctional: submission.nonFunctional,
          quiz: submission.quiz,
          passed: submission.passed,
          summary: submission.summary,
        },
      ])
      const synced = remote
        ? yield* remote.create({ ...submission, at }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
        : false
      return { attempt: number, synced }
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
      const shared = yield* sharedAttempts(course)
      if (Option.isSome(shared)) for (const attempt of shared.value) if (attempt.passed) passed.add(attempt.challenge)
      return passed
    }),
  }
}
