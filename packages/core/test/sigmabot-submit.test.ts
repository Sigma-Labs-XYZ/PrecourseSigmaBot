import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { SigmaBotCourse } from "@opencode/core/plugin/sigmabot-course"
import { SigmaBotProgress } from "@opencode/core/plugin/sigmabot-progress"
import { SigmaBotSubmit } from "@opencode/core/plugin/sigmabot-submit"
import { withTempDir } from "./fixture/tmpdir"
import { it, testEffect } from "./lib/effect"

const live = testEffect(LayerNode.compile(AppProcess.node))

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh"

const challenge = (directory: string, rubric: SigmaBotCourse.Challenge["rubric"]): SigmaBotCourse.Challenge => ({
  key: "02-python/01-the-till-line",
  id: "the-till-line",
  title: "The till line",
  directory,
  module: { id: "python", title: "Python", requires: [] },
  rubric,
  tasks: [],
})

const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

describe("SigmaBotSubmit", () => {
  it.effect("scores the pytest summary line", () =>
    Effect.sync(() => {
      const output =
        "tests/test_till.py ..F.\n\nFAILED tests/test_till.py::test_1_2\n===== 3 passed, 1 failed in 0.12s =====\n"
      expect(SigmaBotSubmit.score(output)).toMatchObject({ passed: 3, failed: 1, score: 0.75, output })
      expect(SigmaBotSubmit.score("===== 2 passed in 0.01s =====")).toMatchObject({ passed: 2, failed: 0, score: 1 })
      expect(SigmaBotSubmit.score("===== 1 failed, 2 errors in 0.01s =====")).toMatchObject({
        passed: 0,
        failed: 3,
        score: 0,
      })
      expect(SigmaBotSubmit.score("===== no tests ran in 0.01s =====")).toMatchObject({
        passed: 0,
        failed: 0,
        score: undefined,
      })
      expect(SigmaBotSubmit.score("bash: pytest: command not found").score).toBeUndefined()
      const long = "x".repeat(30_000)
      expect(SigmaBotSubmit.score(long).output).toHaveLength(20_000 + "\n[output truncated]".length)
    }),
  )

  live.live("runs the test command from the challenge folder and keeps its output", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const proc = yield* AppProcess.Service
        const result = yield* SigmaBotSubmit.tests(proc, {
          shell,
          directory: tmp.path,
          command: "echo ===== 4 passed, 1 failed in 0.2s =====",
        })
        expect(result).toMatchObject({ exitCode: 0, passed: 4, failed: 1, score: 0.8 })
        expect(result.output).toContain("4 passed, 1 failed")
        const failing = yield* SigmaBotSubmit.tests(proc, { shell, directory: tmp.path, command: "exit 3" })
        expect(failing).toMatchObject({ exitCode: 3, score: undefined })
      }),
    ),
  )

  it.effect("round-trips a rubric through AES-256-GCM", () =>
    Effect.sync(() => {
      const encrypted = SigmaBotSubmit.encrypt("# Rubric\n\nSecret marks.\n", key)
      expect(encrypted).not.toContain("Secret")
      expect(SigmaBotSubmit.decrypt(encrypted, key)).toBe("# Rubric\n\nSecret marks.\n")
      expect(() => SigmaBotSubmit.decrypt(encrypted, key.replace("0", "f"))).toThrow()
    }),
  )

  live.live("reads a plain rubric and decrypts an encrypted one only with the key", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(tmp.path, "rubric.md"), "# Plain\n")
          await fs.writeFile(path.join(tmp.path, "rubric.md.enc"), SigmaBotSubmit.encrypt("# Hidden\n", key))
        })
        const plain = challenge(tmp.path, { path: path.join(tmp.path, "rubric.md"), encrypted: false })
        const hidden = challenge(tmp.path, { path: path.join(tmp.path, "rubric.md.enc"), encrypted: true })
        expect(yield* SigmaBotSubmit.rubric(plain, undefined)).toBe("# Plain\n")
        expect(yield* SigmaBotSubmit.rubric(hidden, key)).toBe("# Hidden\n")
        expect((yield* SigmaBotSubmit.rubric(hidden, undefined).pipe(Effect.flip)).message).toContain("no rubric key")
        expect((yield* SigmaBotSubmit.rubric(challenge(tmp.path, undefined), key).pipe(Effect.flip)).message).toContain(
          "no rubric",
        )
        const missing = challenge(tmp.path, { path: path.join(tmp.path, "gone.md"), encrypted: false })
        expect((yield* SigmaBotSubmit.rubric(missing, key).pipe(Effect.flip)).message).toContain("missing")
      }),
    ),
  )
})

// In-memory stand-in for the plugin storage domain. Pages hold at most two entries so scans must paginate.
function memoryStorage(): StorageDomain {
  const map = new Map<string, Schema.Json>()
  return {
    get: (key) => Effect.sync(() => map.get(key)),
    set: (key, value) => Effect.sync(() => void map.set(key, value)),
    remove: (key) => Effect.sync(() => void map.delete(key)),
    scan: (options) =>
      Effect.sync(() => {
        const keys = [...map.keys()]
          .filter((key) => key.startsWith(options.prefix) && (options.after === undefined || key > options.after))
          .sort()
        const limit = Math.min(options.limit ?? 2, 2)
        const page = keys.slice(0, limit)
        return {
          entries: page.map((key) => ({ key, value: map.get(key)! })),
          next: keys.length > limit ? page.at(-1) : undefined,
        }
      }),
  }
}

describe("SigmaBotProgress.make", () => {
  const submission = (challenge: string, passed: boolean): SigmaBotProgress.Submission => ({
    course: { id: "course" },
    challenge: { key: challenge, title: challenge, module: "shell" },
    functional: passed ? 1 : 0.5,
    nonFunctional: 0.95,
    quiz: 0.8,
    passed,
    summary: passed ? "all good" : "half the tests fail",
  })

  it.effect("numbers attempts per challenge and reports passed challenges across pages", () =>
    Effect.gen(function* () {
      const progress = SigmaBotProgress.make(memoryStorage())
      expect(yield* progress.record(submission("a", false))).toEqual({ attempt: 1, synced: false })
      expect(yield* progress.record(submission("a", true))).toEqual({ attempt: 2, synced: false })
      expect((yield* progress.record(submission("b", false))).attempt).toBe(1)
      expect((yield* progress.record(submission("c", true))).attempt).toBe(1)
      expect((yield* progress.record(submission("d", true))).attempt).toBe(1)
      expect((yield* progress.record({ ...submission("e", true), course: { id: "other" } })).attempt).toBe(1)

      const attempts = yield* progress.attempts("course", "a")
      expect(attempts.map((item) => item.passed)).toEqual([false, true])
      expect(attempts[0]!.at).toBe("1970-01-01T00:00:00.000Z")
      expect(yield* progress.attempts("course", "zzz")).toEqual([])
      expect(yield* progress.passed("course")).toEqual(new Set(["a", "c", "d"]))
      expect(yield* progress.passed("other")).toEqual(new Set(["e"]))
    }),
  )
})
