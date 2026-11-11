export * as SigmaBotMemoryPlugin from "./sigmabot-memory.js"

import { ToolFailure } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { DateTime, Effect, Schema, Semaphore } from "effect"
import { InstructionMemories } from "../instructions/memories.js"
import { Location } from "../location.js"

const MemoryInput = Schema.Struct({
  memory: Schema.String,
})

export const Plugin = define({
  id: "sigmabot.memory",
  effect: Effect.fn(function* (ctx) {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const file = InstructionMemories.filepath(location.project.directory)
    // Saves read then rewrite the file, and a model can call the tools in parallel within one step.
    const lock = Semaphore.makeUnsafe(1)

    const read = fs.readFileStringSafe(file).pipe(
      Effect.map((content) => content ?? ""),
      Effect.mapError(
        (error) => new ToolFailure({ message: `${InstructionMemories.FILE} could not be read: ${error.message}` }),
      ),
    )
    const write = (content: string) =>
      fs
        .writeWithDirs(file, content)
        .pipe(
          Effect.mapError(
            (error) =>
              new ToolFailure({ message: `${InstructionMemories.FILE} could not be written: ${error.message}` }),
          ),
        )

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "memory_save",
        description: `Saves one durable note about the learner to ${InstructionMemories.FILE}, which is kept with the project and read at the start of every session. Call it on your own judgement when you learn something worth remembering: goals, background, strengths, recurring struggles, learning preferences, corrected misconceptions. Write one short sentence. Never save secrets or sensitive personal details.`,
        input: MemoryInput.annotate({ description: "One short sentence about the learner." }),
        execute: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const date = DateTime.formatIso(yield* DateTime.now).slice(0, 10)
              const result = InstructionMemories.add(yield* read, input.memory, date)
              if (result.type === "empty") return yield* new ToolFailure({ message: "The memory was empty." })
              if (result.type === "duplicate")
                return { content: "That is already remembered.", metadata: { saved: false } }
              if (result.type === "full")
                return yield* new ToolFailure({
                  message: `${InstructionMemories.FILE} is full. Remove outdated or minor entries with memory_forget, then save again.`,
                })
              yield* write(result.content)
              return { content: "Remembered.", metadata: { saved: true } }
            }),
          ),
      })
      editor.add({
        name: "memory_forget",
        description: `Removes an outdated or wrong note from ${InstructionMemories.FILE}. Pass a distinctive phrase from the note; it must match exactly one entry.`,
        input: MemoryInput.annotate({ description: "A distinctive phrase from the one note to remove." }),
        execute: (input) =>
          lock.withPermit(
            Effect.gen(function* () {
              const result = InstructionMemories.forget(yield* read, input.memory)
              if (result.type === "empty") return yield* new ToolFailure({ message: "The phrase was empty." })
              if (result.type === "missing")
                return yield* new ToolFailure({ message: "No memory contains that phrase." })
              if (result.type === "ambiguous")
                return yield* new ToolFailure({
                  message: `${result.matches.length} memories contain that phrase. Use a more specific phrase:\n${result.matches.join("\n")}`,
                })
              yield* write(result.content)
              return { content: `Forgot: ${result.removed}`, metadata: { removed: true } }
            }),
          ),
      })
    })
  }),
})
