export * as SigmaBotBackupPlugin from "./sigmabot-backup.js"

import { define } from "@opencode/plugin/effect/plugin"
import { AppProcess } from "@opencode/util/process"
import { DateTime, Duration, Effect, Schedule, Semaphore, Stream } from "effect"
import { HttpClient } from "effect/http"
import { Bus } from "../bus.js"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { SigmaBotAirtable } from "./sigmabot-airtable.js"
import { SigmaBotTranscript } from "./sigmabot-transcript.js"

// Injected by the CLI build from SIGMABOT_AIRTABLE_KEY, like the one the /submit plugin uses.
declare const SIGMABOT_AIRTABLE_KEY: string | undefined

const INTERVAL = Duration.minutes(15)
// A last backup on the way out must not hold up quitting.
const FLUSH_TIMEOUT = Duration.seconds(3)
const PAGE = 100

/**
 * Backs up the trainee's chat transcripts to Airtable: every open chat in one batch every 15 minutes, and a chat's
 * final transcript as soon as it is closed (archived). Does nothing without an Airtable key or a GitHub fork to name
 * the trainee, and never gets in the way of the chat when Airtable cannot be reached.
 */
export const Plugin = define({
  id: "sigmabot.backup",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    const http = yield* HttpClient.HttpClient
    const sessions = yield* Session.Service
    const bus = yield* Bus.Service
    const token = typeof SIGMABOT_AIRTABLE_KEY === "string" ? SIGMABOT_AIRTABLE_KEY : process.env.SIGMABOT_AIRTABLE_KEY
    const handle = token ? yield* SigmaBotAirtable.handle(processes, location.directory) : undefined
    if (!token || !handle) return

    const sync = SigmaBotTranscript.make({
      storage: ctx.storage,
      remote: SigmaBotAirtable.transcripts(http, { token, handle }),
      source: source(sessions, location.directory),
    })
    // The timer, a close, and the final flush can overlap; one backup at a time keeps them from racing.
    const lock = Semaphore.makeUnsafe(1)
    const backup = lock.withPermit(sync()).pipe(Effect.catchCause(() => Effect.void))

    yield* backup.pipe(Effect.repeat(Schedule.spaced(INTERVAL)), Effect.forkScoped({ startImmediately: true }))
    yield* bus.subscribe(SessionEvent.Archived).pipe(
      Stream.runForEach(() => backup),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* Effect.addFinalizer(() => backup.pipe(Effect.timeout(FLUSH_TIMEOUT), Effect.ignore))
  }),
})

/** The top-level chats of one directory, open and closed, read from the session store. */
export function source(sessions: Pick<Session.Interface, "list" | "messages">, directory: AbsolutePath) {
  return {
    chats: Effect.gen(function* () {
      const found: { id: Session.ID; updated: number; closed: boolean }[] = []
      let cursor: Session.ListCursor | undefined
      do {
        const page = yield* sessions.list({ directory, parentID: null, order: "asc", limit: PAGE, cursor })
        found.push(
          ...page.data.map((chat) => ({
            id: chat.id,
            updated: DateTime.toEpochMillis(chat.time.updated),
            closed: chat.time.archived !== undefined,
          })),
        )
        cursor = page.cursor.next
      } while (cursor !== undefined)
      return found
    }).pipe(Effect.orDie),
    messages: (id: Session.ID) => sessions.messages({ sessionID: id, order: "asc" }).pipe(Effect.orDie),
  } satisfies SigmaBotTranscript.Source
}
