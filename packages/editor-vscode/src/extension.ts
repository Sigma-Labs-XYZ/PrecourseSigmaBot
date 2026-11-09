import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import type { AddressInfo } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"
import { TabInputText, window, workspace, type ExtensionContext, type Position, type TextEditor } from "vscode"
import { WebSocketServer, type RawData, type WebSocket } from "ws"
import { registerLauncher } from "./launcher"

// The TUI discovers editors through ~/.claude/ide/<port>.lock and authenticates with this header.
const AUTH_HEADER = "x-claude-code-ide-authorization"
const MCP_PROTOCOL_VERSION = "2025-11-25"
const MAX_OPEN_FILES = 50

export function activate(context: ExtensionContext) {
  registerLauncher(context)
  const authToken = randomUUID()
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
  const lockDirectory = join(homedir(), ".claude", "ide")
  let lockFile: string | undefined
  let editor: TextEditor | undefined = fileEditor(window.activeTextEditor)
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = () => (editor ? selectionChanged(editor) : undefined)

  const writeLock = () => {
    if (!lockFile) return
    writeFileSync(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        ideName: "VS Code",
        transport: "ws",
        authToken,
        workspaceFolders: workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
      }),
      { mode: 0o600 },
    )
  }

  const broadcast = () => {
    timer = undefined
    const params = snapshot()
    if (params) server.clients.forEach((client) => notify(client, params))
  }

  // Selection changes fire on every cursor movement, so coalesce them.
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(broadcast, 75)
  }

  server.on("connection", (socket, request) => {
    // Browsers always send Origin, so refusing it keeps web pages from reading editor state over localhost.
    if (request.headers.origin || request.headers[AUTH_HEADER] !== authToken) return socket.close(1008)
    socket.on("message", (data) => {
      const message = parse(data)
      if (message?.method !== "initialize") return
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo: { name: "sigmabot-vscode", version: "0.1.0" } },
        }),
      )
      const params = snapshot()
      if (params) notify(socket, params)
    })
  })

  server.on("listening", () => {
    mkdirSync(lockDirectory, { recursive: true, mode: 0o700 })
    lockFile = join(lockDirectory, `${(server.address() as AddressInfo).port}.lock`)
    writeLock()
  })

  context.subscriptions.push(
    window.onDidChangeActiveTextEditor((next) => {
      const file = fileEditor(next)
      if (!file) return
      editor = file
      schedule()
    }),
    window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== editor) return
      schedule()
    }),
    window.tabGroups.onDidChangeTabs(schedule),
    workspace.onDidChangeWorkspaceFolders(writeLock),
    {
      dispose() {
        clearTimeout(timer)
        if (lockFile) rmSync(lockFile, { force: true })
        server.close()
      },
    },
  )
}

export function deactivate() {}

function fileEditor(editor: TextEditor | undefined) {
  return editor?.document.uri.scheme === "file" ? editor : undefined
}

function selectionChanged(editor: TextEditor) {
  const document = editor.document
  return {
    filePath: document.uri.fsPath,
    ranges: editor.selections.map((selection) => ({
      text: document.getText(selection),
      selection: { start: position(selection.start), end: position(selection.end) },
    })),
    openFiles: openFiles(),
  }
}

// The TUI counts lines and characters from 1.
function position(value: Position) {
  return { line: value.line + 1, character: value.character + 1 }
}

function openFiles() {
  const files = window.tabGroups.all
    .flatMap((group) => group.tabs)
    .flatMap((tab) =>
      tab.input instanceof TabInputText && tab.input.uri.scheme === "file" ? [tab.input.uri.fsPath] : [],
    )
  return [...new Set(files)].slice(0, MAX_OPEN_FILES)
}

function notify(socket: WebSocket, params: unknown) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify({ jsonrpc: "2.0", method: "selection_changed", params }))
}

function parse(data: RawData): { id?: number | string; method?: string } | undefined {
  try {
    return JSON.parse(data.toString())
  } catch {
    return undefined
  }
}
