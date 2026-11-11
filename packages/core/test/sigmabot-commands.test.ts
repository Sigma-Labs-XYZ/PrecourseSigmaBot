import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import type { CommandDefinition } from "@opencode/plugin/effect/command"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { SigmaBotCommandPlugin } from "@opencode/core/plugin/sigmabot-commands"
import { AbsolutePath } from "@opencode/core/schema"
import { ShellSelect } from "@opencode/core/shell/select"
import { Tool } from "@opencode/core/tool"
import { QuestionTool } from "@opencode/core/tool/plugin/question"
import type { Info } from "@opencode/schema/tool"
import { Agent } from "@opencode/schema/agent"
import { CourseMap } from "@opencode/schema/course-map"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppProcess } from "@opencode/util/process"
import { git, initGit } from "./fixture/git"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { host } from "./plugin/host"

// These tests exercise the local store only; the Airtable client has its own tests.
delete process.env.SIGMABOT_AIRTABLE_KEY

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh"

// The course map is a form, so the trainee's reply is scripted here.
const forms = { asked: [] as Form.CreateInput[], reply: { status: "cancelled" } as Form.TerminalState }

// The command and tools spawn git and the test command, so the live clock is used throughout.
const it = testEffect(
  Layer.mergeAll(
    FetchHttpClient.layer,
    LayerNode.compile(AppProcess.node),
    permissionLayer({ assert: () => Effect.void }),
    Layer.mock(Form.Service, {
      ask: (input) =>
        Effect.sync(() => {
          forms.asked.push(input)
          return forms.reply
        }),
    }),
    Layer.succeed(
      ShellSelect.Service,
      ShellSelect.Service.of({
        transform: () => Effect.die("unused shell.transform"),
        reload: () => Effect.die("unused shell.reload"),
        resolve: () => Effect.succeed(shell),
      }),
    ),
  ),
)

const KEYS = ["01-shell/01-where-am-i", "01-shell/02-reading", "02-python/01-till"]

async function manifest(dir: string, value: unknown) {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(value))
}

/** A two-module course whose Python challenge "tests" are an echo of a pytest summary line. */
async function course(root: string) {
  await manifest(root, {
    manifestVersion: 1,
    id: "course",
    type: "course",
    title: "Course",
    gates: { functional: 0.9, nonFunctional: 0.9, quiz: null },
    children: [
      { id: "shell", path: "01-shell", requires: [] },
      { id: "python", path: "02-python", requires: ["shell"] },
    ],
  })
  await manifest(path.join(root, "01-shell"), {
    manifestVersion: 1,
    id: "shell",
    type: "module",
    title: "Shell",
    children: [
      { id: "where-am-i", path: "01-where-am-i" },
      { id: "reading", path: "02-reading" },
    ],
  })
  await manifest(path.join(root, KEYS[0]!), {
    manifestVersion: 1,
    id: "where-am-i",
    type: "challenge",
    title: "Where am I?",
    rubric: { path: "rubric.md", encrypted: false },
    quiz: { guidance: "quiz-guidance.md" },
    tasks: [{ id: "1.0", title: "Walk", script: "1.0-walk.sh", run: { command: "bash 1.0-walk.sh" } }],
  })
  await fs.writeFile(path.join(root, KEYS[0]!, "rubric.md"), "# Rubric\n\nSecret marks.\n")
  await fs.writeFile(path.join(root, KEYS[0]!, "quiz-guidance.md"), "# Quiz\n\nAsk about pwd.\n")
  await fs.writeFile(path.join(root, KEYS[0]!, "1.0-walk.sh"), "pwd\n")
  await manifest(path.join(root, KEYS[1]!), { manifestVersion: 1, id: "reading", type: "challenge", title: "Reading" })
  await manifest(path.join(root, "02-python"), {
    manifestVersion: 1,
    id: "python",
    type: "module",
    title: "Python",
    children: [{ id: "till", path: "01-till" }],
  })
  await manifest(path.join(root, KEYS[2]!), {
    manifestVersion: 1,
    id: "till",
    type: "challenge",
    title: "The till",
    test: { command: "echo ===== 2 passed, 1 failed in 0.1s =====" },
    tasks: [{ id: "1.0", title: "Price", script: "1.0-price.py", test: { command: "echo test_1_0" } }],
  })
  await initGit(root, "-b", "main")
  await git(root, "add", ".")
  await git(root, "commit", "-m", "course")
}

