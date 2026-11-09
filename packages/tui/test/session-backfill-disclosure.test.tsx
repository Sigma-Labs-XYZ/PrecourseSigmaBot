import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import type { SessionMessageInfo } from "@opencode/client"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// Regression: thoughts mounted by tail-first backfill (older rows revealed
// after scrolling to the top) must stay hidden when thinking is hidden.
test("backfilled thoughts stay hidden", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 112, height: 34, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const session = {
    id: "ses_backfill",
    title: "Backfill",
    projectID: "proj_test",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const model = { providerID: "fixture", id: "fixture" }
  const messages: SessionMessageInfo[] = Array.from({ length: 14 }, (_, i) => [
    {
      type: "user" as const,
      id: `user-${i}`,
      text: `Turn ${String(i).padStart(2, "0")} prompt`,
      time: { created: i * 10 },
    },
    {
      type: "assistant" as const,
      id: `a-${i}`,
      agent: "build",
      model,
      finish: "stop" as const,
      time: { created: i * 10 + 1, completed: i * 10 + 3 },
      content: [
        {
          type: "reasoning" as const,
          text: `**Turn ${i}**\n\nA fixed thought.`,
          time: { created: i * 10 + 1, completed: i * 10 + 2 },
        },
        { type: "text" as const, text: `Turn ${String(i).padStart(2, "0")} answer` },
      ],
    },
  ]).flat()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox` || url.pathname === `/api/session/${session.id}/permission`)
      return json({ data: [] })
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false, tabs: { enabled: false } }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Turn 13 answer"))
    setup.mockInput.pressKey("g", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Turn 00 prompt"))
    await setup.waitForVisualIdle({ quietFrames: 3 })
    const frame = setup.captureCharFrame()
    expect(frame).toContain("Turn 00 answer")
    expect(frame).not.toContain("Thought")
    expect(frame).not.toContain("A fixed thought.")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}, 20000)
