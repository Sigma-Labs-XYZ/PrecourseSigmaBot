/** A provider as the usage limits read it: its ID and the integration that serves it. */
export type LimitedProvider = { readonly id: string; readonly integrationID?: string }

/** OpenCode Console serves the model, so the workspace's limits can apply; OpenCode Go bills its own allowance. */
export function servedByConsole(provider: LimitedProvider | undefined) {
  return provider?.integrationID === "opencode" && provider.id !== "opencode-go"
}

/** When limits reset: the day, with the time unless it is midnight here, or just the time when that is today. */
export function formatReset(at: number) {
  const date = new Date(at)
  // ICU puts a narrow no-break space before AM/PM, which terminals may draw at the wrong width.
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ")
  if (date.toDateString() === new Date().toDateString()) return `${time} today`
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return date.getHours() === 0 && date.getMinutes() === 0 ? day : `${day}, ${time}`
}

/** When a refused request's limit resets: OpenCode Console names it `resetsAt` in every protocol's error envelope. */
export function refusalReset(error: { readonly response?: { readonly body: string } } | undefined) {
  const at = Date.parse(/"resetsAt"\s*:\s*"([^"]+)"/.exec(error?.response?.body ?? "")?.[1] ?? "")
  return Number.isNaN(at) ? undefined : at
}
