import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Model } from "../../model.js"
import { Provider } from "../../provider.js"

// Injected by the CLI build from SIGMABOT_OPENROUTER_KEY; undefined when running from source,
// where `dev.sh` supplies it through the environment instead.
declare const SIGMABOT_OPENROUTER_KEY: string | undefined

const providerID = Provider.ID.make("openrouter")
const modelID = Model.ID.make("anthropic/claude-haiku-5.5")

export const SigmaBotPlugin = define({
  id: "sigmabot.openrouter",
  effect: Effect.fn(function* (ctx) {
    const key =
      typeof SIGMABOT_OPENROUTER_KEY === "string"
        ? SIGMABOT_OPENROUTER_KEY
        : (process.env.SIGMABOT_OPENROUTER_KEY || process.env.OPENROUTER_KEY || (yield* Effect.promise(repoEnvKey)))
    // SigmaBot only ever talks to OpenRouter with the bundled key: every other provider, including the
    // free OpenCode tier, is disabled. Only Haiku 5.5 stays enabled on OpenRouter because the account's
    // guardrails block every other model.
    yield* ctx.provider.transform((providers) => {
      providers
        .list()
        .filter((item) => item.provider.id !== providerID)
        .forEach((item) => providers.update(item.provider.id, (provider) => void (provider.activation = "disabled")))
      if (!key || !providers.get(providerID)) return
      providers.update(providerID, (provider) => {
        provider.activation = "enabled"
        provider.settings = { ...provider.settings, apiKey: key }
      })
    })
    yield* ctx.model.transform((models) => {
      models
        .list(providerID)
        .filter((model) => model.id !== modelID)
        .forEach((model) => models.update(providerID, model.id, (draft) => void (draft.enabled = false)))
      models.update(providerID, modelID, (draft) => void (draft.enabled = true))
      models.default.set(providerID, modelID)
    })
  }),
})

// Running from source: a background service does not inherit the shell environment, so fall back to the
// repository's .env (OPENROUTER_KEY=...) instead of requiring dev.sh.
async function repoEnvKey() {
  const text = await Bun.file(new URL("../../../../../.env", import.meta.url)).text().catch(() => "")
  return text.match(/^\s*(?:export\s+)?OPENROUTER_KEY\s*=\s*["']?([^"'\s]+)/m)?.[1] ?? ""
}
