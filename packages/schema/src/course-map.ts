export * as CourseMap from "./course-map.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

/** The `Form.metadata.kind` of a form that asks the trainee to pick a challenge from the course map. */
export const KIND = "course-map"

/** `passed` is the only state that counts as submitted; a failed attempt leaves a challenge `open`. */
export const State = Schema.Literals(["passed", "open", "locked"]).annotate({ identifier: "CourseMap.State" })
export type State = typeof State.Type

export const Challenge = Schema.Struct({
  key: Schema.String,
  title: Schema.String,
  state: State,
  /** Why the challenge is locked. */
  reason: optional(Schema.String),
  /** The challenge folder holds uncommitted changes. */
  changed: Schema.Boolean,
  /** The challenge the trainee most likely means. */
  suggested: Schema.Boolean,
  chapter: optional(Schema.String),
}).annotate({ identifier: "CourseMap.Challenge" })
export interface Challenge extends Schema.Schema.Type<typeof Challenge> {}

export const Module = Schema.Struct({
  title: Schema.String,
  challenges: Schema.Array(Challenge),
}).annotate({ identifier: "CourseMap.Module" })
export interface Module extends Schema.Schema.Type<typeof Module> {}

export const Info = Schema.Struct({
  title: Schema.String,
  modules: Schema.Array(Module),
}).annotate({ identifier: "CourseMap.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
