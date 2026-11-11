import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import type { CourseMap } from "@opencode/schema/course-map"
import { createMemo, createSignal, Show } from "solid-js"
import { CourseMapPrompt } from "../../../routes/session/course-map"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

type Entry = readonly [key: string, title: string, chapter?: string]

const modules: readonly { title: string; entries: readonly Entry[] }[] = [
  {
    title: "Shell and Git",
    entries: [
      ["01-shell-and-git/01-the-shell/01-where-am-i", "Where am I?", "The shell"],
      ["01-shell-and-git/01-the-shell/02-reading-files", "Reading files", "The shell"],
      ["01-shell-and-git/02-git/01-first-commit", "Your first commit", "Git"],
      ["01-shell-and-git/02-git/02-branches", "Branches", "Git"],
    ],
  },
  {
    title: "Python",
    entries: [
      ["02-python/01-getting-started/01-set-up-python", "Set up Python", "Getting started"],
      ["02-python/01-getting-started/02-hello-world", "Hello, world", "Getting started"],
      ["02-python/02-the-daily-total/01-the-till-line", "The till line", "The daily total"],
      ["02-python/02-the-daily-total/02-the-whole-till", "The whole till", "The daily total"],
      ["02-python/02-the-daily-total/03-refunds", "Refunds", "The daily total"],
    ],
  },
  {
    title: "Data",
    entries: [
      ["03-data/01-csv/01-reading-a-csv", "Reading a CSV"],
      ["03-data/01-csv/02-cleaning-rows", "Cleaning rows"],
      ["03-data/01-csv/03-a-first-report", "A first report"],
    ],
  },
]

const keys = modules.flatMap((module) => module.entries.map((entry) => entry[0]))

// Each fixture is the set of challenges passed so far; everything else follows from the mastery gates.
const fixtures = [
  { name: "fresh start", passed: 0 },
  { name: "shell and git done", passed: 4 },
  { name: "mid-way through python", passed: 7 },
  { name: "course complete", passed: keys.length },
]

function build(passedCount: number, changed: ReadonlySet<string>): CourseMap.Info {
  const passed = new Set(keys.slice(0, passedCount))
  const suggested = [...changed].at(-1) ?? keys.find((key) => !passed.has(key))
  return {
    title: "Pre-course",
    modules: modules.map((module, position) => {
      const earlier = modules.slice(0, position)
      const blocker = earlier.find((other) => !other.entries.every((entry) => passed.has(entry[0])))
      return {
        title: module.title,
        challenges: module.entries.map((entry, index) => {
          const previous = module.entries[index - 1]
          const reason = blocker
            ? `the ${blocker.title} module must be complete first`
            : previous && !passed.has(previous[0])
              ? `"${previous[1]}" (${previous[0]}) must be passed first`
              : undefined
          return {
            key: entry[0],
            title: entry[1],
            state: passed.has(entry[0]) ? "passed" : reason ? "locked" : "open",
            reason: passed.has(entry[0]) ? undefined : reason,
            changed: changed.has(entry[0]),
            suggested: entry[0] === suggested,
            chapter: entry[2],
          } satisfies CourseMap.Challenge
        }),
      }
    }),
  }
}

function CourseMapStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const theme = props.context.theme
  const [fixture, setFixture] = createSignal(1)
  const [edited, setEdited] = createSignal(true)
  const [message, setMessage] = createSignal("Pick a challenge")
  const [epoch, setEpoch] = createSignal(0)
  const course = createMemo(() => {
    const passed = fixtures[fixture()]!.passed
    // The trainee has been editing the next two challenges they have not passed.
    const changed = edited() ? new Set(keys.slice(passed, passed + 2)) : new Set<string>()
    return build(passed, changed)
  })

  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        bind: "f",
        title: "Cycle progress fixture",
        group: "Storybook",
        run: () => setFixture((value) => (value + 1) % fixtures.length),
      },
      {
        bind: "e",
        title: "Toggle uncommitted changes",
        group: "Storybook",
        run: () => setEdited((value) => !value),
      },
      {
        bind: "r",
        title: "Reset",
        group: "Storybook",
        run: () => {
          setFixture(1)
          setEdited(true)
          setMessage("Pick a challenge")
          setEpoch((value) => value + 1)
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.raised.base}>
      <box flexGrow={1} />
      {/* Remounting restores the initial highlight whenever the fixture changes. */}
      <Show when={`${fixture()}-${edited()}-${epoch()}`} keyed>
        {(_) => (
          <CourseMapPrompt
            title="Course map"
            course={course()}
            onPick={async (key) => {
              setMessage(`Picked ${key}`)
            }}
            onDismiss={async () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" })}
          />
        )}
      </Show>
      <StoryFooter
        context={props.context}
        title="storybook / course map"
        details={[fixtures[fixture()]!.name, edited() ? "with uncommitted changes" : "clean"]}
        status={message()}
        controls={[
          { shortcut: "f", label: "progress" },
          { shortcut: "e", label: "uncommitted changes" },
          { shortcut: "r", label: "reset" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const courseMapStory: Story = {
  id: "course-map",
  title: "Course map",
  render: (context) => <CourseMapStory context={context} />,
}
