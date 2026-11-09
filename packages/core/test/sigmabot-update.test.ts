import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { SigmaBotUpdate } from "@opencode/core/plugin/sigmabot-update"
import { git, initGit } from "./fixture/git"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Every test drives real git processes, so the live clock is used throughout.
const it = testEffect(LayerNode.compile(AppProcess.node))

// Mirrors the identity appended by initGit for repositories that were cloned instead of initialised.
const identity = `[user]
	email = trainee@opencode.test
	name = Trainee
`

const write = (dir: string, file: string, content: string) => fs.writeFile(path.join(dir, file), content)
const read = (dir: string, file: string) => fs.readFile(path.join(dir, file), "utf8")

/**
 * A course repository with one lesson and a trainee's clone of it whose origin points at their own GitHub fork,
 * as `gh repo fork --clone` leaves it, minus the upstream remote.
 */
async function fixture(root: string) {
  const course = path.join(root, "course")
  const fork = path.join(root, "fork")
  await initGit(course, "-b", "main")
  await write(course, "README.md", "# Course\n")
  await fs.mkdir(path.join(course, "01-shell"))
  await write(course, "01-shell/lesson.md", "Run ls\n")
  await write(course, "01-shell/solution.py", "# write your solution here\n")
  await git(course, "add", ".")
  await git(course, "commit", "-m", "course v1")
  await git(root, "clone", "-q", course, fork)
  await fs.appendFile(path.join(fork, ".git", "config"), identity)
  await git(fork, "remote", "set-url", "origin", "https://github.com/trainee/SelfPacedPreCourse.git")
  return { course, fork }
}

async function courseCommit(course: string, file: string, content: string, message: string) {
  await write(course, file, content)
  await git(course, "add", file)
  await git(course, "commit", "-m", message)
}

async function traineeCommit(fork: string, file: string, content: string, message: string) {
  await write(fork, file, content)
  await git(fork, "add", file)
  await git(fork, "commit", "-m", message)
}

const update = (directory: string, repository: string) =>
  Effect.gen(function* () {
    const proc = yield* AppProcess.Service
    return yield* SigmaBotUpdate.run(proc, { directory, repository })
  })

