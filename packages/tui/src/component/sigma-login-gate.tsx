import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, Match, onCleanup, onMount, Show, Switch, type ParentProps } from "solid-js"
import { openUrl } from "@opencode/util/open"
import { useExit } from "../context/exit"
import { useTuiPaths } from "../context/runtime"
import { useTheme } from "../context/theme"
import { Link } from "../ui/link"
import { errorMessage } from "../util/error"
import {
  ALLOWED_EMAIL_DOMAIN,
  completeDeviceLogin,
  restore,
  sessionFile,
  startDeviceLogin,
  type DeviceCode,
  type Settings,
} from "../sigma-auth"
import { Spinner } from "./spinner"

type State =
  | { type: "checking" }
  | { type: "waiting"; code: DeviceCode }
  | { type: "error"; message: string }
  | { type: "authenticated"; email: string }

// Blocks the app until the user signs in through Auth0 with a verified Sigma Labs email address.
export function SigmaLoginGate(props: ParentProps<{ settings: Settings | undefined }>) {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()
  const exit = useExit()
  const config = props.settings
  const file = sessionFile(useTuiPaths().state)
  const [state, setState] = createSignal<State>(
    !config || process.env.OPENCODE_DRIVE ? { type: "authenticated", email: "" } : { type: "checking" },
  )
  const abort = { controller: new AbortController() }

  const begin = () => {
    if (!config) return
    abort.controller.abort()
    const controller = new AbortController()
    abort.controller = controller
    const update = (next: State) => {
      if (!controller.signal.aborted) setState(next)
    }
    update({ type: "checking" })
    restore(config, file)
      .then(async (email) => {
        if (email) return email
        const code = await startDeviceLogin(config)
        update({ type: "waiting", code })
        return completeDeviceLogin(config, file, code, controller.signal)
      })
      .then((email) => update({ type: "authenticated", email }))
      .catch((error) => update({ type: "error", message: errorMessage(error) }))
  }

  onMount(() => {
    if (state().type === "checking") begin()
  })
  onCleanup(() => abort.controller.abort())

  useKeyboard((event) => {
    const current = state()
    if (current.type === "authenticated") return
    if ((event.ctrl && event.name === "c") || event.name === "q" || event.name === "escape") return exit()
    if (event.name !== "return") return
    if (current.type === "waiting")
      return void openUrl(current.code.verification_uri_complete ?? current.code.verification_uri).catch(() => {})
    if (current.type === "error") return begin()
  })

  return (
    <Show when={state().type !== "authenticated"} fallback={props.children}>
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={theme.background.base}
        alignItems="center"
        justifyContent="center"
      >
        <box width={64} maxWidth="90%" flexDirection="column" gap={1}>
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Sign in to SigmaBot
          </text>
          <text fg={theme.text.muted} wrapMode="word">
            SigmaBot is only available to Sigma Labs. Sign in with your @{ALLOWED_EMAIL_DOMAIN} account to continue.
          </text>
          <Switch>
            <Match when={state().type === "checking"}>
              <Spinner color={theme.text.muted}>Checking your sign-in…</Spinner>
            </Match>
            <Match when={waiting(state())}>
              {(current) => (
                <box flexDirection="column" gap={1}>
                  <box flexDirection="column">
                    <text fg={theme.text.muted}>1. Open this link (press Enter to open it in your browser)</text>
                    <Link
                      href={current().code.verification_uri_complete ?? current().code.verification_uri}
                      fg={theme.text.base}
                    >
                      {current().code.verification_uri_complete ?? current().code.verification_uri}
                    </Link>
                  </box>
                  <box flexDirection="column">
                    <text fg={theme.text.muted}>2. Confirm this code matches</text>
                    <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
                      {current().code.user_code}
                    </text>
                  </box>
                  <Spinner color={theme.text.muted}>Waiting for you to sign in…</Spinner>
                </box>
              )}
            </Match>
            <Match when={failed(state())}>
              {(current) => (
                <box flexDirection="column" gap={1}>
                  <text fg={theme.text.feedback.error.base} wrapMode="word">
                    {current().message}
                  </text>
                  <text fg={theme.text.muted} wrapMode="word">
                    Press Enter to try again. If your browser is signed in to another account, sign out of it first.
                  </text>
                </box>
              )}
            </Match>
          </Switch>
          <text fg={theme.text.muted}>Press q to quit.</text>
        </box>
      </box>
    </Show>
  )
}

function waiting(state: State) {
  return state.type === "waiting" ? state : undefined
}

function failed(state: State) {
  return state.type === "error" ? state : undefined
}
