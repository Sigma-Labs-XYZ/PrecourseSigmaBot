import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { SigmaBotAirtable } from "@opencode/core/plugin/sigmabot-airtable"
import { SigmaBotTranscript } from "@opencode/core/plugin/sigmabot-transcript"
import { testEffect } from "./lib/effect"

// Talks to a real HTTP server on loopback, so the live clock is used throughout.
const it = testEffect(FetchHttpClient.layer)

type Record = { fields: { [field: string]: unknown } }

/** A stand-in Airtable: the Trainees lookup and an upserting transcripts table. */
function airtable(options: { readonly failWrites?: boolean } = {}) {
  const requests: { method: string; path: string; body?: unknown }[] = []
  const rows = new Map<string, Record>()
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "PATCH" ? ((await request.json()) as { records: Record[] }) : undefined
      requests.push({ method: request.method, path: url.pathname, body })
      if (request.method === "GET")
        return Response.json({ records: [{ id: "recTrainee1", fields: { "GitHub Handle": "ada-lovelace" } }] })
      if (options.failWrites) return new Response("nope", { status: 500 })
      body!.records.forEach((record) => rows.set(String(record.fields["Session ID"]), record))
      return Response.json({ records: [] })
    },
  })
  return { requests, rows, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

const use = <A, E, R>(
  options: Parameters<typeof airtable>[0],
  body: (fake: ReturnType<typeof airtable>) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => airtable(options)),
    body,
    (fake) => Effect.sync(fake.stop),
  )

function memoryStorage(): StorageDomain {
  const map = new Map<string, Schema.Json>()
  return {
    get: (key) => Effect.sync(() => map.get(key)),
    set: (key, value) => Effect.sync(() => void map.set(key, value)),
    remove: (key) => Effect.sync(() => void map.delete(key)),
    scan: () => Effect.sync(() => ({ entries: [] })),
  }
}

const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 11, 9, 30))
const user = (text: string) =>
  ({ type: "user", id: "msg_1", text, time: { created: at } }) as unknown as SessionMessage.Info
const assistant = (...content: object[]) =>
  ({ type: "assistant", id: "msg_2", content, time: { created: at } }) as unknown as SessionMessage.Info
const text = (value: string) => ({ type: "text", text: value })

/** A mutable set of chats, standing in for the sessions in one project. */
function chats() {
  const state = new Map<string, { updated: number; closed: boolean; messages: SessionMessage.Info[] }>()
  const id = (value: string) => value as Session.ID
  return {
    state,
    source: {
      chats: Effect.sync(() =>
        [...state].map(([key, chat]) => ({ id: id(key), updated: chat.updated, closed: chat.closed })),
      ),
      messages: (key: Session.ID) => Effect.sync(() => state.get(key)!.messages),
    } satisfies SigmaBotTranscript.Source,
  }
}

describe("SigmaBotTranscript.render", () => {
  it.effect("writes the conversation as readable text, leaving out reasoning and internal prompts", () =>
    Effect.sync(() => {
      const transcript = SigmaBotTranscript.render([
        user("How do I undo a commit?"),
        {
          type: "synthetic",
          id: "msg_s",
          text: "LONG HIDDEN INSTRUCTIONS",
          description: "/submit",
          time: { created: at },
        } as unknown as SessionMessage.Info,
        {
          type: "synthetic",
          id: "msg_t",
          text: "ANOTHER HIDDEN PROMPT",
          time: { created: at },
        } as unknown as SessionMessage.Info,
        assistant({ type: "reasoning", text: "thinking out loud" }, text("Use git revert."), {
          type: "tool",
          name: "bash",
          state: {
            status: "completed",
            input: { command: "git log" },
            content: [{ type: "text", text: "abc123 first" }],
          },
        }),
      ])
      expect(transcript).toBe(
        [
          "You:\nHow do I undo a commit?",
          "You: /submit",
          'SigmaBot:\nUse git revert.\n[tool bash] {"command":"git log"}\nabc123 first',
        ].join("\n\n"),
      )
    }),
  )

  it.effect("keeps the newest part when a chat is longer than Airtable allows, and says so", () =>
    Effect.sync(() => {
      const transcript = SigmaBotTranscript.render(
        Array.from({ length: 2_000 }, (_, index) => user(`message number ${index} ${"x".repeat(100)}`)),
      )
      expect(transcript.length).toBeLessThanOrEqual(SigmaBotTranscript.MAX_LENGTH)
      expect(transcript.startsWith("[Earlier part of this chat was cut to fit Airtable.]")).toBe(true)
      expect(transcript).toContain("message number 1999")
      expect(transcript).not.toContain("message number 0 ")
    }),
  )
})

