import { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Slot } from "../../plugin/render"

function View(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()

  return (
    <Show when={dimensions().height >= 14 && dimensions().width >= 44}>
      <box
        width="100%"
        paddingTop={dimensions().height < 16 ? 0 : 1}
        paddingBottom={dimensions().height < 16 ? 0 : 1}
        paddingLeft={2}
        paddingRight={2}
        flexDirection="row"
        flexShrink={0}
        gap={2}
      >
        <Slot path="home.footer.status" />
        <box flexGrow={1} />
        <Show when={dimensions().width >= 64}>
          <box flexShrink={0}>
            <text fg={props.context.theme.text.muted}>{props.context.app.version}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.home.footer",
  setup(context) {
    // Root takeover: an external plugin replacing home.footer wins (last-
    // enabled) and this builtin shows as suppressed, not silently gone.
    // Append keeps the path open to additive plugin claims; an external
    // replace still takes the boundary over.
    context.ui.slot({ append: "home.footer", render: () => <View context={context} /> })
  },
})
