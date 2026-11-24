import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

test("virtualenv activate lines typed by the editor are never sent", async () => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true })
  await setup.renderer.setupTerminal()
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const prompt = Promise.withResolvers<string>()
  const events = createEventStream()
  // The draft stash is process-wide, so reruns use a fresh session for an empty composer.
  const sessionID = `ses_venv_activate_${crypto.randomUUID()}`
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const calls = createFetch(async (url, request) => {
    if (url.pathname === `/api/session/${sessionID}`)
      return json({
        data: {
          id: sessionID,
          projectID: "project",
          title: "Activate fixture",
          agent: "build",
          model: { providerID: "demo", id: "model" },
          location: { directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        },
      })
    if (url.pathname === `/api/session/${sessionID}/message`) return json({ data: [], cursor: {} })
    if (url.pathname === `/api/session/${sessionID}/inbox` || url.pathname === `/api/session/${sessionID}/permission`)
      return json({ data: [] })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
    if (url.pathname === `/api/session/${sessionID}/prompt`) {
      prompt.resolve(await request.text())
      return json({ data: {} })
    }
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => ({ animations: false }), update: async () => ({}) },
      packages: { prepare: async () => ({ directory: "" }) },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
      args: { sessionID },
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("Demo Model"))
    await setup.mockInput.typeText(' source "/Users/a b/.venv/bin/activate"')
    setup.mockInput.pressEnter({ shift: true })
    await setup.mockInput.typeText("first")
    await setup.waitForFrame((frame) => frame.includes("first"))
    await setup.mockInput.pasteBracketedText("\nsource /Users/x/.venv/bin/activate\nsecond\nthird\nfourth")
    await setup.waitForFrame((frame) => frame.includes("[Pasted ~"))
    setup.mockInput.pressEnter()
    const body = await prompt.promise
    expect(body).toContain(JSON.stringify("first\nsecond\nthird\nfourth"))
    expect(body).not.toContain("activate")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
