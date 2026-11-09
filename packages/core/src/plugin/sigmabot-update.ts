export * as SigmaBotUpdate from "./sigmabot-update.js"

import { Effect } from "effect"
import { ChildProcess } from "effect/process"
import type { AppProcess } from "@opencode/util/process"
import { gitExecutable } from "../util/git-executable.js"

/** The original course content repository that every trainee's fork descends from. */
export const REPOSITORY = "https://github.com/Sigma-Labs-XYZ/SelfPacedPreCourse"
/** Remote name added when none of the fork's remotes points at {@link REPOSITORY}. `gh repo fork` uses it too. */
export const REMOTE = "upstream"

export type Result =
  | { readonly status: "not-repository" }
  | { readonly status: "detached" }
  /** A previous update's merge is still waiting on these conflicted files. */
  | { readonly status: "unresolved"; readonly files: readonly string[] }
  | { readonly status: "failed"; readonly step: "remote" | "fetch" | "merge"; readonly detail: string }
  | { readonly status: "up-to-date"; readonly remote: string; readonly branch: string }
  | {
      readonly status: "merged"
      readonly remote: string
      readonly branch: string
      readonly commits: readonly string[]
      readonly files: readonly string[]
    }
  | {
      readonly status: "conflicts"
      readonly remote: string
      readonly branch: string
      readonly commits: readonly string[]
      readonly files: readonly string[]
    }

/**
 * Fetches the course repository and merges its default branch into the checked-out branch of the fork at
 * `directory`. Uncommitted work is autostashed around the merge; a conflicted merge is left in place for the
 * `updater` agent, while any other merge failure is aborted so the fork is left as it was.
 */
export const run = Effect.fn("SigmaBotUpdate.run")(function* (
  proc: AppProcess.Interface,
  input: { readonly directory: string; readonly repository?: string },
) {
  const repository = input.repository ?? REPOSITORY
  const git = makeGit(proc, input.directory)
  if (!(yield* git(["rev-parse", "--is-inside-work-tree"])).ok) return { status: "not-repository" } satisfies Result
  if (!(yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"])).ok) return { status: "detached" } satisfies Result
  if ((yield* git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).ok)
    return { status: "unresolved", files: yield* conflicted(git) } satisfies Result

  const remote = yield* ensureRemote(git, repository)
  if (typeof remote !== "string") return remote

  const fetch = yield* git(["fetch", remote])
  if (!fetch.ok) return { status: "failed", step: "fetch", detail: fetch.stderr } satisfies Result

  const branch = yield* defaultBranch(git, remote)
  const target = `${remote}/${branch}`
  const before = (yield* git(["rev-parse", "HEAD"])).stdout
  const commits = lines((yield* git(["log", "--oneline", "--no-decorate", `HEAD..${target}`])).stdout)
  if (commits.length === 0) return { status: "up-to-date", remote, branch } satisfies Result

  const merge = yield* git(["merge", "--no-edit", "--autostash", target])
  if (merge.ok) {
    const files = lines((yield* git(["diff", "--name-status", before, "HEAD"])).stdout)
    return { status: "merged", remote, branch, commits, files } satisfies Result
  }
  const files = yield* conflicted(git)
  if (files.length > 0) return { status: "conflicts", remote, branch, commits, files } satisfies Result
  yield* git(["merge", "--abort"])
  return { status: "failed", step: "merge", detail: merge.stderr || merge.stdout } satisfies Result
})

/** Plain-text account of a {@link Result} for the prompt that explains it to the trainee. */
export function report(result: Result) {
  if (result.status === "not-repository")
    return "Status: not a git repository. The current directory is not inside a git repository, so there is no fork to update."
  if (result.status === "detached")
    return "Status: no branch checked out. The fork is in detached HEAD state, so there is no branch to merge the course content into."
  if (result.status === "unresolved")
    return [
      "Status: conflicts (left over from an earlier update that was never finished)",
      ...list("Conflicted files", result.files),
    ].join("\n")
  if (result.status === "failed")
    return [`Status: failed while ${steps[result.step]}`, `Detail: ${result.detail || "no output from git"}`].join("\n")
  const source = `Source: ${result.remote}/${result.branch} (${REPOSITORY})`
  if (result.status === "up-to-date") return ["Status: up to date, nothing to merge", source].join("\n")
  if (result.status === "merged")
    return [
      "Status: merged cleanly",
      source,
      ...list("New commits", result.commits),
      ...list("Changed files (status, path)", result.files),
    ].join("\n")
  return [
    "Status: conflicts, merge stopped",
    source,
    ...list("New commits", result.commits),
    ...list("Conflicted files", result.files),
  ].join("\n")
}

const steps = {
  remote: "adding the course repository as a git remote",
  fetch: "fetching from the course repository",
  merge: "merging the course content (the merge was aborted, the fork is unchanged)",
}

function list(title: string, items: readonly string[]) {
  return [`${title} (${items.length}):`, ...items.map((item) => `- ${item}`)]
}

function lines(output: string) {
  return output.split(/\r?\n/).filter(Boolean)
}

type Git = ReturnType<typeof makeGit>

function makeGit(proc: AppProcess.Interface, cwd: string) {
  return Effect.fn("SigmaBotUpdate.git")(
    function* (args: string[]) {
      const result = yield* proc.run(
        // No terminal to answer a credential prompt, so a fork without GitHub access fails instead of hanging.
        ChildProcess.make(gitExecutable(), args, {
          cwd,
          env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
          extendEnv: true,
          stdin: "ignore",
        }),
        { maxOutputBytes: 1_000_000 },
      )
      return {
        ok: result.exitCode === 0,
        stdout: result.stdout.toString("utf8").trim(),
        stderr: result.stderr.toString("utf8").trim(),
      }
    },
    Effect.orElseSucceed(() => ({ ok: false, stdout: "", stderr: "git could not be started" })),
  )
}

const conflicted = Effect.fnUntraced(function* (git: Git) {
  return lines((yield* git(["diff", "--name-only", "--diff-filter=U"])).stdout)
})

const ensureRemote = Effect.fnUntraced(function* (git: Git, repository: string) {
  const remotes = lines((yield* git(["remote", "-v"])).stdout).flatMap((line) => {
    const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line)
    return match ? [{ name: match[1]!, url: match[2]! }] : []
  })
  const existing = remotes.find((remote) => sameRepository(remote.url, repository))
  if (existing) return existing.name
  const taken = remotes.find((remote) => remote.name === REMOTE)
  if (taken)
    return {
      status: "failed",
      step: "remote",
      detail: `The remote "${REMOTE}" already exists and points at ${taken.url}, not the course repository.`,
    } satisfies Result
  const added = yield* git(["remote", "add", REMOTE, repository])
  if (!added.ok) return { status: "failed", step: "remote", detail: added.stderr } satisfies Result
  return REMOTE
})

const defaultBranch = Effect.fnUntraced(function* (git: Git, remote: string) {
  const symref = yield* git(["ls-remote", "--symref", remote, "HEAD"])
  return /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref.stdout)?.[1] ?? "main"
})

/** Matches https, ssh and scp-style spellings of the same repository, with or without `.git`. */
export function sameRepository(url: string, repository: string) {
  return normalize(url) === normalize(repository)
}

function normalize(url: string) {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^github\.com:/, "github.com/")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
}
