export * as SigmaBotCourse from "./sigmabot-course.js"

import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { ChildProcess } from "effect/process"
import type { CourseMap } from "@opencode/schema/course-map"
import type { AppProcess } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"

const Command = Schema.NullOr(Schema.Struct({ command: Schema.String }))

const Task = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  brief: Schema.optionalKey(Schema.String),
  script: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Command),
  test: Schema.optionalKey(Command),
  setup: Schema.optionalKey(Command),
})

/** One `manifest.json`, as the course content repository writes it at every level. */
export const Manifest = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["course", "module", "chapter", "challenge"]),
  title: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(Schema.String),
  stream: Schema.optionalKey(Schema.String),
  gates: Schema.optionalKey(
    Schema.Struct({
      functional: Schema.Number,
      nonFunctional: Schema.Number,
      quiz: Schema.NullOr(Schema.Number),
    }),
  ),
  sandbox: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Command),
  test: Schema.optionalKey(Command),
  rubric: Schema.optionalKey(Schema.NullOr(Schema.Struct({ path: Schema.String, encrypted: Schema.Boolean }))),
  quiz: Schema.optionalKey(Schema.NullOr(Schema.Struct({ guidance: Schema.String }))),
  tasks: Schema.optionalKey(Schema.Array(Task)),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        path: Schema.String,
        status: Schema.optionalKey(Schema.String),
        requires: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
})
export type Manifest = typeof Manifest.Type

export class ManifestError extends Schema.TaggedError<ManifestError>()("SigmaBotCourse.ManifestError", {
  path: Schema.String,
  message: Schema.String,
}) {}

export interface Task {
  readonly id: string
  readonly title: string
  readonly script?: string
  readonly run?: string
  readonly test?: string
  readonly setup?: string
}

export interface Module {
  readonly id: string
  readonly title: string
  readonly stream?: string
  readonly requires: readonly string[]
}

export interface Challenge {
  /** Directory of the challenge relative to the course root, with `/` separators. Unique within the course. */
  readonly key: string
  readonly id: string
  readonly title: string
  readonly summary?: string
  readonly directory: string
  readonly module: Module
  readonly chapter?: { readonly id: string; readonly title: string }
  readonly sandbox?: string
  readonly run?: string
  readonly test?: string
  readonly rubric?: { readonly path: string; readonly encrypted: boolean }
  readonly quiz?: string
  readonly tasks: readonly Task[]
}

export interface Course {
  readonly id: string
  readonly title: string
  readonly version?: string
  readonly directory: string
  readonly gates: { readonly functional: number; readonly nonFunctional: number; readonly quiz: number | null }
  readonly modules: readonly Module[]
  readonly challenges: readonly Challenge[]
}

export interface Status {
  readonly challenge: Challenge
  readonly state: "passed" | "open" | "locked"
  /** Why the challenge is locked. */
  readonly reason?: string
}

export interface Located {
  readonly guess?: Challenge
  readonly reason: "named" | "changed" | "next" | "none"
  /** Challenges whose folders hold uncommitted changes, in course order. */
  readonly changed: readonly Challenge[]
}

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))

/**
 * Finds the course manifest at or above `directory` and loads every challenge beneath it in the order the
 * manifests list them. Children whose folder is missing (planned content) are skipped.
 */
export const load = Effect.fn("SigmaBotCourse.load")(function* (directory: string) {
  const found = yield* findRoot(directory)
  if (!found) return undefined
  const { root, manifest } = found
  const modules: Module[] = []
  const challenges: Challenge[] = []
  for (const child of manifest.children ?? []) {
    const dir = path.join(root, child.path)
    const entry = yield* read(dir)
    if (!entry) continue
    const module = { id: entry.id, title: entry.title, stream: entry.stream, requires: child.requires ?? [] }
    modules.push(module)
    yield* collect(root, dir, entry, module, undefined, challenges)
  }
  return {
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    directory: root,
    gates: manifest.gates ?? { functional: 0.9, nonFunctional: 0.9, quiz: null },
    modules,
    challenges,
  } satisfies Course
})

