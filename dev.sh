#!/usr/bin/env bash
# Runs SigmaBot from source with the OpenRouter and Airtable keys from .env (OPENROUTER_KEY=..., AIRTABLE_KEY=...).
# Uses a private --standalone server so the keys reach it, instead of the shared background service.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"

if [[ -z "${SIGMABOT_OPENROUTER_KEY:-}" && -f "$ROOT/.env" ]]; then
    SIGMABOT_OPENROUTER_KEY="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?OPENROUTER_KEY[[:space:]]*=[[:space:]]*["'\'']?([^"'\''[:space:]]*).*$/\2/p' "$ROOT/.env" | tail -n 1)"
fi
if [[ -z "${SIGMABOT_OPENROUTER_KEY:-}" ]]; then
    echo "Error: set OPENROUTER_KEY in $ROOT/.env (or export SIGMABOT_OPENROUTER_KEY)" >&2
    exit 1
fi
export SIGMABOT_OPENROUTER_KEY

# Airtable token that /submit uses to record attempts, from AIRTABLE_KEY in .env.
if [[ -z "${SIGMABOT_AIRTABLE_KEY:-}" && -f "$ROOT/.env" ]]; then
    SIGMABOT_AIRTABLE_KEY="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?AIRTABLE_KEY[[:space:]]*=[[:space:]]*["'\'']?([^"'\''[:space:]]*).*$/\2/p' "$ROOT/.env" | tail -n 1)"
fi
if [[ -z "${SIGMABOT_AIRTABLE_KEY:-}" ]]; then
    echo "Error: set AIRTABLE_KEY in $ROOT/.env (or export SIGMABOT_AIRTABLE_KEY)" >&2
    exit 1
fi
export SIGMABOT_AIRTABLE_KEY

# Auth0 settings from .env (AUTH0_DOMAIN, AUTH0_CLIENT_ID); empty falls back to built-in defaults.
if [[ -f "$ROOT/.env" ]]; then
    for name in AUTH0_DOMAIN AUTH0_CLIENT_ID; do
        if [[ -z "${!name:-}" ]]; then
            value="$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?'"$name"'[[:space:]]*=[[:space:]]*["'\'']?([^"'\''[:space:]]*).*$/\2/p' "$ROOT/.env" | tail -n 1)"
            [[ -n "$value" ]] && export "$name=$value"
        fi
    done
fi

cd "$ROOT"

# Kill every running SigmaBot process (source servers, installed binary, background services) so a
# stale server without the key can never be reused. Suspended processes need SIGKILL.
stale="$( (pgrep -f "$ROOT/packages/cli/src/index.ts"; pgrep -f "\.opencode/bin/sigmabot"; pgrep -x sigmabot) 2>/dev/null | grep -vx "$$" | sort -u || true)"
if [[ -n "$stale" ]]; then
    # shellcheck disable=SC2086
    kill -9 $stale 2>/dev/null || true
    sleep 1
fi
rm -f "$HOME"/.local/state/opencode/service-*.json

exec bun run dev --standalone "$@"
