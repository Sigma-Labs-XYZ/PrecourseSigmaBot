import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { SigmaBotAccount } from "@opencode/core/plugin/sigmabot-account"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

describe("SigmaBotAccount.email", () => {
  it.live("reads the email the terminal's sign-in stored in lower case, and is undefined before then", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        expect(yield* SigmaBotAccount.email(tmp.path)).toBeUndefined()

        yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "sigma-auth.json"), "not json"))
        expect(yield* SigmaBotAccount.email(tmp.path)).toBeUndefined()

        yield* Effect.promise(() =>
          fs.writeFile(
            path.join(tmp.path, "sigma-auth.json"),
            JSON.stringify({ email: " Ada.Lovelace@SigmaLabs.co.uk ", refresh_token: "secret" }),
          ),
        )
        expect(yield* SigmaBotAccount.email(tmp.path)).toBe("ada.lovelace@sigmalabs.co.uk")
      }),
    ),
  )
})