function memoryStorage(): StorageDomain {
  const map = new Map<string, Schema.Json>()
  return {
    get: (key) => Effect.sync(() => map.get(key)),
    set: (key, value) => Effect.sync(() => void map.set(key, value)),
    remove: (key) => Effect.sync(() => void map.delete(key)),
    scan: (options) =>
      Effect.sync(() => ({
        entries: [...map.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      })),
  }
}

/** Boots the plugin against `directory`, capturing registered commands, tools and the prompts it sends. */
const boot = Effect.fn(function* (directory: string) {
  const prompts: { text: string; description?: string }[] = []
  const commands = new Map<string, CommandDefinition>()
  const tools = new Map<string, Info>()
  yield* SigmaBotCommandPlugin.Plugin.effect(
    host({
      storage: memoryStorage(),
      command: {
        list: () => Effect.die("unused command.list"),
        reload: () => Effect.die("unused command.reload"),
        transform: (callback) =>
          Effect.sync(() => {
            callback({ add: (command) => void commands.set(command.name, command) })
            return { dispose: Effect.void }
          }),
      },
      tool: {
        list: () => Effect.die("unused tool.list"),
        reload: () => Effect.die("unused tool.reload"),
        hook: () => Effect.die("unused tool.hook"),
        transform: (callback) =>
          Effect.sync(() => {
            callback({
              list: () => [...tools.entries()].map(([id, tool]) => ({ ...tool, id })),
              get: (id) => {
                const tool = tools.get(id)
                return tool ? { ...tool, id } : undefined
              },
              namespace: () => {},
              add: (tool) => void tools.set(tool.name, tool),
              update: () => {},
              remove: (id) => void tools.delete(id),
            })
            return { dispose: Effect.void }
          }),
      },
      session: {
        synthetic: (input) =>
          Effect.sync(() => {
            prompts.push({ text: input.text, description: input.description })
            return SessionInbox.Synthetic.make({
              id: SessionMessage.ID.make("msg_test"),
              sessionID: input.sessionID,
              time: { created: DateTime.makeUnsafe(0) },
              type: "synthetic",
              payload: { text: input.text, description: input.description },
              delivery: input.delivery ?? "steer",
            })
          }),
      },
    }),
  ).pipe(
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )
  const sessionID = Session.ID.make("ses_submit")
  const context = (agent: string): Tool.Context => ({
    sessionID,
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_submit"),
    id: Tool.CallID.make("call_submit"),
    progress: () => Effect.void,
  })
  const submit = (text: string) =>
    commands.get("submit")!.execute({ sessionID, prompt: { text }, delivery: "steer" }).pipe(Effect.asVoid)
  const call = (name: string, input: unknown, agent = "tutor") =>
    (tools.get(name)!.execute(input, context(agent)) as Effect.Effect<Tool.Result, Tool.Error>).pipe(
      Effect.map((result) => String(result.content)),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed(`ERROR: ${error.message}`)),
    )
  return { prompts, commands, tools, submit, call, context }
})

