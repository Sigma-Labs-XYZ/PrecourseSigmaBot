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

  it.effect("decrypts openssl output, with or without the explanatory header", () =>
    Effect.sync(() => {
      const fromOpenssl = "U2FsdGVkX1/lO+NBFaRsDeH9rCEwhfvXY1kxUVFEI5v592VbkNUg/R80J0cxF2Oz\n"
      const withHeader = `ENCRYPTED FILE: quiz-guidance.md\n\nLeave it where it is.\n-----END HEADER-----\n${fromOpenssl}`
      expect(SigmaBotSubmit.decrypt(withHeader)).toBe("# Quiz\n\nAsk about pwd.\n")
      expect(SigmaBotSubmit.decrypt(fromOpenssl)).toBe("# Quiz\n\nAsk about pwd.\n")
      expect(SigmaBotSubmit.decrypt(SigmaBotSubmit.encrypt("# Rubric\n"))).toBe("# Rubric\n")
      expect(() => SigmaBotSubmit.decrypt("bm90IGVuY3J5cHRlZA==")).toThrow()
    }),
  )

  live.live("reads plain and encrypted rubrics and quiz guidance", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const header = "ENCRYPTED FILE: x\n-----END HEADER-----\n"
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(tmp.path, "rubric.md"), "# Plain\n")
          await fs.writeFile(path.join(tmp.path, "rubric.enc"), header + SigmaBotSubmit.encrypt("# Hidden\n"))
          await fs.writeFile(path.join(tmp.path, "quiz-guidance.md"), header + SigmaBotSubmit.encrypt("# Quiz\n"))
          await fs.writeFile(path.join(tmp.path, "plain-quiz.md"), "# Open quiz\n")
          await fs.writeFile(path.join(tmp.path, "broken.md"), header + "bm90IGVuY3J5cHRlZA==")
        })
        const plain = challenge(tmp.path, { path: path.join(tmp.path, "rubric.md"), encrypted: false })
        const hidden = challenge(tmp.path, { path: path.join(tmp.path, "rubric.enc"), encrypted: true })
        expect(yield* SigmaBotSubmit.rubric(plain)).toBe("# Plain\n")
        expect(yield* SigmaBotSubmit.rubric(hidden)).toBe("# Hidden\n")
        expect((yield* SigmaBotSubmit.rubric(challenge(tmp.path, undefined)).pipe(Effect.flip)).message).toContain(
          "no rubric",
        )
        const missing = challenge(tmp.path, { path: path.join(tmp.path, "gone.md"), encrypted: false })
        expect((yield* SigmaBotSubmit.rubric(missing).pipe(Effect.flip)).message).toContain("missing")
        expect(yield* SigmaBotSubmit.guidance(path.join(tmp.path, "quiz-guidance.md"))).toBe("# Quiz\n")
        expect(yield* SigmaBotSubmit.guidance(path.join(tmp.path, "plain-quiz.md"))).toBe("# Open quiz\n")
        expect(yield* SigmaBotSubmit.guidance(path.join(tmp.path, "broken.md"))).toBeUndefined()
        expect(yield* SigmaBotSubmit.guidance(path.join(tmp.path, "gone.md"))).toBeUndefined()
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
