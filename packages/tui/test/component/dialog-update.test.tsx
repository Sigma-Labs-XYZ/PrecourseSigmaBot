/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { DialogUpdate } from "../../src/component/dialog-update"
import { ConfigProvider } from "../../src/config"
import type { UpdateState } from "../../src/context/update-notification"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { DialogProvider } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createAppFixture } from "../fixture/app"

test("installation progress replaces checking while the update job is still pending", async () => {
  await using temporary = await tmpdir()
  const [state, setState] = createSignal<UpdateState>()
  const pending = Promise.withResolvers<string | undefined>()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <ToastProvider>
                <DialogProvider>
                  <DialogUpdate
                    check={() => pending.promise}
                    state={state}
                    skip={() => {}}
                    install={() => Promise.resolve()}
                    restart={() => {}}
                  />
                </DialogProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 80, height: 24, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Checking for updates"))
    setState({ type: "installing", version: "2.0.0" })
    await app.waitForFrame(
      (frame) =>
        frame.includes("Updating SigmaBot") &&
        frame.includes("Installing SigmaBot 2.0.0") &&
        !frame.includes("Checking"),
    )
    expect(app.captureCharFrame()).not.toContain("Skip")
    pending.reject(new Error("Update service unavailable"))
    await app.waitForFrame((frame) => frame.includes("Update service unavailable") && !frame.includes("Installing"))
  } finally {
    pending.resolve(undefined)
    app.renderer.destroy()
  }
})

test("an available update opens the upgrade prompt on launch even after it was skipped", async () => {
  await using state = await tmpdir()
  // A previous launch skipped this version.
  await mkdir(path.join(state.path, "test", "tui"), { recursive: true })
  await Bun.write(
    path.join(state.path, "test", "tui", "update-notifications.json"),
    JSON.stringify({ versions: ["client:2.0.0"] }),
  )
  await using setup = await createAppFixture({
    state: state.path,
    updater: {
      remote: false,
      subscribe: (notify) => {
        notify({ type: "available", version: "2.0.0" })
        return () => {}
      },
      check: async () => undefined,
      apply: async () => {},
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("SigmaBot 2.0.0 is available") && frame.includes("important to"))
})
