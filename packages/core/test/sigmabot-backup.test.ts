import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { SigmaBotBackupPlugin } from "@opencode/core/plugin/sigmabot-backup"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)
const here = AbsolutePath.make("/project")
const location = Location.Ref.make({ directory: here })

describe("SigmaBotBackupPlugin.source", () => {
  it.effect("lists this project's top-level chats, marking archived ones as closed", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const open = yield* session.create({ location })
      const closed = yield* session.create({ location })
      yield* session.create({ parentID: open.id })
      yield* session.create({ location: Location.Ref.make({ directory: AbsolutePath.make("/elsewhere") }) })
      yield* session.archive(closed.id)

      const chats = yield* SigmaBotBackupPlugin.source(session, here).chats
      expect(chats.map((chat) => [chat.id, chat.closed]).toSorted()).toEqual(
        [
          [open.id, false],
          [closed.id, true],
        ].toSorted(),
      )
      expect(yield* SigmaBotBackupPlugin.source(session, here).messages(open.id)).toEqual([])
    }),
  )
})