describe("SigmaBotTranscript.make", () => {
  it.live("backs up each chat as one row, updates it as the chat grows, and finishes it when it closes", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const fakeChats = chats()
        const sync = SigmaBotTranscript.make({
          source: fakeChats.source,
          storage: memoryStorage(),
          remote: SigmaBotAirtable.transcripts(http, {
            token: "pat123",
            handle: "ada-lovelace",
            endpoint: fake.endpoint,
          }),
        })
        fakeChats.state.set("ses_a", { updated: 1, closed: false, messages: [user("hello")] })
        fakeChats.state.set("ses_b", { updated: 1, closed: false, messages: [user("other chat")] })

        yield* sync()
        expect(fake.requests.filter((request) => request.method === "PATCH")).toHaveLength(1)
        const request = fake.requests.find((entry) => entry.method === "PATCH")!
        expect(request.path).toBe("/v0/app3kRCcq4MHcdSty/tbllEidn62pmCNkV8")
        expect(request.body).toMatchObject({ performUpsert: { fieldsToMergeOn: ["Session ID"] } })
        expect([...fake.rows.keys()].sort()).toEqual(["ses_a", "ses_b"])
        expect(fake.rows.get("ses_a")!.fields).toMatchObject({
          Trainee: ["recTrainee1"],
          Transcript: "You:\nhello",
          Status: "Open",
        })
        expect(fake.rows.get("ses_a")!.fields["Last Synced"]).toBeString()

        // Nothing changed, so nothing is sent.
        const before = fake.requests.length
        yield* sync()
        expect(fake.requests.length).toBe(before)

        // Only the chat that moved on is sent again, into the same row.
        fakeChats.state.set("ses_a", { updated: 2, closed: false, messages: [user("hello"), assistant(text("hi"))] })
        yield* sync()
        const patches = fake.requests.filter((entry) => entry.method === "PATCH")
        expect(patches).toHaveLength(2)
        expect((patches[1]!.body as { records: unknown[] }).records).toHaveLength(1)
        expect(fake.rows.size).toBe(2)
        expect(String(fake.rows.get("ses_a")!.fields.Transcript)).toContain("SigmaBot:\nhi")

        // Closing it sends the final state, marked Closed.
        fakeChats.state.set("ses_a", { updated: 3, closed: true, messages: [user("hello"), assistant(text("hi"))] })
        yield* sync()
        expect(fake.rows.get("ses_a")!.fields.Status).toBe("Closed")
        expect(fake.rows.get("ses_b")!.fields.Status).toBe("Open")
      }),
    ),
  )

  it.live("sends more than ten chats in several requests", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const fakeChats = chats()
        Array.from({ length: 23 }, (_, index) =>
          fakeChats.state.set(`ses_${index}`, { updated: 1, closed: false, messages: [user(`chat ${index}`)] }),
        )
        yield* SigmaBotTranscript.make({
          source: fakeChats.source,
          storage: memoryStorage(),
          remote: SigmaBotAirtable.transcripts(http, { token: "t", handle: "ada-lovelace", endpoint: fake.endpoint }),
        })()
        const sizes = fake.requests
          .filter((request) => request.method === "PATCH")
          .map((request) => (request.body as { records: unknown[] }).records.length)
        expect(sizes).toEqual([10, 10, 3])
        expect(fake.rows.size).toBe(23)
      }),
    ),
  )

  it.live("does not create rows for empty chats", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const fakeChats = chats()
        fakeChats.state.set("ses_empty", { updated: 1, closed: false, messages: [] })
        yield* SigmaBotTranscript.make({
          source: fakeChats.source,
          storage: memoryStorage(),
          remote: SigmaBotAirtable.transcripts(http, { token: "t", handle: "ada-lovelace", endpoint: fake.endpoint }),
        })()
        expect(fake.requests.filter((request) => request.method === "PATCH")).toEqual([])
      }),
    ),
  )

  it.live("tries a failed batch again on the next run", () =>
    use({ failWrites: true }, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const fakeChats = chats()
        fakeChats.state.set("ses_a", { updated: 1, closed: false, messages: [user("hello")] })
        const storage = memoryStorage()
        const failing = SigmaBotTranscript.make({
          source: fakeChats.source,
          storage,
          remote: SigmaBotAirtable.transcripts(http, { token: "t", handle: "ada-lovelace", endpoint: fake.endpoint }),
        })
        expect((yield* Effect.exit(failing()))._tag).toBe("Failure")
        expect(fake.rows.size).toBe(0)

        const working = use({}, (healthy) =>
          Effect.gen(function* () {
            yield* SigmaBotTranscript.make({
              source: fakeChats.source,
              storage,
              remote: SigmaBotAirtable.transcripts(http, {
                token: "t",
                handle: "ada-lovelace",
                endpoint: healthy.endpoint,
              }),
            })()
            expect([...healthy.rows.keys()]).toEqual(["ses_a"])
          }),
        )
        yield* working
      }),
    ),
  )

  it.live("still backs up when the handle has no Trainees row", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const fakeChats = chats()
        fakeChats.state.set("ses_a", { updated: 1, closed: false, messages: [user("hello")] })
        const noTrainee = Bun.serve({
          port: 0,
          async fetch(request) {
            if (request.method === "GET") return Response.json({ records: [] })
            return fetch(`${fake.endpoint}${new URL(request.url).pathname}`, {
              method: "PATCH",
              body: await request.text(),
            })
          },
        })
        yield* SigmaBotTranscript.make({
          source: fakeChats.source,
          storage: memoryStorage(),
          remote: SigmaBotAirtable.transcripts(http, {
            token: "t",
            handle: "unknown",
            endpoint: `http://127.0.0.1:${noTrainee.port}`,
          }),
        })().pipe(Effect.ensuring(Effect.sync(() => void noTrainee.stop(true))))
        expect(fake.rows.get("ses_a")!.fields).not.toHaveProperty("Trainee")
      }),
    ),
  )
})
