export * as InstructionMemories from "./memories.js"

import path from "path"
import { Effect, Schema } from "effect"
import type { FSUtil } from "@opencode/util/fs-util"
import { Instructions } from "./index.js"

/** Where the coach keeps notes about the learner, relative to the project root. It is committed with the project. */
export const FILE = ".coach/MEMORIES.md"
export const MAX_BYTES = 8_000

const HEADER =
  [
    "# Learner memories",
    "",
    "Notes the coach keeps about this learner so it can teach them better. You can read and edit this file.",
    "",
  ].join("\n") + "\n"

export const filepath = (root: string) => path.join(root, FILE)

export function add(content: string, memory: string, date: string) {
  const entry = single(memory)
  if (entry === "") return { type: "empty" as const }
  if (
    entries(content).some((line) => line.replace(/^- (\d{4}-\d{2}-\d{2}: )?/, "").toLowerCase() === entry.toLowerCase())
  )
    return { type: "duplicate" as const }
  const next = `${content.trim() === "" ? HEADER : content.trimEnd() + "\n"}- ${date}: ${entry}\n`
  if (Buffer.byteLength(next) > MAX_BYTES) return { type: "full" as const }
  return { type: "added" as const, content: next }
}

export function forget(content: string, memory: string) {
  const needle = single(memory).toLowerCase()
  if (needle === "") return { type: "empty" as const }
  const matches = entries(content).filter((line) => line.toLowerCase().includes(needle))
  if (matches.length === 0) return { type: "missing" as const }
  if (matches.length > 1) return { type: "ambiguous" as const, matches }
  const [match] = matches
  return {
    type: "removed" as const,
    removed: match!,
    content: content
      .split("\n")
      .filter((line) => line !== match)
      .join("\n"),
  }
}

/**
 * The file as an instruction source. Its contents are put in front of the model once, when a session starts.
 * Later changes, such as the model's own saves, update the baseline without adding a message: the tool results
 * already show what was saved, and the next session loads the new contents.
 */
export function source(fs: FSUtil.Interface, root: string) {
  const file = filepath(root)
  const [memories] = Instructions.make({
    key: Instructions.Key.make("core/memories"),
    codec: Schema.toCodecJson(Schema.String),
    read: fs.readFileStringSafe(file).pipe(
      Effect.map((content) => content ?? ""),
      Effect.orElseSucceed(() => Instructions.unavailable),
    ),
    render: {
      initial: (content) => [guidance, "", render(content)].join("\n"),
      // Required by `make`, but replaced below so changes never render a message.
      changed: () => "unused",
    },
  })
  return [{ ...memories!, changed: () => undefined }]
}

const guidance = [
  `You keep long-term notes about the learner in ${FILE}. It lives in the project and is committed with it, so the learner can read and edit it.`,
  "Decide for yourself when to write to it: call memory_save when you learn something durable and useful about the learner, such as their goals, background, strengths, recurring struggles, how they prefer to learn, or a misconception you corrected.",
  "Keep each memory to one short sentence. Do not save secrets, credentials, sensitive personal details, passing remarks, or anything already noted. Call memory_forget to remove entries that are wrong or outdated. Use the tools rather than editing the file.",
].join("\n")

function render(content: string) {
  return content.trim() === ""
    ? "No memories saved yet."
    : `Current contents of ${FILE}:\n<memories>\n${content.trim()}\n</memories>`
}

const entries = (content: string) => content.split("\n").filter((line) => line.startsWith("- "))

const single = (text: string) => text.replace(/\s+/g, " ").trim()
