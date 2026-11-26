import type { WidthMethod } from "@opentui/core"
import { promptOffsetIndex } from "./display"

export function expandPastedTextPlaceholders(
  text: string,
  pasted: readonly { text: string; source: { text: string; start?: number } }[],
) {
  let cursor = 0
  let result = ""
  for (const part of pasted.toSorted((a, b) => (a.source.start ?? 0) - (b.source.start ?? 0))) {
    const index = text.indexOf(part.source.text, cursor)
    if (index === -1) continue
    result += text.slice(cursor, index) + part.text
    cursor = index + part.source.text.length
  }
  return result + text.slice(cursor)
}

// Editors such as VS Code type a virtualenv activation command into a freshly opened
// terminal, which lands in the composer. It must never be sent, wherever it appears.
// The injected text can land mid-typing, so the learner's next keystroke may follow
// `activate` directly (e.g. `.../bin/activateI`); no word boundary is required after it.
const VENV_ACTIVATE =
  /\s*\bsource\s+(?:"[^"\n]*\/(?:bin|Scripts)\/activate(?:\.(?:fish|csh|nu))?"|'[^'\n]*\/(?:bin|Scripts)\/activate(?:\.(?:fish|csh|nu))?'|[^\s"']*\/(?:bin|Scripts)\/activate(?:\.(?:fish|csh|nu))?)\s*/g

export function removeVenvActivateLines(text: string) {
  // Keep a line break if the command spanned one, otherwise rejoin the surrounding words with a space.
  const result = text.replace(VENV_ACTIVATE, (match) => (match.includes("\n") ? "\n" : " "))
  return result === text ? text : result.trim()
}

export function expandTrackedPastedText(
  text: string,
  ranges: { start: number; end: number; text: string }[],
  widthMethod: WidthMethod,
) {
  // Ranges expand from right to left, so indices found in the unexpanded text stay valid.
  return ranges
    .slice()
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, part) =>
        result.slice(0, promptOffsetIndex(text, part.start, widthMethod)) +
        part.text +
        result.slice(promptOffsetIndex(text, part.end, widthMethod)),
      text,
    )
}
