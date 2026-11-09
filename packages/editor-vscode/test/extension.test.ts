import { afterAll, expect, mock, test } from "bun:test"
import { mkdtemp, readdir, readFile } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

class TabInputText {
  constructor(readonly uri: { scheme: string; fsPath: string }) {}
}

const file = (fsPath: string) => ({ scheme: "file", fsPath })
const tab = (fsPath: string) => ({ input: new TabInputText(file(fsPath)) })
const never = () => ({ dispose() {} })
const views = new Map<string, { resolveWebviewView(view: unknown): void }>()

mock.module("vscode", () => ({
  TabInputText,
  ViewColumn: { Beside: -2 },
  StatusBarAlignment: { Left: 1 },
  Uri: { joinPath: (base: { path: string }, ...segments: string[]) => ({ path: [base.path, ...segments].join("/") }) },
  commands: { registerCommand: never },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: (id: string, provider: { resolveWebviewView(view: unknown): void }) => {
      views.set(id, provider)
      return never()
    },
    activeTextEditor: {
      document: { uri: file("/repo/a.ts"), getText: () => "hello" },
      selections: [{ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }],
    },
    onDidChangeActiveTextEditor: never,
    onDidChangeTextEditorSelection: never,
    tabGroups: {
      onDidChangeTabs: never,
      all: [{ tabs: [tab("/repo/a.ts"), tab("/repo/b.ts")] }, { tabs: [tab("/repo/a.ts"), { input: {} }] }],
    },
  },
  workspace: { workspaceFolders: [{ uri: file("/repo") }], onDidChangeWorkspaceFolders: never },
}))

const home = await mkdtemp(join(os.tmpdir(), "sigmabot-editor-"))
// Bun reads the home directory once at startup, so changing HOME does not move it.
mock.module("node:os", () => ({ ...os, default: { ...os, homedir: () => home }, homedir: () => home }))

const { activate } = await import("../src/extension")
const subscriptions: Array<{ dispose(): void }> = []
activate({ subscriptions, extensionUri: { path: "/extension" } } as never)

afterAll(() => subscriptions.forEach((item) => item.dispose()))

const lockDirectory = join(home, ".claude", "ide")

async function lock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const entry = (await readdir(lockDirectory).catch(() => [])).find((name) => name.endsWith(".lock"))
    if (entry)
      return { port: Number.parseInt(entry, 10), ...JSON.parse(await readFile(join(lockDirectory, entry), "utf8")) }
    await Bun.sleep(20)
  }
  throw new Error("The extension never wrote its lock file")
}

function connect(port: number, headers: Record<string, string>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers })
  const messages: unknown[] = []
  socket.on("message", (data) => messages.push(JSON.parse(data.toString())))
  const closed = new Promise<number>((resolve) => socket.on("close", resolve))
  return { socket, messages, closed }
}

test("advertises itself through a lock file in the workspace", async () => {
  expect(await lock()).toMatchObject({ transport: "ws", workspaceFolders: ["/repo"], pid: process.pid })
})

test("replies to initialize and shares the selection with the open files", async () => {
  const info = await lock()
  const client = connect(info.port, { "x-claude-code-ide-authorization": info.authToken })
  await new Promise((resolve) => client.socket.on("open", resolve))
  client.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }))
  while (client.messages.length < 2) await Bun.sleep(10)
  client.socket.close()

  expect(client.messages[0]).toMatchObject({ id: 1, result: { serverInfo: { name: "sigmabot-vscode" } } })
  expect(client.messages[1]).toEqual({
    jsonrpc: "2.0",
    method: "selection_changed",
    params: {
      filePath: "/repo/a.ts",
      ranges: [{ text: "hello", selection: { start: { line: 3, character: 1 }, end: { line: 3, character: 6 } } }],
      openFiles: ["/repo/a.ts", "/repo/b.ts"],
    },
  })
})

test("refuses clients without the token", async () => {
  const info = await lock()
  expect(await connect(info.port, { "x-claude-code-ide-authorization": "wrong" }).closed).toBe(1008)
})

test("refuses browser clients even with the token", async () => {
  const info = await lock()
  const client = connect(info.port, {
    "x-claude-code-ide-authorization": info.authToken,
    Origin: "https://example.com",
  })
  expect(await client.closed).toBe(1008)
})

test("the welcome view shows the logo and can only run the launcher commands", () => {
  const webview = welcome()
  expect(webview.options).toEqual({
    enableCommandUris: ["sigmabot.install", "sigmabot.open"],
    localResourceRoots: [{ path: "/extension/media" }],
  })
  expect(webview.html).toContain('src="vscode-webview:/extension/media/sigma-labs-logo.png"')
  expect(webview.html).toContain('href="command:sigmabot.install"')
  expect(webview.html).toContain('href="command:sigmabot.open"')
  expect(webview.html).not.toContain("<script")
})

test("the welcome view lists the agents in the order Shift+Tab cycles through them", () => {
  const html = welcome().html
  expect(html).toMatch(/<strong>Tutor<\/strong>[\s\S]*<strong>Reviewer<\/strong>[\s\S]*<strong>IT Support<\/strong>/)
  expect(html).not.toContain("Planner")
  expect(html).toContain("<kbd>Shift</kbd> + <kbd>Tab</kbd>")
})

function welcome() {
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview:",
    asWebviewUri: (uri: { path: string }) => `vscode-webview:${uri.path}`,
  }
  views.get("sigmabot.welcome")?.resolveWebviewView({ webview })
  return webview
}