/** Looks a challenge up by key, or by id when that id names exactly one challenge. */
export function find(course: Course, reference: string) {
  const wanted = reference
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+|\/+$/g, "")
  const byKey = course.challenges.find((challenge) => challenge.key === wanted)
  if (byKey) return byKey
  const byID = course.challenges.filter((challenge) => challenge.id === wanted)
  return byID.length === 1 ? byID[0] : undefined
}

/**
 * Applies the mastery gates: a challenge is locked until every module its module requires is complete and the
 * challenge before it in its module has been passed.
 */
export function status(course: Course, passed: ReadonlySet<string>): readonly Status[] {
  const complete = (moduleID: string) => {
    const own = course.challenges.filter((challenge) => challenge.module.id === moduleID)
    return own.length > 0 && own.every((challenge) => passed.has(challenge.key))
  }
  return course.challenges.map((challenge, index) => {
    if (passed.has(challenge.key)) return { challenge, state: "passed" }
    const required = challenge.module.requires.find((id) => !complete(id))
    if (required !== undefined) {
      const title = course.modules.find((module) => module.id === required)?.title ?? required
      return { challenge, state: "locked", reason: `the ${title} module must be complete first` }
    }
    const previous = course.challenges
      .slice(0, index)
      .filter((other) => other.module.id === challenge.module.id)
      .at(-1)
    if (previous && !passed.has(previous.key))
      return { challenge, state: "locked", reason: `"${previous.title}" (${previous.key}) must be passed first` }
    return { challenge, state: "open" }
  })
}

/**
 * Guesses which challenge the trainee means: one they named, else the furthest-along challenge with uncommitted
 * changes, else the next one they have not passed. The trainee confirms or redirects in the conversation.
 */
export const locate = Effect.fn("SigmaBotCourse.locate")(function* (
  proc: AppProcess.Interface,
  course: Course,
  input: { readonly argument: string; readonly passed: ReadonlySet<string> },
) {
  const changed = yield* changedChallenges(proc, course)
  const named = match(course, input.argument)
  if (named) return { guess: named, reason: "named", changed } satisfies Located
  const recent = changed.at(-1)
  if (recent) return { guess: recent, reason: "changed", changed } satisfies Located
  const next = course.challenges.find((challenge) => !input.passed.has(challenge.key))
  if (next) return { guess: next, reason: "next", changed } satisfies Located
  return { reason: "none", changed } satisfies Located
})

/** Plain-text account of the course position for the /submit prompt. */
export function describe(course: Course, statuses: readonly Status[], located: Located) {
  const line = (status: Status) => {
    const where = status.challenge.chapter
      ? `${status.challenge.module.title} › ${status.challenge.chapter.title}`
      : status.challenge.module.title
    const state = status.state === "locked" ? `locked: ${status.reason}` : status.state
    return `- ${status.challenge.key} — "${status.challenge.title}" (${where}) [${state}]`
  }
  const quiz = course.gates.quiz === null ? "not set in the manifest" : percent(course.gates.quiz)
  return [
    `Course: ${course.title}${course.version ? ` v${course.version}` : ""} at ${course.directory}`,
    `Gates: functional ${percent(course.gates.functional)}, non-functional ${percent(course.gates.nonFunctional)}, quiz ${quiz}`,
    "",
    located.guess ? `Best guess: ${located.guess.key} — "${located.guess.title}"` : "Best guess: none",
    `Reason: ${reasons[located.reason]}`,
    located.changed.length > 0
      ? `Folders with uncommitted changes: ${located.changed.map((challenge) => challenge.key).join(", ")}`
      : "Folders with uncommitted changes: none",
    "",
    `Challenges (${statuses.length}), in course order:`,
    ...statuses.map(line),
  ].join("\n")
}

/** The course grouped by module for the interactive map the trainee picks a challenge from. */
export function map(course: Course, statuses: readonly Status[], located: Located) {
  return {
    title: course.title,
    modules: course.modules.map((module) => ({
      title: module.title,
      challenges: statuses
        .filter((status) => status.challenge.module.id === module.id)
        .map((status) => ({
          key: status.challenge.key,
          title: status.challenge.title,
          state: status.state,
          reason: status.reason,
          changed: located.changed.some((challenge) => challenge.key === status.challenge.key),
          suggested: located.guess?.key === status.challenge.key,
          chapter: status.challenge.chapter?.title,
        })),
    })),
  } satisfies CourseMap.Info
}

