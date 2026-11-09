import type { SessionMessageAssistant } from "@opencode/client"
import { createMemo, Show } from "solid-js"
import { useData } from "../context/data"
import { Keymap } from "../context/keymap"
import { useLocation } from "../context/location"
import { useTheme } from "../context/theme"
import { SplitBorder } from "../ui/border"
import { formatReset, refusalReset, servedByConsole } from "../util/usage-limits"

/** Why a turn stopped at a usage limit or for lack of credits, and how to keep going; nothing for other errors. */
export function useLimitNotice(message: () => SessionMessageAssistant) {
  const data = useData()
  const location = useLocation()
  const shortcut = Keymap.useShortcut("model.list")
  return createMemo(() => {
    const value = message()
    const error = value.error
    if (!error) return
    const ref = location.ref ?? data.location.default()
    const reset = refusalReset(error)
    const resets = reset === undefined ? "" : `Resets ${formatReset(reset)}. `
    const name =
      data.location.model
        .list(ref)
        ?.find((item) => item.providerID === value.model.providerID && item.id === value.model.id)?.name ??
      value.model.id
    if (error.type === "provider.model-budget-limit")
      return { title: `${name} usage limit reached`, body: `${resets}Switch model with`, key: shortcut() ?? "/models" }
    if (error.type === "provider.budget-limit")
      return {
        title: "Usage limit reached",
        body: `${resets}Paid models are paused. Switch to a free model with`,
        key: shortcut() ?? "/models",
      }
    const provider = data.location.provider.list(ref)?.find((item) => item.id === value.model.providerID)
    if (error.status === 402 && servedByConsole(provider))
      return {
        title: "Your workspace is out of credits",
        body: "Paid models are paused until an admin adds credits in OpenCode Console.",
      }
    return undefined
  })
}

export function UsageLimitNotice(props: { notice: { title: string; body: string; key?: string } }) {
  const theme = useTheme()
  return (
    <box
      marginLeft={2}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.border.base}
      paddingLeft={1}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={theme.text.base}>{props.notice.title}</text>
      <text fg={theme.text.muted} wrapMode="word">
        {props.notice.body}
        <Show when={props.notice.key}>
          {(key) => (
            <>
              {" "}
              <span style={{ fg: theme.text.base }}>{key()}</span> to continue.
            </>
          )}
        </Show>
      </text>
    </box>
  )
}