describe("SigmaBotCommandPlugin /submit", () => {
  it.live("fills the prompt with the course position and explains a folder outside a course", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const outside = yield* boot(tmp.path)
        yield* outside.submit("")
        expect(outside.prompts[0]?.text).toContain("Status: unavailable.")
        expect(outside.prompts[0]?.text).toContain('no manifest.json of type "course"')

        yield* Effect.promise(() => course(tmp.path))
        const plugin = yield* boot(path.join(tmp.path, "01-shell"))
        expect([...plugin.commands.keys()].sort()).toEqual(["submit", "update"])
        expect([...plugin.tools.keys()].sort()).toEqual([
          "submission_choose",
          "submission_prepare",
          "submission_record",
          "submission_rubric",
        ])
        yield* plugin.submit("  the till  ")
        const prompt = plugin.prompts[0]!.text
        expect(plugin.prompts[0]!.description).toBe("/submit the till")
        expect(prompt).toContain("User input: the till")
        expect(prompt).toContain(`Best guess: ${KEYS[2]} — "The till"`)
        expect(prompt).toContain("Reason: the trainee named it")
        expect(prompt).toContain(`- ${KEYS[0]} — "Where am I?" (Shell) [open]`)
        expect(prompt).toContain(`- ${KEYS[2]} — "The till" (Python) [locked: the Shell module must be complete first]`)
        expect(prompt).not.toContain("$SUBMISSION")
      }),
    ),
  )

  it.live("runs the gates in code: tests, grader-only rubric, verdict and unlocking", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => course(tmp.path))
        const plugin = yield* boot(tmp.path)

        expect(yield* plugin.call("submission_prepare", { challenge: "nope" })).toContain('No challenge matches "nope"')
        expect(yield* plugin.call("submission_prepare", { challenge: KEYS[2] })).toContain(
          `ERROR: ${KEYS[2]} is locked: the Shell module must be complete first.`,
        )

        const prepared = yield* plugin.call("submission_prepare", { challenge: KEYS[0] })
        expect(prepared).toContain(`Challenge: ${KEYS[0]} — "Where am I?"`)
        expect(prepared).toContain(`Folder: ${path.join(tmp.path, KEYS[0]!)}`)
        expect(prepared).toContain("Attempt: 1\n")
        expect(prepared).toContain('- 1.0 "Walk"; file 1.0-walk.sh; run: bash 1.0-walk.sh')
        expect(prepared).toContain("Functional tests: none provided.")
        expect(prepared).toContain("Ask about pwd.")
        expect(prepared).not.toContain("Secret marks")

        expect(yield* plugin.call("submission_rubric", { challenge: KEYS[0] })).toContain(
          "Only the grader agent may read a rubric",
        )
        const rubric = yield* plugin.call("submission_rubric", { challenge: KEYS[0] }, "grader")
        expect(rubric).toContain("Rubric:\n# Rubric\n\nSecret marks.")
        expect(rubric).toContain('- 1.0 "Walk"')

        const failed = yield* plugin.call("submission_record", {
          challenge: KEYS[0],
          functional: 1,
          nonFunctional: 0.85,
          quiz: 1,
          summary: "Hard-coded a path.",
        })
        expect(failed).toContain(
          "Attempt 1 at 01-shell/01-where-am-i recorded on this laptop only (Airtable could not be reached, so coaches cannot see it yet).\nVerdict: not passed yet",
        )
        expect(failed).toContain("Non-functional: 85% (needs 90%)")
        expect(failed).toContain("Quiz: 100% (needs 80%)")
        expect(yield* plugin.call("submission_prepare", { challenge: KEYS[0] })).toContain("Attempt: 2 (previous: 20")

        const passed = yield* plugin.call("submission_record", {
          challenge: KEYS[0],
          functional: 0.95,
          nonFunctional: 0.9,
          quiz: 0.8,
          summary: "Clean scripts.",
        })
        expect(passed).toContain("Attempt 2 at 01-shell/01-where-am-i recorded on this laptop only")
        expect(passed).toContain("Verdict: passed")
        expect(
          yield* plugin.call("submission_record", {
            challenge: KEYS[1],
            functional: 1,
            nonFunctional: 1,
            quiz: 1,
            summary: "",
          }),
        ).toContain("Verdict: passed")

        const python = yield* plugin.call("submission_prepare", { challenge: "till" })
        expect(python).toContain("Functional tests: echo ===== 2 passed, 1 failed in 0.1s =====")
        expect(python).toContain("Exit code: 0; passed 2, failed 1; score 67%")
        expect(python).toContain("Test output:\n===== 2 passed, 1 failed in 0.1s =====")
        expect(python).toContain("(none provided; write a short quiz")

        yield* plugin.submit("")
        expect(plugin.prompts[0]?.text).toContain(`Best guess: ${KEYS[2]} — "The till"`)
        expect(plugin.prompts[0]?.text).toContain("Reason: it is the next challenge the trainee has not passed")
        expect(plugin.prompts[0]?.text).toContain(`- ${KEYS[0]} — "Where am I?" (Shell) [passed]`)
        expect(plugin.prompts[0]?.text).toContain(`- ${KEYS[2]} — "The till" (Python) [open]`)
      }),
    ),
  )
  it.live("asks the trainee to pick from the course map and reports what they chose", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => course(tmp.path))
        const plugin = yield* boot(tmp.path)
        const ask = (challenge: string) => {
          forms.asked.length = 0
          forms.reply = { status: "answered", answer: { challenge } }
          return plugin.call("submission_choose", {})
        }

        expect(yield* ask(KEYS[2]!)).toBe(
          `The trainee picked ${KEYS[2]} — "The till", which is locked: the Shell module must be complete first.`,
        )
        const form = forms.asked[0]!
        // The client receives the metadata as JSON, which drops the undefined fields.
        const wire = (value: unknown) => Schema.decodeUnknownSync(CourseMap.Info)(JSON.parse(JSON.stringify(value)))
        expect(form.metadata?.kind).toBe(CourseMap.KIND)
        expect(form.fields.map((field) => field.key)).toEqual(["challenge"])
        expect(wire(form.metadata?.course)).toEqual({
          title: "Course",
          modules: [
            {
              title: "Shell",
              challenges: [
                { key: KEYS[0], title: "Where am I?", state: "open", changed: false, suggested: true },
                {
                  key: KEYS[1],
                  title: "Reading",
                  state: "locked",
                  reason: `"Where am I?" (${KEYS[0]}) must be passed first`,
                  changed: false,
                  suggested: false,
                },
              ],
            },
            {
              title: "Python",
              challenges: [
                {
                  key: KEYS[2],
                  title: "The till",
                  state: "locked",
                  reason: "the Shell module must be complete first",
                  changed: false,
                  suggested: false,
                },
              ],
            },
          ],
        })

        yield* plugin.call("submission_record", {
          challenge: KEYS[0],
          functional: 1,
          nonFunctional: 1,
          quiz: 1,
          summary: "",
        })
        expect(yield* ask(KEYS[0]!)).toContain("which they have already passed.")
        expect(yield* ask(KEYS[1]!)).toBe(`The trainee picked ${KEYS[1]} — "Reading".`)
        const modules = wire(forms.asked[0]!.metadata?.course).modules
        expect(modules[0]!.challenges.map((challenge) => challenge.state)).toEqual(["passed", "open"])
        expect(modules[0]!.challenges.map((challenge) => challenge.suggested)).toEqual([false, true])

        forms.reply = { status: "cancelled" }
        const exit = yield* Effect.exit(
          plugin.tools.get("submission_choose")!.execute({}, plugin.context("tutor")) as Effect.Effect<
            Tool.Result,
            Tool.Error
          >,
        )
        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(QuestionTool.CancelledError)
      }),
    ),
  )
})
