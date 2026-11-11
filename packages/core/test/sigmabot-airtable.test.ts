import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { SigmaBotAirtable } from "@opencode/core/plugin/sigmabot-airtable"
import { SigmaBotProgress } from "@opencode/core/plugin/sigmabot-progress"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { git, initGit } from "./fixture/git"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Talks to a real HTTP server on loopback and spawns git, so the live clock is used throughout.
const it = testEffect(Layer.mergeAll(FetchHttpClient.layer, LayerNode.compile(AppProcess.node)))

type Row = { id: string; fields: Record<string, unknown> }

/** A stand-in Airtable: the two tables the client touches, with 2-record pages so pagination is exercised. */
function airtable(options: { readonly failWrites?: boolean } = {}) {
  const requests: { method: string; path: string; auth: string | null; formula: string | null; body?: unknown }[] = []
  const submissions: Row[] = []
  const trainees: Row[] = [{ id: "recTrainee1", fields: { SigmaID: "Ada.Lovelace@sigmalabs.co.uk" } }]
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json() : undefined
      requests.push({
        method: request.method,
        path: url.pathname,
        auth: request.headers.get("authorization"),
        formula: url.searchParams.get("filterByFormula"),
        body,
      })
      const table = url.pathname.split("/").at(-1)
      if (request.method === "POST") {
        if (options.failWrites) return new Response("nope", { status: 500 })
        submissions.push({
          id: `rec${submissions.length}`,
          fields: (body as { fields: Record<string, unknown> }).fields,
        })
        return Response.json({ id: "recNew", fields: {} })
      }
      if (table === "tbl8470yTXwItb189") {
        const email = /="([^"]+)"/.exec(url.searchParams.get("filterByFormula") ?? "")?.[1]
        return Response.json({
          records: trainees.filter((row) => String(row.fields.SigmaID).toLowerCase() === email),
        })
      }
      const handle = /="([^"]+)"/.exec(url.searchParams.get("filterByFormula") ?? "")?.[1]
      const mine = submissions.filter((row) => String(row.fields["GitHub Handle"]).toLowerCase() === handle)
      const start = Number(url.searchParams.get("offset") ?? 0)
      const page = mine.slice(start, start + 2)
      return Response.json({
        // Airtable omits empty cells, including unticked checkboxes.
        records: page.map((row) => ({
          ...row,
          fields: Object.fromEntries(Object.entries(row.fields).filter(([, value]) => value !== false)),
        })),
        ...(start + 2 < mine.length ? { offset: String(start + 2) } : {}),
      })
    },
  })
  return { requests, submissions, endpoint: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
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
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...map.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

const signedIn = Effect.succeed<string | undefined>("ada.lovelace@sigmalabs.co.uk")

const submission = (challenge: string, passed: boolean): SigmaBotProgress.Submission => ({
  course: { id: "hm", version: "0.1.0" },
  challenge: { key: challenge, title: `Title of ${challenge}`, module: "shell-and-git" },
  functional: passed ? 1 : 0.5,
  nonFunctional: 0.92,
  quiz: 0.8,
  passed,
  summary: passed ? "Clean." : "Half the tests fail.",
})

describe("SigmaBotAirtable", () => {
  it.live("records an attempt with its trainee link and reads it back across pages", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const progress = SigmaBotProgress.make(
          memoryStorage(),
          SigmaBotAirtable.remote(http, {
            token: "pat123",
            handle: "ada-lovelace",
            email: signedIn,
            endpoint: fake.endpoint,
          }),
        )

        expect(yield* progress.record(submission("a/one", false))).toEqual({ attempt: 1, synced: true })
        expect(yield* progress.record(submission("a/one", true))).toEqual({ attempt: 2, synced: true })
        expect(yield* progress.record(submission("a/two", true))).toEqual({ attempt: 1, synced: true })

        const post = fake.requests.find((request) => request.method === "POST")!
        expect(post.path).toBe("/v0/app3kRCcq4MHcdSty/tblMn7uvZe1P0tZ95")
        expect(post.auth).toBe("Bearer pat123")
        expect(post.body).toEqual({
          fields: {
            Challenge: "a/one",
            "GitHub Handle": "ada-lovelace",
            Trainee: ["recTrainee1"],
            Course: "hm",
            "Course Version": "0.1.0",
            "Challenge Title": "Title of a/one",
            Module: "shell-and-git",
            "Submitted At": expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
            "Functional Score": 0.5,
            "Non-functional Score": 0.92,
            "Quiz Score": 0.8,
            Passed: false,
            Summary: "Half the tests fail.",
          },
        })

        // Three records come back as two pages, and an unticked Passed checkbox is absent from the first.
        const attempts = yield* progress.attempts("hm", "a/one")
        expect(attempts.map((attempt) => [attempt.passed, attempt.functional])).toEqual([
          [false, 0.5],
          [true, 1],
        ])
        expect(yield* progress.passed("hm")).toEqual(new Set(["a/one", "a/two"]))
        expect(yield* progress.passed("other-course")).toEqual(new Set())
      }),
    ),
  )

  it.live("still records an attempt when the email has no Trainees row", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const progress = SigmaBotProgress.make(
          memoryStorage(),
          SigmaBotAirtable.remote(http, {
            token: "t",
            handle: "someone-else",
            email: Effect.succeed("someone@sigmalabs.co.uk"),
            endpoint: fake.endpoint,
          }),
        )
        expect((yield* progress.record(submission("a", true))).synced).toBe(true)
        expect(fake.submissions[0]!.fields).not.toHaveProperty("Trainee")
        expect(fake.submissions[0]!.fields["GitHub Handle"]).toBe("someone-else")
      }),
    ),
  )

  it.live("records an attempt without a trainee link until the trainee has signed in", () =>
    use({}, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const progress = SigmaBotProgress.make(
          memoryStorage(),
          SigmaBotAirtable.remote(http, {
            token: "t",
            handle: "ada-lovelace",
            email: Effect.succeed(undefined),
            endpoint: fake.endpoint,
          }),
        )
        expect((yield* progress.record(submission("a", true))).synced).toBe(true)
        expect(fake.submissions[0]!.fields).not.toHaveProperty("Trainee")
        expect(fake.requests.some((request) => request.path.endsWith("tbl8470yTXwItb189"))).toBe(false)
      }),
    ),
  )

  it.live("falls back to the local copy when Airtable cannot be reached or rejects the write", () =>
    use({ failWrites: true }, (fake) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        const storage = memoryStorage()
        const down = SigmaBotProgress.make(
          storage,
          SigmaBotAirtable.remote(http, {
            token: "t",
            handle: "ada-lovelace",
            email: signedIn,
            endpoint: "http://127.0.0.1:1",
          }),
        )
        expect(yield* down.record(submission("a", true))).toEqual({ attempt: 1, synced: false })
        expect((yield* down.attempts("hm", "a")).length).toBe(1)
        expect(yield* down.passed("hm")).toEqual(new Set(["a"]))

        const rejected = SigmaBotProgress.make(
          memoryStorage(),
          SigmaBotAirtable.remote(http, {
            token: "t",
            handle: "ada-lovelace",
            email: signedIn,
            endpoint: fake.endpoint,
          }),
        )
        expect(yield* rejected.record(submission("a", false))).toEqual({ attempt: 1, synced: false })
        expect(fake.submissions).toEqual([])
      }),
    ),
  )

  it.effect("reads the owner out of every GitHub remote spelling", () =>
    Effect.sync(() => {
      for (const url of [
        "https://github.com/ada-lovelace/SelfPacedPreCourse.git",
        "https://github.com/ada-lovelace/SelfPacedPreCourse",
        "git@github.com:ada-lovelace/SelfPacedPreCourse.git",
        "ssh://git@github.com/ada-lovelace/SelfPacedPreCourse.git\\n",
        "https://user:token@github.com/ada-lovelace/SelfPacedPreCourse/",
      ])
        expect(SigmaBotAirtable.owner(url)).toBe("ada-lovelace")
      for (const url of ["", "/tmp/course", "https://gitlab.com/ada/course.git", 'https://github.com/a"b/c.git'])
        expect(SigmaBotAirtable.owner(url)).toBeUndefined()
    }),
  )

  it.live("takes the handle from the fork's origin remote", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        expect(yield* SigmaBotAirtable.handle(proc, tmp.path)).toBeUndefined()
        yield* Effect.promise(async () => {
          await initGit(tmp.path)
          await git(tmp.path, "remote", "add", "origin", "https://github.com/ada-lovelace/SelfPacedPreCourse.git")
        })
        expect(yield* SigmaBotAirtable.handle(proc, tmp.path)).toBe("ada-lovelace")
      }),
    ),
  )
})
