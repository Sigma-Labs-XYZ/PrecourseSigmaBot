import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { SigmaBotCourse } from "@opencode/core/plugin/sigmabot-course"
import { git, initGit } from "./fixture/git"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// locate drives a real git process, so the live clock is used throughout.
const it = testEffect(LayerNode.compile(AppProcess.node))

const json = (value: unknown) => JSON.stringify(value, null, 2)

async function manifest(dir: string, value: unknown) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "manifest.json"), json(value))
}

/**
 * A course with the shapes the content repository uses: a module with a chapter of two shell challenges, a
 * Python module with one tested challenge that requires the first, and a planned SQL module with no folder yet.
 */
async function course(root: string) {
  await manifest(root, {
    manifestVersion: 1,
    id: "test-course",
    type: "course",
    title: "Test course",
    version: "0.1.0",
    gates: { functional: 0.9, nonFunctional: 0.9, quiz: null },
    children: [
      { id: "shell-and-git", path: "01-shell-and-git", status: "built", requires: [] },
      { id: "python", path: "02-python", status: "building", requires: ["shell-and-git"] },
      { id: "sql", path: "03-sql", status: "planned", requires: ["shell-and-git"] },
    ],
  })
  await manifest(path.join(root, "01-shell-and-git"), {
    manifestVersion: 1,
    id: "shell-and-git",
    type: "module",
    title: "Shell and Git",
    stream: "core",
    children: [{ id: "getting-around", path: "01-getting-around" }],
  })
  await manifest(path.join(root, "01-shell-and-git/01-getting-around"), {
    manifestVersion: 1,
    id: "getting-around",
    type: "chapter",
    title: "Getting around",
    children: [
      { id: "where-am-i", path: "01-where-am-i" },
      { id: "reading-the-files", path: "02-reading-the-files" },
    ],
  })
  await manifest(path.join(root, "01-shell-and-git/01-getting-around/01-where-am-i"), {
    manifestVersion: 1,
    id: "where-am-i",
    type: "challenge",
    title: "Where am I?",
    summary: "Walk round the ops folder.",
    run: null,
    test: null,
    rubric: { path: "rubric.md", encrypted: false },
    quiz: { guidance: "quiz-guidance.md" },
    tasks: [
      {
        id: "1.0",
        title: "Morning walk-round",
        script: "1.0-morning-walk-round.sh",
        run: { command: "bash 1.0-morning-walk-round.sh" },
      },
    ],
  })
  await fs.writeFile(
    path.join(root, "01-shell-and-git/01-getting-around/01-where-am-i/1.0-morning-walk-round.sh"),
    "pwd\n",
  )
  await manifest(path.join(root, "01-shell-and-git/01-getting-around/02-reading-the-files"), {
    manifestVersion: 1,
    id: "reading-the-files",
    type: "challenge",
    title: "Reading the files",
    sandbox: "~/hm-sandbox/reading",
    tasks: [
      { id: "1.0", title: "The handover", script: "1.0-the-handover.sh", setup: { command: "bash setup.sh 1.0" } },
    ],
  })
  await manifest(path.join(root, "02-python"), {
    manifestVersion: 1,
    id: "python",
    type: "module",
    title: "Python",
    stream: "python",
    children: [{ id: "the-till-line", path: "01-the-till-line" }],
  })
  await manifest(path.join(root, "02-python/01-the-till-line"), {
    manifestVersion: 1,
    id: "the-till-line",
    type: "challenge",
    title: "The till line",
    test: { command: "pytest tests" },
    rubric: { path: "rubric.md.enc", encrypted: true },
    tasks: [
      { id: "1.0", title: "Price a till line", script: "1.0-price.py", test: { command: "pytest tests -k test_1_0" } },
    ],
  })
  await fs.writeFile(path.join(root, "02-python/01-the-till-line/1.0-price.py"), "# todo\n")
}

const keys = [
  "01-shell-and-git/01-getting-around/01-where-am-i",
  "01-shell-and-git/01-getting-around/02-reading-the-files",
  "02-python/01-the-till-line",
]

const load = (directory: string) => SigmaBotCourse.load(directory)

