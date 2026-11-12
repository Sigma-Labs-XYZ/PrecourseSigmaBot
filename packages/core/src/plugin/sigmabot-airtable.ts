export * as SigmaBotAirtable from "./sigmabot-airtable.js"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import type { AppProcess } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"
import type { SigmaBotProgress } from "./sigmabot-progress.js"
import type { SigmaBotTranscript } from "./sigmabot-transcript.js"

/** Where a trainee's records live: a base, its table of trainees, the column holding their email, and its transcripts table. */
export interface Destination {
  readonly base: string
  readonly trainees: string
  readonly emailField: string
  readonly transcripts: string
}

/** The Sigma Labs base that holds the cohort and trainee tables the dashboard reads. */
export const BASE = "app3kRCcq4MHcdSty"
export const SUBMISSIONS = "tblMn7uvZe1P0tZ95"
export const TRAINEES = "tbl8470yTXwItb189"
export const TRANSCRIPTS = "tbllEidn62pmCNkV8"

export const DEFAULT_DESTINATION: Destination = {
  base: BASE,
  trainees: TRAINEES,
  emailField: "SigmaID",
  transcripts: TRANSCRIPTS,
}

/** The base for the trainees on the course now: their rows are in its Assessment table, found by Email. */
export const COURSE_DESTINATION: Destination = {
  base: "appmoo1zTfcJHd6zd",
  trainees: "tbl0VtH8F7WZ1czuC",
  emailField: "Email",
  transcripts: "tbldkYJbRYPAelZOy",
}

const COURSE_TRAINEES = new Set([
  "trainee.aqlima.firdous@sigmalabs.co.uk",
  "trainee.ben.smallbone@sigmalabs.co.uk",
  "trainee.bethel.woldu@sigmalabs.co.uk",
  "trainee.deniz.yarar@sigmalabs.co.uk",
  "trainee.grace.collingwood@sigmalabs.co.uk",
  "trainee.hector.leonvalle@sigmalabs.co.uk",
  "trainee.krzysztof.hajda@sigmalabs.co.uk",
  "trainee.madison.nelson@sigmalabs.co.uk",
  "trainee.martha.smith@sigmalabs.co.uk",
  "trainee.raul.jeevakumar@sigmalabs.co.uk",
  "trainee.samah.sharif@sigmalabs.co.uk",
  "trainee.shawn.awanayah@sigmalabs.co.uk",
  "trainee.subhan.choudhury@sigmalabs.co.uk",
  "trainee.tavis.stringer@sigmalabs.co.uk",
  "trainee.tulsi.patel@sigmalabs.co.uk",
  "trainee.will.ashfield@sigmalabs.co.uk",
  "trainee.william.timothytino@sigmalabs.co.uk",
  "trainee.yasmin.ali@sigmalabs.co.uk",
])

/** The course base for the trainees listed above, the original base for everyone else. */
export function destination(email: string) {
  return COURSE_TRAINEES.has(email.trim().toLowerCase()) ? COURSE_DESTINATION : DEFAULT_DESTINATION
}

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

// Only the row id is used, so no fields are read.
const TraineeFields = Schema.Struct({})

const decodeSubmissions = HttpClientResponse.schemaBodyJson(Page(SubmissionFields))
const decodeTrainees = HttpClientResponse.schemaBodyJson(Page(TraineeFields))

/**
 * Who the trainee is: the verified Sigma Labs email from their sign-in, which is the SigmaID of their Trainees row.
 * Read on every use because the trainee may sign in after SigmaBot has started.
 */
export type Email = Effect.Effect<string | undefined>

/** Request plumbing shared by every table: auth, timeout, and finding the trainee's row by their email. */
function connect(http: HttpClient.HttpClient, input: { readonly token: string; readonly endpoint?: string }) {
  const client = HttpClient.filterStatusOk(http)
  const host = `${input.endpoint ?? ENDPOINT}/v0`
  const base = `${host}/${BASE}`
  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(HttpClientRequest.bearerToken(input.token), HttpClientRequest.acceptJson)
  const run = <A>(effect: Effect.Effect<A, unknown, never>) =>
    effect.pipe(
      Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(new Error("Airtable request timed out")) }),
      Effect.mapError((error) => (error instanceof Error ? error : new Error(String(error)))),
    )

  const traineeID = Effect.fn("SigmaBotAirtable.traineeID")(function* (email: string, where: Destination) {
    const page = yield* run(
      client
        .execute(
          authorized(
            HttpClientRequest.get(`${host}/${where.base}/${where.trainees}`).pipe(
              HttpClientRequest.setUrlParams({
                // The email comes from a local file, so quotes and backslashes are escaped out of the formula.
                filterByFormula: `LOWER({${where.emailField}})="${email.toLowerCase().replace(/[\\"]/g, "\\$&")}"`,
                maxRecords: "1",
                "fields[]": where.emailField,
              }),
            ),
          ),
        )
        .pipe(Effect.flatMap(decodeTrainees), Effect.scoped),
    )
    return page.records[0]?.id
  })

  return { client, host, base, authorized, run, traineeID }
}

/**
 * The shared record of attempts in Airtable for one trainee. Attempts are found by their GitHub username and linked
 * to the trainee's row by their sign-in email. The token is built into the client, as the course design intends:
 * trainees need no Airtable access of their own.
 */
export function remote(
  http: HttpClient.HttpClient,
  input: { readonly token: string; readonly handle: string; readonly email: Email; readonly endpoint?: string },
) {
  const { client, base, authorized, run, traineeID } = connect(http, input)
  // Formula strings only ever hold a validated GitHub handle, so nothing needs escaping.
  const formula = `LOWER({GitHub Handle})="${input.handle.toLowerCase()}"`

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
    // An attempt from someone with no Trainees row, or not signed in, is still recorded; a coach can link it later.
    const email = yield* input.email
    const trainee = email
      ? yield* traineeID(email, DEFAULT_DESTINATION).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
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
 * the same row instead of adding a new one. Which base the rows go to depends on the trainee's email.
 */
export function transcripts(
  http: HttpClient.HttpClient,
  input: { readonly token: string; readonly email: Email; readonly endpoint?: string },
) {
  const { client, host, authorized, run, traineeID } = connect(http, input)

  const upsert = Effect.fn("SigmaBotAirtable.upsertTranscripts")(function* (rows: readonly SigmaBotTranscript.Row[]) {
    if (rows.length === 0) return
    // Rows are only sent for a signed-in trainee; failing keeps them queued rather than saving them unattributed.
    const email = yield* input.email
    if (!email) return yield* Effect.fail(new Error("Not signed in yet, so there is no trainee to back up for"))
    // An email with no Trainees row still gets its transcripts backed up; a coach can link it later.
    const where = destination(email)
    const trainee = yield* traineeID(email, where).pipe(Effect.orElseSucceed(() => undefined))
    for (let start = 0; start < rows.length; start += BATCH)
      yield* run(
        client
          .execute(
            authorized(
              HttpClientRequest.patch(`${host}/${where.base}/${where.transcripts}`).pipe(
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
