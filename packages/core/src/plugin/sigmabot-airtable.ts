export * as SigmaBotAirtable from "./sigmabot-airtable.js"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { AppProcess } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"
import type { SigmaBotProgress } from "./sigmabot-progress.js"
import type { SigmaBotTranscript } from "./sigmabot-transcript.js"

/** The Sigma Labs base that holds the cohort and trainee tables the dashboard reads. */
export const BASE = "app3kRCcq4MHcdSty"
export const SUBMISSIONS = "tblMn7uvZe1P0tZ95"
export const TRAINEES = "tbl8470yTXwItb189"
export const TRANSCRIPTS = "tbllEidn62pmCNkV8"

export const ENDPOINT = "https://api.airtable.com"
const TIMEOUT = Duration.seconds(10)

const Page = <A extends Schema.Constraint>(fields: A) =>
  Schema.Struct({
    records: Schema.Array(Schema.Struct({ id: Schema.String, fields })),
    offset: Schema.optional(Schema.String),
  })

// Airtable leaves empty cells out of a record, and leaves unticked checkboxes out too.
const SubmissionFields = Schema.Struct({
  Challenge: Schema.optional(Schema.String),
  Course: Schema.optional(Schema.String),
  "Submitted At": Schema.optional(Schema.String),
  "Functional Score": Schema.optional(Schema.Number),
  "Non-functional Score": Schema.optional(Schema.Number),
  "Quiz Score": Schema.optional(Schema.Number),
  Passed: Schema.optional(Schema.Boolean),
  Summary: Schema.optional(Schema.String),
})

const TraineeFields = Schema.Struct({ "GitHub Handle": Schema.optional(Schema.String) })

const decodeSubmissions = HttpClientResponse.schemaBodyJson(Page(SubmissionFields))
const decodeTrainees = HttpClientResponse.schemaBodyJson(Page(TraineeFields))

/** Request plumbing shared by every table: auth, timeout, and finding the trainee's row by GitHub handle. */
function connect(
  http: HttpClient.HttpClient,
  input: { readonly token: string; readonly handle: string; readonly endpoint?: string },
) {
  const client = HttpClient.filterStatusOk(http)
  const base = `${input.endpoint ?? ENDPOINT}/v0/${BASE}`
  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(HttpClientRequest.bearerToken(input.token), HttpClientRequest.acceptJson)
  const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
    effect.pipe(
      Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new Error("Airtable request timed out")) }),
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    )
  // Formula strings only ever hold a validated GitHub handle, so nothing needs escaping.
  const formula = `LOWER({GitHub Handle})="${input.handle.toLowerCase()}"`

  const traineeID = Effect.fn("SigmaBotAirtable.traineeID")(function* () {
    const page = yield* run(
      client
        .execute(
          authorized(
            HttpClientRequest.get(`${base}/${TRAINEES}`).pipe(
              HttpClientRequest.setUrlParams({
                filterByFormula: formula,
                maxRecords: "1",
                "fields[]": "GitHub Handle",
              }),
            ),
          ),
        )
        .pipe(Effect.flatMap(decodeTrainees), Effect.scoped),
    )
    return page.records[0]?.id
  })

  return { client, base, authorized, run, formula, traineeID }
}

/**
 * The shared record of attempts in Airtable for one trainee, identified by their GitHub username. The token is
 * built into the client, as the course design intends: trainees need no Airtable access of their own.
 */