describe("SigmaBotCourse", () => {
  it.live("loads every challenge in course order from any folder inside the fork", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => course(tmp.path))
        const loaded = yield* load(path.join(tmp.path, "01-shell-and-git/01-getting-around"))
        if (!loaded) throw new Error("expected a course")
        expect(loaded.id).toBe("test-course")
        expect(loaded.directory).toBe(tmp.path)
        expect(loaded.gates).toEqual({ functional: 0.9, nonFunctional: 0.9, quiz: null })
        expect(loaded.modules.map((module) => module.id)).toEqual(["shell-and-git", "python"])
        expect(loaded.challenges.map((challenge) => challenge.key)).toEqual(keys)
        const first = loaded.challenges[0]!
        expect(first).toMatchObject({
          id: "where-am-i",
          title: "Where am I?",
          module: { id: "shell-and-git", stream: "core", requires: [] },
          chapter: { id: "getting-around", title: "Getting around" },
          rubric: { path: path.join(tmp.path, keys[0]!, "rubric.md"), encrypted: false },
          quiz: path.join(tmp.path, keys[0]!, "quiz-guidance.md"),
          tasks: [
            {
              id: "1.0",
              title: "Morning walk-round",
              script: "1.0-morning-walk-round.sh",
              run: "bash 1.0-morning-walk-round.sh",
            },
          ],
        })
        expect(first.test).toBeUndefined()
        expect(loaded.challenges[1]!.sandbox).toBe("~/hm-sandbox/reading")
        expect(loaded.challenges[1]!.tasks[0]!.setup).toBe("bash setup.sh 1.0")
        expect(loaded.challenges[2]).toMatchObject({
          test: "pytest tests",
          module: { id: "python", requires: ["shell-and-git"] },
          rubric: { encrypted: true },
        })
        expect(loaded.challenges[2]!.chapter).toBeUndefined()
      }),
    ),
  )

  it.live("returns nothing outside a course and fails on a manifest it cannot read", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        expect(yield* load(tmp.path)).toBeUndefined()
        yield* Effect.promise(() => course(tmp.path))
        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "02-python/manifest.json"), "{ not json"))
        const error = yield* load(tmp.path).pipe(Effect.flip)
        expect(error._tag).toBe("SigmaBotCourse.ManifestError")
        expect(error.path).toBe(path.join(tmp.path, "02-python/manifest.json"))
      }),
    ),
  )

  it.live("finds challenges by key or unique id", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => course(tmp.path))
        const loaded = (yield* load(tmp.path))!
        expect(SigmaBotCourse.find(loaded, keys[2]!)?.id).toBe("the-till-line")
        expect(SigmaBotCourse.find(loaded, `./${keys[2]}/`)?.id).toBe("the-till-line")
        expect(SigmaBotCourse.find(loaded, "where-am-i")?.key).toBe(keys[0])
        expect(SigmaBotCourse.find(loaded, "nowhere")).toBeUndefined()
      }),
    ),
  )

  it.live("locks challenges until the one before and the required modules are passed", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => course(tmp.path))
        const loaded = (yield* load(tmp.path))!
        const states = (passed: string[]) =>
          SigmaBotCourse.status(loaded, new Set(passed)).map((status) => [status.state, status.reason])

        expect(states([])).toEqual([
          ["open", undefined],
          ["locked", `"Where am I?" (${keys[0]}) must be passed first`],
          ["locked", "the Shell and Git module must be complete first"],
        ])
        expect(states([keys[0]!])).toEqual([
          ["passed", undefined],
          ["open", undefined],
          ["locked", "the Shell and Git module must be complete first"],
        ])
        expect(states([keys[0]!, keys[1]!])).toEqual([
          ["passed", undefined],
          ["passed", undefined],
          ["open", undefined],
        ])
      }),
    ),
  )

  it.live("guesses the named challenge, else the furthest changed one, else the next unpassed", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        yield* Effect.promise(() => course(tmp.path))
        yield* Effect.promise(async () => {
          await initGit(tmp.path, "-b", "main")
          await git(tmp.path, "add", ".")
          await git(tmp.path, "commit", "-m", "course")
        })
        const loaded = (yield* load(tmp.path))!
        const locate = (argument: string, passed: string[] = []) =>
          SigmaBotCourse.locate(proc, loaded, { argument, passed: new Set(passed) })

        const clean = yield* locate("")
        expect(clean.changed).toEqual([])
        expect(clean).toMatchObject({ reason: "next", guess: { key: keys[0] } })
        expect(yield* locate("", [keys[0]!])).toMatchObject({ reason: "next", guess: { key: keys[1] } })
        const done = yield* locate("", keys)
        expect(done.reason).toBe("none")
        expect(done.guess).toBeUndefined()

        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(tmp.path, keys[0]!, "1.0-morning-walk-round.sh"), "pwd\nls\n")
          await fs.writeFile(path.join(tmp.path, keys[2]!, "notes.txt"), "untracked\n")
        })
        const changed = yield* locate("")
        expect(changed.changed.map((challenge) => challenge.key)).toEqual([keys[0], keys[2]])
        expect(changed).toMatchObject({ reason: "changed", guess: { key: keys[2] } })

        expect(yield* locate("the till line please")).toMatchObject({ reason: "named", guess: { key: keys[2] } })
        expect(yield* locate("reading-the-files")).toMatchObject({ reason: "named", guess: { key: keys[1] } })

        const text = SigmaBotCourse.describe(loaded, SigmaBotCourse.status(loaded, new Set()), changed)
        expect(text).toContain(`Best guess: ${keys[2]} — "The till line"`)
        expect(text).toContain("quiz not set in the manifest")
        expect(text).toContain(`- ${keys[1]} — "Reading the files" (Shell and Git › Getting around) [locked:`)
      }),
    ),
  )
})
