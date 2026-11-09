import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { AgentPlugin } from "@opencode/core/plugin/agent"
import { AbsolutePath } from "@opencode/core/schema"
import { Global } from "@opencode/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/opencode" })
const globalLayer = Layer.succeed(Global.Service, Global.Service.of(global))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    Global.node.replace(globalLayer),
    Location.node.replace(locationLayer),
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("Agent", () => {
  it.effect("publishes an updated event after agent changes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const bus = yield* Bus.Service
      const updated = yield* bus
        .subscribe(Agent.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* agent.transform((editor) => editor.update(Agent.ID.make("reviewer"), () => {}))

      expect(yield* Fiber.join(updated)).toMatchObject([{ location: { directory: testLocation.directory } }])
    }),
  )

  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service

      expect(yield* agent.list()).toEqual([])
      expect(yield* agent.get(Agent.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.list()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("lists the selected default agent first", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.transform((editor) => {
        editor.update(Agent.ID.make("build"), (info) => {
          info.mode = "primary"
        })
        editor.update(Agent.ID.make("reviewer"), (info) => {
          info.mode = "primary"
        })
        editor.update(Agent.ID.make("explore"), (info) => {
          info.mode = "subagent"
        })
        editor.default(Agent.ID.make("reviewer"))
      })

      expect((yield* agent.list()).map((info) => String(info.id))).toEqual(["reviewer", "build", "explore"])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      const info = yield* agent.get(id)
      expect(info?.mode).toBe("primary")
      expect(info?.permissions.slice(0, Agent.Info.default(id).permissions.length)).toEqual(
        Agent.Info.default(id).permissions,
      )
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "shell", "*", "*"), info?.permissions ?? [])
          .effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "tool-output", "*"), info?.permissions ?? [])
          .effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.config, "*"), info?.permissions ?? []).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.tmp, "*"), info?.permissions ?? []).effect,
      ).toBe("allow")

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("allows external directories without opting built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      const agents = yield* agent.list()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "compaction",
        "explainer",
        "grader",
        "it-support",
        "quizmaster",
        "researcher",
        "reviewer",
        "summary",
        "title",
        "tutor",
        "updater",
      ])
      expect(Agent.defaultID).toBe(Agent.ID.make("tutor"))
      expect((yield* agent.get(Agent.defaultID))?.system).toContain("patient tutor")
      expect((yield* agent.get(Agent.ID.make("reviewer")))?.mode).toBe("primary")
      const permissions = (yield* agent.get(Agent.defaultID))?.permissions ?? []
      const compaction = yield* agent.get(Agent.ID.make("compaction"))
      expect(compaction?.mode).toBe("primary")
      expect(compaction?.hidden).toBe(true)
      expect(compaction?.system).toBeUndefined()
      expect(compaction?.model).toBeUndefined()
      expect(compaction?.request).toEqual(Agent.Info.default(Agent.ID.make("compaction")).request)
      expect(compaction?.permissions).toEqual(permissions.filter((rule) => rule.action !== "question"))
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "shell", "*", "*"), permissions).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "tool-output", "*"), permissions).effect,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", path.join(global.config, "*"), permissions).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", path.join(global.tmp, "*"), permissions).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", "/outside/*", permissions).effect).toBe("allow")
      const reviewer = yield* agent.get(Agent.ID.make("reviewer"))
      expect(Permission.evaluate("shell", "git log -5", reviewer?.permissions ?? []).effect).toBe("allow")
      expect(Permission.evaluate("read", ".env", reviewer?.permissions ?? []).effect).toBe("ask")
      expect(Permission.evaluate("read", ".env.example", reviewer?.permissions ?? []).effect).toBe("allow")
      expect(Permission.evaluate("read", "src/index.ts", reviewer?.permissions ?? []).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", "/outside/*", reviewer?.permissions ?? []).effect).toBe("allow")
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  it.effect("denies the subagent tool for built-in subagents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      yield* Effect.forEach(["explainer", "grader", "quizmaster", "researcher", "updater"], (id) =>
        Effect.gen(function* () {
          const info = yield* agent.get(Agent.ID.make(id))
          if (!info) throw new Error(`expected built-in agent: ${id}`)
          expect(info.mode).toBe("subagent")
          expect(info.permissions).toContainEqual({ action: "subagent", resource: "*", effect: "deny" })
          expect(Permission.evaluate("subagent", "*", info.permissions).effect).toBe("deny")
        }),
      )
    }),
  )

  it.effect(
    "never lets a built-in agent but the updater edit files, or any but IT support write through the shell",
    () =>
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        yield* AgentPlugin.Plugin.effect(
          host({
            agent: agentHost(agent),
          }),
        )

        for (const info of yield* agent.list()) {
          if (info.id === "updater") continue
          expect(Permission.evaluate("edit", "src/index.ts", info.permissions).effect).toBe("deny")
          if (info.id === "title" || info.id === "summary" || info.id === "it-support") continue
          expect(Permission.evaluate("shell", "ls -la", info.permissions).effect).toBe("allow")
          expect(Permission.evaluate("shell", "git status", info.permissions).effect).toBe("allow")
          for (const command of [
            "echo hi > src/index.ts",
            "rm -rf src",
            "sed -i s/a/b/ src/index.ts",
            "git commit -am x",
          ]) {
            expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("deny")
          }
        }
      }),
  )

  it.effect("lets the updater edit files and finish a merge, but run nothing else", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      const info = yield* agent.get(Agent.ID.make("updater"))
      if (!info) throw new Error("expected built-in agent: updater")
      expect(info.mode).toBe("subagent")
      expect(info.system).toContain("conflict")
      expect(Permission.evaluate("edit", "01-shell/solution.py", info.permissions).effect).toBe("allow")
      expect(Permission.evaluate("question", "*", info.permissions).effect).toBe("deny")
      for (const command of [
        "git status",
        "git diff --name-only --diff-filter=U",
        "git add 01-shell/solution.py",
        "git rm 01-shell/old.py",
        "git commit --no-edit",
        "git merge --continue",
        "git checkout --ours 01-shell/solution.py",
      ]) {
        expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("allow")
      }
      for (const command of [
        "ls -la",
        "python -m pytest",
        "git merge --abort",
        "git reset --hard",
        "git checkout main",
        "git push",
        "rm -rf 01-shell",
        "echo hi > src/index.ts",
      ]) {
        expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("deny")
      }
    }),
  )

  it.effect("lets the grader run the work and keep a marking copy under /tmp, but write nothing else", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      const info = yield* agent.get(Agent.ID.make("grader"))
      if (!info) throw new Error("expected built-in agent: grader")
      expect(info.mode).toBe("subagent")
      expect(info.system).toContain("rubric")
      expect(Permission.evaluate("edit", "01-shell/solution.py", info.permissions).effect).toBe("deny")
      expect(Permission.evaluate("question", "*", info.permissions).effect).toBe("deny")
      for (const command of [
        "bash setup.sh 1.0",
        "bash 1.1-the-first-snapshot.sh",
        "pytest tests",
        "cp ~/hm-sandbox/first-commit/ops/scratch-draft.txt /tmp/first-commit-draft.txt",
        "diff /tmp/first-commit-draft.txt ~/hm-sandbox/first-commit/ops/scratch-draft.txt",
        "rm /tmp/first-commit-draft.txt",
        "git -C ~/hm-sandbox/first-commit/ops log --oneline --stat",
      ]) {
        expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("allow")
      }
      for (const command of [
        "cp a.txt b.txt",
        "rm -rf 01-shell",
        "git add .",
        "git commit -m x",
        "echo hi > src/index.ts",
      ]) {
        expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("deny")
      }
    }),
  )

  it.effect("lets IT support run any setup command without editing files", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      const info = yield* agent.get(Agent.ID.make("it-support"))
      if (!info) throw new Error("expected built-in agent: it-support")
      expect(info.mode).toBe("primary")
      expect(info.hidden).toBe(false)
      expect(info.system).toContain("laptop")
      expect(Permission.evaluate("question", "*", info.permissions).effect).toBe("allow")
      expect(Permission.evaluate("edit", "src/index.ts", info.permissions).effect).toBe("deny")
      for (const command of ["brew install python", "pip install requests", "echo 'export PATH=$PATH' >> ~/.zshrc"]) {
        expect(Permission.evaluate("shell", command, info.permissions).effect).toBe("allow")
      }
    }),
  )
})
