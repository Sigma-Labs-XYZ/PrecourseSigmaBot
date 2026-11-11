import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { Location } from "@opencode/core/location"
import { InstructionMemories } from "@opencode/core/instructions/memories"
import { SigmaBotMemoryPlugin } from "@opencode/core/plugin/sigmabot-memory"
import { AbsolutePath } from "@opencode/core/schema"
import { Tool } from "@opencode/core/tool"
import type { Info } from "@opencode/schema/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { FSUtil } from "@opencode/util/fs-util"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"
import { host } from "./plugin/host"

const it = testEffect(Layer.mergeAll(LayerNode.compile(FSUtil.node)))

const boot = Effect.fn(function* (directory: string) {
  const tools = new Map<string, Info>()
  yield* SigmaBotMemoryPlugin.Plugin.effect(
    host({
      tool: {
        list: () => Effect.die("unused tool.list"),
        reload: () => Effect.die("unused tool.reload"),
        hook: () => Effect.die("unused tool.hook"),
        transform: (callback) =>
          Effect.sync(() => {
            callback({
              list: () => [],
              get: () => undefined,
              namespace: () => {},
              add: (tool) => void tools.set(tool.name, tool),
              update: () => {},
              remove: () => {},
            })
            return { dispose: Effect.void }
          }),
      },
    }),
  ).pipe(
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )
  const context: Tool.Context = {
    sessionID: Session.ID.make("ses_memory"),
    agent: Agent.ID.make("tutor"),
    messageID: SessionMessage.ID.make("msg_memory"),
    id: Tool.CallID.make("call_memory"),
    progress: () => Effect.void,
  }
  const call = (name: string, memory: string) =>
    (tools.get(name)!.execute({ memory }, context) as Effect.Effect<Tool.Result, Tool.Error>).pipe(
      Effect.map((result) => String(result.content)),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed(`ERROR: ${error.message}`)),
    )
  return { tools, call }
})

const memories = (directory: string) => fs.readFile(path.join(directory, ".coach", "MEMORIES.md"), "utf8")

describe("SigmaBotMemoryPlugin", () => {
  it.live("registers the memory tools", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const plugin = yield* boot(tmp.path)
        expect([...plugin.tools.keys()].sort()).toEqual(["memory_forget", "memory_save"])
      }),
    ),
  )

  it.live("saves notes to .coach/MEMORIES.md, skipping duplicates", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const plugin = yield* boot(tmp.path)
        expect(yield* plugin.call("memory_save", "  Prefers worked\nexamples first. ")).toBe("Remembered.")
        expect(yield* plugin.call("memory_save", "prefers worked examples first.")).toBe("That is already remembered.")
        expect(yield* plugin.call("memory_save", "Struggles with recursion.")).toBe("Remembered.")
        expect(yield* plugin.call("memory_save", "   ")).toBe("ERROR: The memory was empty.")

        const content = yield* Effect.promise(() => memories(tmp.path))
        expect(content).toMatch(
          /^# Learner memories\n\n.*\n\n- \d{4}-\d{2}-\d{2}: Prefers worked examples first\.\n- \d{4}-\d{2}-\d{2}: Struggles with recursion\.\n$/,
        )
      }),
    ),
  )

  it.live("serialises parallel saves so none are lost", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const plugin = yield* boot(tmp.path)
        yield* Effect.all(
          ["one", "two", "three", "four"].map((note) => plugin.call("memory_save", note)),
          { concurrency: "unbounded" },
        )
        const content = yield* Effect.promise(() => memories(tmp.path))
        expect(content.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(4)
      }),
    ),
  )

  it.live("forgets exactly one matching note", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const plugin = yield* boot(tmp.path)
        yield* plugin.call("memory_save", "Likes Python.")
        yield* plugin.call("memory_save", "Likes shell scripting.")
        expect(yield* plugin.call("memory_forget", "likes")).toContain("2 memories contain that phrase")
        expect(yield* plugin.call("memory_forget", "rust")).toBe("ERROR: No memory contains that phrase.")
        expect(yield* plugin.call("memory_forget", "python")).toMatch(/^Forgot: - \d{4}-\d{2}-\d{2}: Likes Python\.$/)
        const content = yield* Effect.promise(() => memories(tmp.path))
        expect(content).not.toContain("Python")
        expect(content).toContain("Likes shell scripting.")
      }),
    ),
  )

  it.live("refuses to grow past the size cap", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const plugin = yield* boot(tmp.path)
        yield* plugin.call("memory_save", "a".repeat(InstructionMemories.MAX_BYTES - 200))
        expect(yield* plugin.call("memory_save", "b".repeat(400))).toContain("is full")
      }),
    ),
  )
})

describe("InstructionMemories.source", () => {
  it.live("loads the notes once per session and stays quiet when they change", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fsUtil = yield* FSUtil.Service
        const file = InstructionMemories.filepath(tmp.path)
        const source = InstructionMemories.source(fsUtil, tmp.path)
        const initial = yield* readInitial(source)
        expect(initial.text).toContain("memory_save")
        expect(initial.text).toContain("No memories saved yet.")

        yield* fsUtil.writeWithDirs(file, "# Learner memories\n\n- 2026-11-11: Likes Python.\n")
        const update = yield* readUpdate(source, initial)
        expect(update.text).toBe("")
        expect((yield* readUpdate(source, update)).changed).toBe(false)

        const next = yield* readInitial(InstructionMemories.source(fsUtil, tmp.path))
        expect(next.text).toContain("- 2026-11-11: Likes Python.")
      }),
    ),
  )
})
