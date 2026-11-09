import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { formatReset, refusalReset, servedByConsole } from "../../src/util/usage-limits"

const RESET = Date.UTC(2026, 10, 1)

afterEach(() => setSystemTime())

describe("util.usage-limits", () => {
  test("writes resets the way limits read", () => {
    setSystemTime(new Date(2026, 9, 24, 9))
    expect(formatReset(new Date(2026, 9, 24, 17).getTime())).toBe("5:00 PM today")
    expect(formatReset(new Date(2026, 10, 1).getTime())).toBe("Nov 1")
    expect(formatReset(new Date(2026, 9, 31, 19).getTime())).toBe("Oct 31, 7:00 PM")
  })

  test("reads when a refused request's limit resets from either error envelope", () => {
    const at = "2026-11-01T00:00:00.000Z"
    expect(
      refusalReset({
        response: { body: JSON.stringify({ type: "error", error: {}, metadata: { coverage: "all", resetsAt: at } }) },
      }),
    ).toBe(RESET)
    expect(
      refusalReset({
        response: {
          body: JSON.stringify({
            error: {
              code: 429,
              details: [{ reason: "BudgetLimitError", metadata: { coverage: "models", resetsAt: at } }],
            },
          }),
        },
      }),
    ).toBe(RESET)
    expect(refusalReset({ response: { body: "{}" } })).toBeUndefined()
  })

  test("only OpenCode Console serves the workspace's limits, not OpenCode Go or direct providers", () => {
    expect(servedByConsole({ id: "opencode", integrationID: "opencode" })).toBe(true)
    expect(servedByConsole({ id: "opencode-go", integrationID: "opencode" })).toBe(false)
    expect(servedByConsole({ id: "openai" })).toBe(false)
    expect(servedByConsole(undefined)).toBe(false)
  })
})