const reasons = {
  named: "the trainee named it",
  changed: "it is the furthest-along challenge with uncommitted changes",
  next: "it is the next challenge the trainee has not passed",
  none: "every challenge has been passed",
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`
}

/** The manifest in `directory`, or undefined when the folder has none. A manifest that fails to parse is an error. */
const read = Effect.fn("SigmaBotCourse.read")(function* (directory: string) {
  const file = path.join(directory, "manifest.json")
  const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => undefined))
  if (text === undefined) return undefined
  return yield* decodeManifest(text).pipe(
    Effect.mapError((error) => new ManifestError({ path: file, message: error.message })),
  )
})

const findRoot = Effect.fn("SigmaBotCourse.findRoot")(function* (start: string) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const manifest = yield* read(dir)
    if (manifest?.type === "course") return { root: dir, manifest }
    if (path.dirname(dir) === dir) return undefined
  }
})

const collect: (
  root: string,
  directory: string,
  manifest: Manifest,
  module: Module,
  chapter: Challenge["chapter"],
  into: Challenge[],
) => Effect.Effect<void, ManifestError> = Effect.fn("SigmaBotCourse.collect")(
  function* (root, directory, manifest, module, chapter, into) {
    if (manifest.type === "challenge") {
      into.push({
        key: path.relative(root, directory).split(path.sep).join("/"),
        id: manifest.id,
        title: manifest.title,
        summary: manifest.summary,
        directory,
        module,
        chapter,
        sandbox: manifest.sandbox,
        run: manifest.run?.command,
        test: manifest.test?.command,
        rubric: manifest.rubric
          ? { path: path.join(directory, manifest.rubric.path), encrypted: manifest.rubric.encrypted }
          : undefined,
        quiz: manifest.quiz ? path.join(directory, manifest.quiz.guidance) : undefined,
        tasks: (manifest.tasks ?? []).map((task) => ({
          id: task.id,
          title: task.title,
          script: task.script,
          run: task.run?.command,
          test: task.test?.command,
          setup: task.setup?.command,
        })),
      })
      return
    }
    const own = manifest.type === "module" ? chapter : { id: manifest.id, title: manifest.title }
    for (const child of manifest.children ?? []) {
      const dir = path.join(directory, child.path)
      const entry = yield* read(dir)
      if (!entry) continue
      yield* collect(root, dir, entry, module, own, into)
    }
  },
)

function match(course: Course, argument: string) {
  const text = argument.trim().toLowerCase()
  if (!text) return undefined
  const exact = find(course, argument)
  if (exact) return exact
  const hits = course.challenges.filter(
    (challenge) =>
      text.includes(challenge.key.toLowerCase()) ||
      text.includes(challenge.id.toLowerCase()) ||
      text.includes(challenge.title.toLowerCase()) ||
      challenge.title.toLowerCase().includes(text),
  )
  return hits.length === 1 ? hits[0] : undefined
}

const changedChallenges = Effect.fn("SigmaBotCourse.changed")(function* (proc: AppProcess.Interface, course: Course) {
  const result = yield* proc
    .run(
      ChildProcess.make(gitExecutable(), ["status", "--porcelain", "--untracked-files=all", "--", "."], {
        cwd: course.directory,
        env: { GIT_TERMINAL_PROMPT: "0" },
        extendEnv: true,
        stdin: "ignore",
      }),
      { maxOutputBytes: 1_000_000 },
    )
    .pipe(Effect.orElseSucceed(() => undefined))
  if (!result || result.exitCode !== 0) return []
  // Porcelain paths are relative to the repository root, so they are resolved from where git reports it.
  const top = yield* proc
    .run(
      ChildProcess.make(gitExecutable(), ["rev-parse", "--show-toplevel"], { cwd: course.directory, stdin: "ignore" }),
    )
    .pipe(
      Effect.map((top) => top.stdout.toString("utf8").trim()),
      Effect.orElseSucceed(() => course.directory),
    )
  const files = result.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).split(" -> ").at(-1)!.replace(/^"|"$/g, ""))
    .map((file) => path.relative(course.directory, path.resolve(top, file)).split(path.sep).join("/"))
  return course.challenges.filter((challenge) =>
    files.some((file) => file === challenge.key || file.startsWith(`${challenge.key}/`)),
  )
})