export function remote(
  http: HttpClient.HttpClient,
  input: { readonly token: string; readonly handle: string; readonly endpoint?: string },
) {
  const { client, base, authorized, run, formula, traineeID } = connect(http, input)

  const list = Effect.fn("SigmaBotAirtable.list")(function* () {
    const all: (SigmaBotProgress.Attempt & { readonly course: string })[] = []
    let offset: string | undefined
    do {
      const page = yield* run(
        client
          .execute(
            authorized(
              HttpClientRequest.get(`${base}/${SUBMISSIONS}`).pipe(
                HttpClientRequest.setUrlParams({
                  filterByFormula: formula,
                  pageSize: "100",
                  "sort[0][field]": "Submitted At",
                  "sort[0][direction]": "asc",
                  ...(offset ? { offset } : {}),
                }),
              ),
            ),
          )
          .pipe(Effect.flatMap(decodeSubmissions), Effect.scoped),
      )
      for (const record of page.records)
        all.push({
          challenge: record.fields.Challenge ?? "",
          course: record.fields.Course ?? "",
          at: record.fields["Submitted At"] ?? "",
          functional: record.fields["Functional Score"] ?? 0,
          nonFunctional: record.fields["Non-functional Score"] ?? 0,
          quiz: record.fields["Quiz Score"] ?? 0,
          passed: record.fields.Passed ?? false,
          summary: record.fields.Summary ?? "",
        })
      offset = page.offset
    } while (offset !== undefined)
    return all.filter((attempt) => attempt.challenge !== "")
  })

  const create = Effect.fn("SigmaBotAirtable.create")(function* (
    submission: SigmaBotProgress.Submission & { readonly at: string },
  ) {
    // A handle with no Trainees row still gets its attempt recorded; a coach can link it later.
    const trainee = yield* traineeID().pipe(Effect.orElseSucceed(() => undefined))
    yield* run(
      client
        .execute(
          authorized(
            HttpClientRequest.post(`${base}/${SUBMISSIONS}`).pipe(
              HttpClientRequest.bodyJsonUnsafe({
                fields: {
                  Challenge: submission.challenge.key,
                  "GitHub Handle": input.handle,
                  ...(trainee ? { Trainee: [trainee] } : {}),
                  Course: submission.course.id,
                  ...(submission.course.version ? { "Course Version": submission.course.version } : {}),
                  "Challenge Title": submission.challenge.title,
                  Module: submission.challenge.module,
                  "Submitted At": submission.at,
                  "Functional Score": submission.functional,
                  "Non-functional Score": submission.nonFunctional,
                  "Quiz Score": submission.quiz,
                  Passed: submission.passed,
                  Summary: submission.summary,
                },
              }),
            ),
          ),
        )
        .pipe(Effect.scoped),
    )
  })

  return { list, create } satisfies SigmaBotProgress.Remote
}

// Airtable accepts at most ten records per write.
const BATCH = 10

/**
 * Backs up chat transcripts to Airtable: one row per chat, found again by its Session ID so every sync updates
 * the same row instead of adding a new one.
 */
export function transcripts(
  http: HttpClient.HttpClient,
  input: { readonly token: string; readonly handle: string; readonly endpoint?: string },
) {
  const { client, base, authorized, run, traineeID } = connect(http, input)

  const upsert = Effect.fn("SigmaBotAirtable.upsertTranscripts")(function* (rows: readonly SigmaBotTranscript.Row[]) {
    if (rows.length === 0) return
    // A handle with no Trainees row still gets its transcripts backed up; a coach can link it later.
    const trainee = yield* traineeID().pipe(Effect.orElseSucceed(() => undefined))
    for (let start = 0; start < rows.length; start += BATCH)
      yield* run(
        client
          .execute(
            authorized(
              HttpClientRequest.patch(`${base}/${TRANSCRIPTS}`).pipe(
                HttpClientRequest.bodyJsonUnsafe({
                  performUpsert: { fieldsToMergeOn: ["Session ID"] },
                  records: rows.slice(start, start + BATCH).map((row) => ({
                    fields: {
                      "Session ID": row.sessionID,
                      ...(trainee ? { Trainee: [trainee] } : {}),
                      Transcript: row.transcript,
                      Status: row.closed ? "Closed" : "Open",
                      "Last Synced": row.syncedAt,
                    },
                  })),
                }),
              ),
            ),
          )
          .pipe(Effect.scoped),
      )
  })

  return { upsert } satisfies SigmaBotTranscript.Remote
}

/**
 * The trainee's GitHub username: the owner of their fork, read from `origin`. Undefined outside a git
 * repository, without an origin, or when the owner is not a plausible GitHub username.
 */
export const handle = Effect.fn("SigmaBotAirtable.handle")(function* (proc: AppProcess.Interface, directory: string) {
  const result = yield* proc
    .run(
      ChildProcess.make(gitExecutable(), ["remote", "get-url", "origin"], {
        cwd: directory,
        env: { GIT_TERMINAL_PROMPT: "0" },
        extendEnv: true,
        stdin: "ignore",
      }),
      { maxOutputBytes: 10_000 },
    )
    .pipe(Effect.option)
  return Option.match(result, {
    onNone: () => undefined,
    onSome: (output) => owner(output.exitCode === 0 ? output.stdout.toString("utf8") : ""),
  })
})

/** The owner in an https, ssh or scp-style GitHub remote URL. */
export function owner(url: string) {
  const match = /github\.com[:/]([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/[^/\s]+?(?:\.git)?\/?\s*$/i.exec(
    url.trim(),
  )
  return match?.[1]
}
