export * as SigmaBotSetup from "./sigmabot-setup.js"

import fs from "fs/promises"
import os from "os"
import path from "path"
import { Effect } from "effect"

// In order of preference: a dedicated setup guide beats install notes, which beat a getting-started page.
const NAMES = [/^setup$/i, /^install(ation)?$/i, /^getting[-_ ]?started$/i]
const EXTENSIONS = new Set(["", ".md", ".markdown", ".txt"])

export interface Guide {
  readonly path: string
  readonly text: string
}

/**
 * The setup guide closest to `directory`: a SETUP.md (or INSTALL.md, GETTING_STARTED.md, …) in it or a `docs`
 * folder beside it, then in each parent up to the repository root, the home folder or the filesystem root.
 */
export const find = Effect.fn("SigmaBotSetup.find")(function* (directory: string) {
  for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
    const file = (yield* match(dir)) ?? (yield* match(path.join(dir, "docs")))
    if (file) {
      const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
      if (text !== undefined) return { path: file, text } satisfies Guide
    }
    if (yield* boundary(dir)) return undefined
  }
})

/** The setup section of the /setup prompt: where the guide is and what it says, or that there is none. */
export function describe(guide: Guide | undefined, directory: string) {
  if (!guide)
    return `No setup guide was found in ${directory}, its docs folder or any folder above it up to the repository root.`
  return [`Setup guide: ${guide.path}`, "", "````markdown", guide.text.trim(), "````"].join("\n")
}

const match = Effect.fn("SigmaBotSetup.match")(function* (dir: string) {
  const entries = yield* Effect.promise(() => fs.readdir(dir, { withFileTypes: true }).catch(() => []))
  const files = entries
    .filter((entry) => entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort()
  const name = NAMES.flatMap((pattern) =>
    files.filter((file) => pattern.test(path.basename(file, path.extname(file)))),
  )[0]
  return name === undefined ? undefined : path.join(dir, name)
})

const boundary = Effect.fn("SigmaBotSetup.boundary")(function* (dir: string) {
  if (path.dirname(dir) === dir || dir === os.homedir()) return true
  return yield* Effect.promise(() =>
    fs.stat(path.join(dir, ".git")).then(
      () => true,
      () => false,
    ),
  )
})
