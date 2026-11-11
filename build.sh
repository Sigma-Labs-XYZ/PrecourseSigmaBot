#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Load from .env if available
if [[ -f "$ROOT/.env" ]]; then
    source "$ROOT/.env"
    # Map OPENROUTER_KEY to SIGMABOT_OPENROUTER_KEY if needed
    if [[ -z "${SIGMABOT_OPENROUTER_KEY:-}" && -n "${OPENROUTER_KEY:-}" ]]; then
        SIGMABOT_OPENROUTER_KEY="$OPENROUTER_KEY"
    fi
fi

if [[ -z "${SIGMABOT_OPENROUTER_KEY:-}" ]]; then
    read -r -s -p "OpenRouter API key: " SIGMABOT_OPENROUTER_KEY
    echo
fi
if [[ -z "$SIGMABOT_OPENROUTER_KEY" ]]; then
    echo "Error: an OpenRouter API key is required" >&2
    exit 1
fi
export SIGMABOT_OPENROUTER_KEY
# Auth0 settings from .env (AUTH0_DOMAIN, AUTH0_CLIENT_ID); empty falls back to built-in defaults.
export AUTH0_DOMAIN="${AUTH0_DOMAIN:-}" AUTH0_CLIENT_ID="${AUTH0_CLIENT_ID:-}"
# Optional: decrypts encrypted rubrics during /submit. Sourced from .env as SIGMABOT_RUBRIC_KEY when set.
export SIGMABOT_RUBRIC_KEY="${SIGMABOT_RUBRIC_KEY:-}"
# Airtable token that /submit uses to record attempts. Taken from AIRTABLE_KEY in .env.
SIGMABOT_AIRTABLE_KEY="${SIGMABOT_AIRTABLE_KEY:-${AIRTABLE_KEY:-}}"
if [[ -z "$SIGMABOT_AIRTABLE_KEY" ]]; then
    echo "Error: set AIRTABLE_KEY in $ROOT/.env (or export SIGMABOT_AIRTABLE_KEY)" >&2
    exit 1
fi
export SIGMABOT_AIRTABLE_KEY

case "$(uname -m)" in
    arm64|aarch64) arch=arm64 ;;
    *) arch=x64 ;;
esac
case "$(uname -s)" in
    Darwin) os=darwin ;;
    *) os=linux ;;
esac

cd "$ROOT/packages/cli"
bun run build --single

cd "$ROOT"
./install --binary "packages/cli/dist/cli-$os-$arch/bin/opencode"
