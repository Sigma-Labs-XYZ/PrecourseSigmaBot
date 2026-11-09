import { expect, test } from "bun:test"
import { Option } from "effect"
import { formatEditorContext } from "../../src/component/prompt"
import { decodeEditorSelection, editorSelectionKey } from "../../src/context/editor"

const range = (text: string, endCharacter: number) => ({
  text,
  selection: { start: { line: 3, character: 1 }, end: { line: 3, character: endCharacter } },
})

const decode = (value: unknown) => Option.getOrThrow(decodeEditorSelection(value))

test("decodes open files from both selection shapes", () => {
  const openFiles = ["/repo/a.ts", "/repo/b.ts"]

  expect(decode({ filePath: "/repo/a.ts", ranges: [range("", 1)], openFiles }).openFiles).toEqual(openFiles)
  expect(decode({ filePath: "/repo/a.ts", ...range("x", 2), openFiles }).openFiles).toEqual(openFiles)
  expect(decode({ filePath: "/repo/a.ts", ranges: [range("", 1)] }).openFiles).toBeUndefined()
})

test("a change in open files is a new editor context", () => {
  const first = decode({ filePath: "/repo/a.ts", ranges: [range("", 1)], openFiles: ["/repo/a.ts"] })
  const second = decode({ filePath: "/repo/a.ts", ranges: [range("", 1)], openFiles: ["/repo/a.ts", "/repo/b.ts"] })

  expect(editorSelectionKey(first)).not.toBe(editorSelectionKey(second))
})

test("lists open files in the context sent to the model", () => {
  const openFiles = ["/repo/a.ts", "/repo/b.ts"]

  expect(formatEditorContext(decode({ filePath: "/repo/a.ts", ranges: [range("", 1)], openFiles }))).toBe(
    '<system-reminder>Note: The user opened the file "/repo/a.ts". The user has these files open in their editor: "/repo/a.ts", "/repo/b.ts". This may or may not be relevant to the current task.</system-reminder>\n',
  )
  expect(formatEditorContext(decode({ filePath: "/repo/a.ts", ranges: [range("foo", 4)], openFiles }))).toContain(
    'from "/repo/a.ts". ```foo```\n\n The user has these files open in their editor: "/repo/a.ts", "/repo/b.ts". This may',
  )
})

test("leaves the context unchanged without open files", () => {
  expect(formatEditorContext(decode({ filePath: "/repo/a.ts", ranges: [range("", 1)] }))).toBe(
    '<system-reminder>Note: The user opened the file "/repo/a.ts". This may or may not be relevant to the current task.</system-reminder>\n',
  )
})
