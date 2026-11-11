import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import type { CourseMap } from "@opencode/schema/course-map"
import { useTheme } from "../../context/theme"
import { Keymap } from "../../context/keymap"
import { SplitBorder } from "../../ui/border"
import { errorMessage } from "../../util/error"

export const COURSE_MAP_MODE = "form"

type Row =
  | { type: "module"; title: string; passed: number; total: number }
  | { type: "chapter"; title: string }
  | { type: "spacer" }
  | { type: "challenge"; challenge: CourseMap.Challenge; index: number }

const GLYPH = { passed: "✓", open: "○", locked: "⊘" } as const

/**
 * The course laid out as modules, chapters and challenges. Up and down move through the challenges, left and
 * right jump between modules, and enter picks the highlighted one. Locked challenges are shown but cannot be
 * picked. Replying and dismissing are left to the caller so the same view works against a fixture.
 */
export function CourseMapPrompt(props: {
  title: string
  course: CourseMap.Info
  onPick: (key: string) => Promise<void>
  onDismiss: () => Promise<void>
}) {
  const theme = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const keymap = Keymap.use()
  const [error, setError] = createSignal("")

  const challenges = createMemo(() => props.course.modules.flatMap((module) => module.challenges))
  const rows = createMemo(() => {
    let index = 0
    return props.course.modules.flatMap((module, position): Row[] => [
      ...(position === 0 ? [] : [{ type: "spacer" } satisfies Row]),
      {
        type: "module",
        title: module.title,
        passed: module.challenges.filter((challenge) => challenge.state === "passed").length,
        total: module.challenges.length,
      },
      ...module.challenges.flatMap((challenge, offset): Row[] => [
        ...(challenge.chapter !== undefined && challenge.chapter !== module.challenges[offset - 1]?.chapter
          ? [{ type: "chapter", title: challenge.chapter } satisfies Row]
          : []),
        { type: "challenge", challenge, index: index++ },
      ]),
    ])
  })
  const moduleStarts = createMemo(() => {
    let start = 0
    return props.course.modules.flatMap((module) => {
      const first = start
      start += module.challenges.length
      return module.challenges.length > 0 ? [first] : []
    })
  })

  const [selected, setSelected] = createSignal(
    Math.max(
      0,
      challenges().findIndex((challenge) => challenge.suggested),
    ),
  )
  const current = () => challenges()[selected()]

  let scroll: ScrollBoxRenderable | undefined
  createEffect(() => {
    const target = selected()
    if (!scroll || scroll.isDestroyed) return
    const line = rows().findIndex((row) => row.type === "challenge" && row.index === target)
    // Headers belong to the first challenge under them, so reveal them with it.
    let top = line
    while (top > 0 && rows()[top - 1]!.type !== "challenge") top--
    if (top < scroll.scrollTop) scroll.scrollTo(top)
    else if (line + 1 > scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(line + 1 - scroll.viewport.height)
  })

  function move(offset: number) {
    setError("")
    setSelected((value) => (value + offset + challenges().length) % challenges().length)
  }

  function jump(direction: 1 | -1) {
    setError("")
    const starts = moduleStarts()
    const here = starts.findLastIndex((start) => start <= selected())
    setSelected(starts[(here + direction + starts.length) % starts.length] ?? 0)
  }

  function pick(index = selected()) {
    const challenge = challenges()[index]
    if (!challenge) return
    if (challenge.state === "locked") {
      setError(`Locked: ${challenge.reason}`)
      return
    }
    props.onPick(challenge.key).catch((cause) => setError(errorMessage(cause)))
  }

  function dismiss() {
    props.onDismiss().catch((cause) => setError(errorMessage(cause)))
  }

  onMount(() => onCleanup(keymap.mode.push(COURSE_MAP_MODE)))

  Keymap.createLayer(() => ({
    mode: COURSE_MAP_MODE,
    commands: [
      { id: "app.exit", title: "Dismiss course map", group: "Form", run: dismiss },
      { bind: "escape", title: "Dismiss course map", group: "Form", run: dismiss },
      { bind: "up,k", title: "Previous challenge", group: "Form", run: () => move(-1) },
      { bind: "down,j", title: "Next challenge", group: "Form", run: () => move(1) },
      { bind: "left,h", title: "Previous module", group: "Form", run: () => jump(-1) },
      { bind: "right,l", title: "Next module", group: "Form", run: () => jump(1) },
      { bind: "return", title: "Pick challenge", group: "Form", run: () => pick() },
    ],
  }))

  const height = createMemo(() => Math.max(5, Math.min(rows().length, dimensions().height - 16)))
  const detail = createMemo(() => {
    const challenge = current()
    if (!challenge) return ""
    if (challenge.state === "locked") return `Locked: ${challenge.reason}`
    return [
      challenge.state === "passed" ? "Submitted and passed" : "Not submitted yet",
      ...(challenge.changed ? ["you have uncommitted changes here"] : []),
    ].join(" · ")
  })
  const glyphColor = (challenge: CourseMap.Challenge) =>
    challenge.state === "passed"
      ? theme.text.feedback.success.base
      : challenge.state === "locked"
        ? theme.text.muted
        : theme.text.base

  return (
    <box
      backgroundColor={theme.background.raised.base}
      border={["left"]}
      borderColor={theme.background.action.primary.focused}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box paddingLeft={1}>
          <text fg={theme.text.muted}>{props.title}</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            {props.course.title}
          </text>
          <text fg={theme.text.muted}>Which challenge do you want to submit?</text>
        </box>
        <scrollbox
          height={height()}
          contentOptions={{ minHeight: 0 }}
          scrollbarOptions={{ visible: false }}
          ref={(value: ScrollBoxRenderable) => (scroll = value)}
        >
          <For each={rows()}>
            {(row) => {
              if (row.type === "spacer") return <box height={1} />
              if (row.type === "module")
                return (
                  <box paddingLeft={1} flexDirection="row" gap={1}>
                    <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                      {row.title}
                    </text>
                    <text fg={theme.text.muted}>
                      {row.passed}/{row.total} passed
                    </text>
                  </box>
                )
              if (row.type === "chapter")
                return (
                  <box paddingLeft={3}>
                    <text fg={theme.text.muted}>{row.title}</text>
                  </box>
                )
              const challenge = row.challenge
              const active = () => row.index === selected()
              return (
                <box
                  paddingLeft={3}
                  flexDirection="row"
                  onMouseMove={() => setSelected(row.index)}
                  onMouseUp={() => {
                    if (renderer.getSelection()?.getSelectedText()) return
                    setSelected(row.index)
                    pick(row.index)
                  }}
                >
                  <text fg={active() ? theme.text.formfield.focused : theme.text.muted} wrapMode="none">
                    {active() ? "› " : "  "}
                  </text>
                  <text fg={glyphColor(challenge)} wrapMode="none">
                    {GLYPH[challenge.state]}{" "}
                  </text>
                  <text
                    fg={
                      active()
                        ? theme.text.formfield.focused
                        : challenge.state === "locked"
                          ? theme.text.muted
                          : theme.text.base
                    }
                    attributes={active() ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {challenge.title}
                  </text>
                  <Show when={challenge.suggested}>
                    <text fg={theme.text.muted} wrapMode="none">
                      {" "}
                      · recommended
                    </text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
        <box paddingLeft={1}>
          <text fg={theme.text.base}>{current()?.key ?? ""}</text>
          <text fg={theme.text.muted}>{detail()}</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.text.muted}>✓ passed · ○ not submitted · ⊘ locked</text>
        </box>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2} flexWrap="wrap">
          <text fg={theme.text.base}>
            {"↑↓"} <span style={{ fg: theme.text.muted }}>challenge</span>
          </text>
          <text fg={theme.text.base}>
            {"←→"} <span style={{ fg: theme.text.muted }}>module</span>
          </text>
          <text fg={theme.text.base} onMouseUp={() => pick()}>
            enter <span style={{ fg: theme.text.muted }}>pick</span>
          </text>
          <text fg={theme.text.base} onMouseUp={dismiss}>
            esc <span style={{ fg: theme.text.muted }}>dismiss</span>
          </text>
        </box>
        <Show when={error()}>
          <text fg={theme.text.feedback.error.base}>{error()}</text>
        </Show>
      </box>
    </box>
  )
}
