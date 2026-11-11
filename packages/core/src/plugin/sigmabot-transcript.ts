export * as SigmaBotTranscript from "./sigmabot-transcript.js"

import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { DateTime, Effect } from "effect"

/** One chat as the backup table holds it. */
export interface Row {
  readonly sessionID: string
  readonly transcript: string
  readonly closed: boolean
  readonly syncedAt: string
}

export interface Remote {
  /** Creates the row for each chat, or updates it when an earlier sync already made one. */
  readonly upsert: (rows: readonly Row[]) => Effect.Effect<void, Error>
}

/** What the backup needs to know about the chats in this project, oldest and newest alike. */
export interface Source {
  /** Every top-level chat, open or closed. */
  readonly chats: Effect.Effect<
    readonly { readonly id: Session.ID; readonly updated: number; readonly closed: boolean }[]
  >
  readonly messages: (id: Session.ID) => Effect.Effect<readonly SessionMessage.Info[]>
}

// Airtable stops a long-text cell at 100,000 characters; the margin covers characters that count as two.
export const MAX_LENGTH = 99_000
const TRUNCATED = "[Earlier part of this chat was cut to fit Airtable.]"
const MAX_TOOL_INPUT = 500
const MAX_TOOL_OUTPUT = 2_000

/** The chat as readable text. When it is too long for Airtable, the oldest part is dropped and a note says so. */
export function render(messages: readonly SessionMessage.Info[]) {
  const text = messages.flatMap(entry).join("\n\n")
  if (text.length <= MAX_LENGTH) return text
  const tail = text.slice(-(MAX_LENGTH - TRUNCATED.length - 2))
  // Start on a line boundary rather than in the middle of a sentence.
  return `${TRUNCATED}\n\n${tail.slice(tail.indexOf("\n") + 1)}`
}

function entry(message: SessionMessage.Info): string[] {
  const at = DateTime.formatIso(message.time.created)
  if (message.type === "user") return [`[${at}] You:\n${message.text}`]
  // A synthetic message is a long instruction for the model; its description is the line the trainee saw.
  if (message.type === "synthetic") return message.description ? [`[${at}] You: ${message.description}`] : []
  if (message.type === "shell")
    return [`[${at}] $ ${message.command}${message.output ? `\n${clip(message.output.output, MAX_TOOL_OUTPUT)}` : ""}`]
  if (message.type === "compaction") return message.status === "completed" ? [`[${at}] (conversation compacted)`] : []
  if (message.type !== "assistant") return []
  const parts = message.content.flatMap((part) => {
    if (part.type === "text") return part.text.trim() ? [part.text] : []
    if (part.type !== "tool") return []
    const state = part.state
    const input = clip(JSON.stringify(state.input), MAX_TOOL_INPUT)
    const output =
      state.status === "completed"
        ? clip(
            state.content
              .map((item) => (item.type === "text" ? item.text : `(file ${item.name ?? item.uri})`))
              .join("\n"),
            MAX_TOOL_OUTPUT,
          )
        : state.status === "error"
          ? `Error: ${state.error.message}`
          : ""
    return [`[tool ${part.name}] ${input}${output ? `\n${output}` : ""}`]
  })
  return parts.length === 0 ? [] : [`[${at}] SigmaBot:\n${parts.join("\n")}`]
}

function clip(text: string, max: number) {
  return text.length <= max ? text : `${text.slice(0, max)}… (${text.length - max} more characters)`
}

/**
 * Backs up every chat that changed since its last backup, in one batch. A chat is remembered as backed up only after
 * Airtable accepted it, so a failed batch is simply tried again on the next run. Closing a chat changes it, so its final
 * transcript is picked up by the next run.
 */
export function make(input: { readonly source: Source; readonly storage: StorageDomain; readonly remote: Remote }) {
  const marker = (chat: { readonly updated: number; readonly closed: boolean }) =>
    `${chat.updated}:${chat.closed ? "closed" : "open"}`
  const key = (id: string) => `transcript:${id}`

  return Effect.fn("SigmaBotTranscript.sync")(function* () {
    const chats = yield* input.source.chats
    const changed = (yield* Effect.forEach(chats, (chat) =>
      input.storage.get(key(chat.id)).pipe(Effect.map((seen) => (seen === marker(chat) ? [] : [chat]))),
    )).flat()
    const syncedAt = DateTime.formatIso(yield* DateTime.now)
    const rows = (yield* Effect.forEach(changed, (chat) =>
      input.source.messages(chat.id).pipe(Effect.map((messages) => ({ chat, transcript: render(messages) }))),
    )).filter((row) => row.transcript !== "")
    yield* input.remote.upsert(
      rows.map((row) => ({ sessionID: row.chat.id, transcript: row.transcript, closed: row.chat.closed, syncedAt })),
    )
    yield* Effect.forEach(changed, (chat) => input.storage.set(key(chat.id), marker(chat)), { discard: true })
  })
}