describe("SigmaBotUpdate", () => {
  it.live("reports a directory outside any repository", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        expect(yield* update(tmp.path, "/nowhere")).toEqual({ status: "not-repository" })
      }),
    ),
  )

  it.live("adds the course remote and merges new content, keeping the trainee's commits", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => traineeCommit(fork, "01-shell/solution.py", "print('done')\n", "solve 01"))
        yield* Effect.promise(() => courseCommit(course, "01-shell/lesson.md", "Run ls -la\n", "fix lesson"))

        const result = yield* update(fork, course)

        expect(result).toMatchObject({
          status: "merged",
          remote: "upstream",
          branch: "main",
          files: ["M\t01-shell/lesson.md"],
        })
        expect(result.status === "merged" && result.commits).toEqual([expect.stringMatching(/^[0-9a-f]+ fix lesson$/)])
        expect(yield* Effect.promise(() => read(fork, "01-shell/lesson.md"))).toBe("Run ls -la\n")
        expect(yield* Effect.promise(() => read(fork, "01-shell/solution.py"))).toBe("print('done')\n")
        const remotes = yield* Effect.promise(() => Bun.$`git remote get-url upstream`.cwd(fork).text())
        expect(remotes.trim()).toBe(course)
      }),
    ),
  )

  it.live("reports an up-to-date fork without touching it", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => traineeCommit(fork, "01-shell/solution.py", "print('done')\n", "solve 01"))
        const before = yield* Effect.promise(() => Bun.$`git rev-parse HEAD`.cwd(fork).text())

        expect(yield* update(fork, course)).toEqual({ status: "up-to-date", remote: "upstream", branch: "main" })
        expect(yield* Effect.promise(() => Bun.$`git rev-parse HEAD`.cwd(fork).text())).toBe(before)
      }),
    ),
  )

  it.live("reuses any remote that already points at the course repository", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => git(fork, "remote", "add", "course", course))

        expect(yield* update(fork, course)).toMatchObject({ status: "up-to-date", remote: "course" })
        const remotes = yield* Effect.promise(() => Bun.$`git remote`.cwd(fork).text())
        expect(remotes.trim().split("\n").sort()).toEqual(["course", "origin"])
      }),
    ),
  )

  it.live("refuses to repoint an upstream remote that belongs to something else", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => git(fork, "remote", "add", "upstream", "https://github.com/other/repo.git"))

        expect(yield* update(fork, course)).toEqual({
          status: "failed",
          step: "remote",
          detail:
            'The remote "upstream" already exists and points at https://github.com/other/repo.git, not the course repository.',
        })
      }),
    ),
  )

  it.live("stashes uncommitted work around the merge", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => write(fork, "01-shell/solution.py", "print('in progress')\n"))
        yield* Effect.promise(() => courseCommit(course, "README.md", "# Course v2\n", "retitle"))

        expect(yield* update(fork, course)).toMatchObject({ status: "merged", files: ["M\tREADME.md"] })
        expect(yield* Effect.promise(() => read(fork, "README.md"))).toBe("# Course v2\n")
        expect(yield* Effect.promise(() => read(fork, "01-shell/solution.py"))).toBe("print('in progress')\n")
        const status = yield* Effect.promise(() => Bun.$`git status --porcelain`.cwd(fork).text())
        expect(status.trim()).toBe("M 01-shell/solution.py")
      }),
    ),
  )

  it.live("leaves a conflicted merge in place and reports it again until it is finished", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => traineeCommit(fork, "01-shell/solution.py", "print('done')\n", "solve 01"))
        yield* Effect.promise(() =>
          courseCommit(course, "01-shell/solution.py", "# starter: print hi\n", "fix starter"),
        )
        yield* Effect.promise(() => courseCommit(course, "01-shell/lesson.md", "Run ls -la\n", "fix lesson"))

        const result = yield* update(fork, course)

        expect(result).toMatchObject({ status: "conflicts", remote: "upstream", files: ["01-shell/solution.py"] })
        expect(result.status === "conflicts" && result.commits.length).toBe(2)
        expect(yield* Effect.promise(() => read(fork, "01-shell/solution.py"))).toContain("<<<<<<<")
        expect(yield* Effect.promise(() => read(fork, "01-shell/lesson.md"))).toBe("Run ls -la\n")

        expect(yield* update(fork, course)).toEqual({ status: "unresolved", files: ["01-shell/solution.py"] })
      }),
    ),
  )

  it.live("follows the course repository's default branch", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const { course, fork } = yield* Effect.promise(() => fixture(tmp.path))
        yield* Effect.promise(() => git(course, "branch", "-m", "main", "trunk"))
        yield* Effect.promise(() => courseCommit(course, "README.md", "# Course v2\n", "retitle"))

        expect(yield* update(fork, course)).toMatchObject({ status: "merged", branch: "trunk" })
      }),
    ),
  )

  it.live("renders each outcome for the prompt", () =>
    Effect.sync(() => {
      expect(
        SigmaBotUpdate.report({
          status: "merged",
          remote: "upstream",
          branch: "main",
          commits: ["abc1234 fix lesson"],
          files: ["M\t01-shell/lesson.md"],
        }),
      ).toBe(
        [
          "Status: merged cleanly",
          `Source: upstream/main (${SigmaBotUpdate.REPOSITORY})`,
          "New commits (1):",
          "- abc1234 fix lesson",
          "Changed files (status, path) (1):",
          "- M\t01-shell/lesson.md",
        ].join("\n"),
      )
      expect(SigmaBotUpdate.report({ status: "failed", step: "fetch", detail: "" })).toBe(
        "Status: failed while fetching from the course repository\nDetail: no output from git",
      )
      expect(SigmaBotUpdate.report({ status: "unresolved", files: ["a.py"] })).toContain("left over from an earlier")
    }),
  )

  it.live("recognises the course repository under every URL spelling", () =>
    Effect.sync(() => {
      for (const url of [
        "https://github.com/Sigma-Labs-XYZ/SelfPacedPreCourse",
        "https://github.com/sigma-labs-xyz/selfpacedprecourse.git",
        "git@github.com:Sigma-Labs-XYZ/SelfPacedPreCourse.git",
        "ssh://git@github.com/Sigma-Labs-XYZ/SelfPacedPreCourse.git",
      ]) {
        expect(SigmaBotUpdate.sameRepository(url, SigmaBotUpdate.REPOSITORY)).toBe(true)
      }
      expect(
        SigmaBotUpdate.sameRepository("https://github.com/trainee/SelfPacedPreCourse.git", SigmaBotUpdate.REPOSITORY),
      ).toBe(false)
    }),
  )
})
