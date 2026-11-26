export * as InstructionMemories from "./memories.js"

import path from "path"
import { Effect, Schema } from "effect"
import type { FSUtil } from "@opencode/util/fs-util"
import { Instructions } from "./index.js"

/** Where the coach keeps notes about the learner, relative to the project root. It is committed with the project. */
export const FILE = ".coach/MEMORIES.md"
export const MAX_BYTES = 32_000

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
 * already show what was saved, and the next session loads the new contents. Only the file disappearing is
 * reported, so the model knows its earlier notes are gone and saves them again.
 */
export function source(fs: FSUtil.Interface, root: string): Instructions.List {
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
      // Required by `make`, but replaced below so only a cleared file renders a message.
      changed: () => "unused",
    },
  })
  return [
    {
      ...memories!,
      changed: (_previous, current) => (typeof current === "string" && current.trim() === "" ? cleared : undefined),
    },
  ]
}

const cleared = `${FILE} was deleted or emptied, so the earlier notes no longer exist. Treat anything you remembered about the learner as unsaved and call memory_save again when it is still worth keeping.`

const guidance = [
  `You keep long-term notes about the learner in ${FILE}. It lives in the project and is committed with it, so the learner can read and edit it.`,
  "Save what a good teacher would want to remember. Before calling memory_save, ask whether a teacher who sees this learner every week would want to remember it next time. If yes, save it in the same turn without asking permission; if no, do not. Most messages will not produce a note: routine back-and-forth, small slips the learner fixes themselves and questions with no wider meaning are not worth saving. Things that usually pass the test:",
  "- Who they are: background, prior experience, goals or motivation, when they first tell you.",
  "- Real struggles: a misconception you corrected, something they got stuck on or needed several hints for, and what made it click.",
  "- Real successes: finishing a challenge, overcoming an earlier struggle, or clear understanding of something hard.",
  "- Revealing questions: a question that shows a gap or misunderstanding, not every question they ask.",
  "- How they learn: an explanation, analogy or style of help that clearly worked or clearly did not.",
  "- Patterns: the same struggle or habit coming up again.",
  "- Where they stopped: the challenge and step they were on when a session ends partway through.",
  "Make each note specific and self-contained: name the challenge, command or concept involved, for example 'Mixed up git add and git commit in 02-git/01-first-commit; fixed after one hint.'",
  "Read these notes before you start teaching, pitch your help from them, revisit earlier struggles and acknowledge progress.",
  "Keep each memory to one sentence. Do not save secrets, credentials or sensitive personal details such as health, religion, politics, sexuality or finances. When a note becomes wrong or outdated, call memory_forget on it and save the updated version. Use the tools rather than editing the file.",
].join("\n")

function render(content: string) {
  return content.trim() === ""
    ? "No memories saved yet."
    : `Current contents of ${FILE}:\n<memories>\n${content.trim()}\n</memories>`
}

const entries = (content: string) => content.split("\n").filter((line) => line.startsWith("- "))

const single = (text: string) => text.replace(/\s+/g, " ").trim()
