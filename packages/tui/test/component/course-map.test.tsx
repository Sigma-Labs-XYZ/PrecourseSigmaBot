/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import type { CourseMap } from "@opencode/schema/course-map"
import { CourseMapPrompt } from "../../src/routes/session/course-map"
import { ConfigProvider } from "../../src/config"
import { Keymap } from "../../src/context/keymap"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource, tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const course: CourseMap.Info = {
  title: "Pre-course",
  modules: [
    {
      title: "Shell",
      challenges: [
        { key: "01-shell/01-where", title: "Where am I", state: "passed", changed: false, suggested: false },
        { key: "01-shell/02-reading", title: "Reading files", state: "open", changed: true, suggested: true },
      ],
    },
    {
      title: "Python",
      challenges: [
        {
          key: "02-python/01-till",
          title: "The till",
          state: "locked",
          reason: "the Shell module must be complete first",
          changed: false,
          suggested: false,
          chapter: "The daily total",
        },
      ],
    },
  ],
}

async function render(handlers: { onPick: (key: string) => Promise<void>; onDismiss: () => Promise<void> }) {
  const temporary = await tmpdir()
  const app = await testRender(
    () => (
      <TestTuiContexts directory={temporary.path} paths={{ state: temporary.path }}>
        <ConfigProvider config={createTuiResolvedConfig()}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <Keymap.Provider>
              <CourseMapPrompt title="Course map" course={course} {...handlers} />
            </Keymap.Provider>
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 90, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  return { app, [Symbol.asyncDispose]: async () => (app.renderer.destroy(), temporary[Symbol.asyncDispose]()) }
}

test("shows every challenge with its state and starts on the recommendation", async () => {
  await using view = await render({ onPick: async () => {}, onDismiss: async () => {} })
  await view.app.waitForFrame((frame) => frame.includes("Reading files"))
  const frame = view.app.captureCharFrame()
  expect(frame).toContain("Shell 1/2 passed")
  expect(frame).toContain("Python 0/1 passed")
  expect(frame).toContain("The daily total")
  expect(frame).toContain("✓ Where am I")
  expect(frame).toContain("› ○ Reading files · recommended")
  expect(frame).toContain("⊘ The till")
  expect(frame).toContain("Not submitted yet · you have uncommitted changes here")
  expect(frame).toContain("✓ passed · ○ not submitted · ⊘ locked")
})

test("arrow keys move through the map, locked challenges refuse and open ones are picked", async () => {
  const picked: string[] = []
  const dismissed: string[] = []
  await using view = await render({
    onPick: async (key) => void picked.push(key),
    onDismiss: async () => void dismissed.push("dismissed"),
  })
  await view.app.waitForFrame((frame) => frame.includes("Reading files"))

  view.app.mockInput.pressArrow("down")
  await view.app.waitForFrame((frame) => frame.includes("› ⊘ The till") && frame.includes("Locked: the Shell module"))
  view.app.mockInput.pressEnter()
  await view.app.waitForFrame((frame) => frame.includes("Locked: the Shell module must be complete first"))
  expect(picked).toEqual([])

  view.app.mockInput.pressArrow("left")
  await view.app.waitForFrame((frame) => frame.includes("› ✓ Where am I"))
  view.app.mockInput.pressArrow("up")
  await view.app.waitForFrame((frame) => frame.includes("› ⊘ The till"))
  view.app.mockInput.pressArrow("up")
  await view.app.waitForFrame((frame) => frame.includes("› ○ Reading files"))
  view.app.mockInput.pressEnter()
  await view.app.waitForFrame(() => picked.length > 0)
  expect(picked).toEqual(["01-shell/02-reading"])

  view.app.mockInput.pressEscape()
  await view.app.waitForFrame(() => dismissed.length > 0)
})
