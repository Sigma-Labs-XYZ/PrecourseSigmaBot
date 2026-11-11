export * as SigmaBotCommandPlugin from "./sigmabot-commands.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { CommandInvocation } from "@opencode/plugin/effect/command"
import { define } from "@opencode/plugin/effect/plugin"
import { CourseMap } from "@opencode/schema/course-map"
import { AppProcess } from "@opencode/util/process"
import { Effect, Schema } from "effect"
import { HttpClient } from "effect/http"
import fs from "fs/promises"
import { Form } from "../form.js"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { ShellSelect } from "../shell/select.js"
import { QuestionTool } from "../tool/plugin/question.js"
import SUBMIT from "./command/sigmabot/submit.txt"
import UPDATE from "./command/sigmabot/update.txt"
import { SigmaBotAirtable } from "./sigmabot-airtable.js"
import { SigmaBotCourse } from "./sigmabot-course.js"
import { SigmaBotProgress } from "./sigmabot-progress.js"
import { SigmaBotSubmit } from "./sigmabot-submit.js"
import { SigmaBotUpdate } from "./sigmabot-update.js"

// Injected by the CLI build from SIGMABOT_RUBRIC_KEY; undefined when running from source, where the
// environment supplies it. Only needed once the course ships encrypted rubrics.
declare const SIGMABOT_RUBRIC_KEY: string | undefined
// Injected the same way from SIGMABOT_AIRTABLE_KEY. Without it, or without a GitHub fork to name the trainee,
// attempts are only kept on this laptop.
declare const SIGMABOT_AIRTABLE_KEY: string | undefined

/** The only agent allowed to read a rubric, so its plain text stays out of the trainee's conversation. */
const GRADER = "grader"

const ChallengeInput = Schema.Struct({
  challenge: Schema.String.annotate({
    description: "The challenge key (its folder path from the course root) as listed in the /submit prompt.",
  }),
})

const ChooseInput = Schema.Struct({
  argument: Schema.optionalKey(
    Schema.String.annotate({ description: "The text the trainee typed after /submit, if any." }),
  ),
})

const Score = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const RecordInput = Schema.Struct({
  challenge: ChallengeInput.fields.challenge,
  functional: Score.annotate({ description: "Functional score as a fraction, 0 to 1." }),
  nonFunctional: Score.annotate({ description: "Non-functional score as a fraction, 0 to 1." }),
  quiz: Score.annotate({ description: "Quiz score as a fraction, 0 to 1." }),
  summary: Schema.String.annotate({
    description: "One or two sentences on what failed or what was strong, for the coach dashboard.",
  }),
})

export const Plugin = define({
  id: "sigmabot.commands",
  effect: Effect.fn(function* (ctx) {
    const location = yield* Location.Service
    const processes = yield* AppProcess.Service
    const shells = yield* ShellSelect.Service
    const http = yield* HttpClient.HttpClient
    const forms = yield* Form.Service
    const permission = yield* Permission.Service
    const airtableKey =
      typeof SIGMABOT_AIRTABLE_KEY === "string" ? SIGMABOT_AIRTABLE_KEY : process.env.SIGMABOT_AIRTABLE_KEY
    const handle = airtableKey ? yield* SigmaBotAirtable.handle(processes, location.directory) : undefined
    const progress = SigmaBotProgress.make(
      ctx.storage,
      airtableKey && handle ? SigmaBotAirtable.remote(http, { token: airtableKey, handle }) : undefined,
    )
    const rubricKey = typeof SIGMABOT_RUBRIC_KEY === "string" ? SIGMABOT_RUBRIC_KEY : process.env.SIGMABOT_RUBRIC_KEY
    // The template is long instructions for the model, so it goes in as a synthetic message that the UI shows
    // as one short line instead of filling the chat.
    const send = (input: CommandInvocation, command: string, text: string) =>
      ctx.session
        .synthetic({
          sessionID: input.sessionID,
          text,
          description: `/${command} ${input.prompt.text.trim()}`.trim(),
          delivery: input.delivery,
        })
        .pipe(Effect.asVoid)

    const course = SigmaBotCourse.load(location.directory).pipe(
      Effect.flatMap((course) =>
        course
          ? Effect.succeed(course)
          : new ToolFailure({
              message: `${location.directory} is not inside a pre-course fork: no manifest.json of type "course" was found in it or above it.`,
            }),
      ),
      Effect.catchTag(
        "SigmaBotCourse.ManifestError",
        (error) =>
          new ToolFailure({ message: `The course manifest at ${error.path} could not be read: ${error.message}` }),
      ),
    )

    // Resolves a challenge the model named and refuses locked ones, so the mastery gates hold in code.
    const challenge = Effect.fn("SigmaBotCommandPlugin.challenge")(function* (reference: string) {
      const loaded = yield* course
      const found = SigmaBotCourse.find(loaded, reference)
      if (!found)
        return yield* new ToolFailure({
          message: `No challenge matches "${reference}". Use a key from the list in the /submit prompt.`,
        })
      const passed = yield* progress.passed(loaded.id)
      const status = SigmaBotCourse.status(loaded, passed).find((status) => status.challenge.key === found.key)!
      if (status.state === "locked")
        return yield* new ToolFailure({ message: `${found.key} is locked: ${status.reason}.` })
      return { course: loaded, challenge: found }
    })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "submit",
        description: "submit your work for grading",
        execute: (input) =>
          Effect.gen(function* () {
            const loaded = yield* course
            const passed = yield* progress.passed(loaded.id)
            const located = yield* SigmaBotCourse.locate(processes, loaded, { argument: input.prompt.text, passed })
            return SigmaBotCourse.describe(loaded, SigmaBotCourse.status(loaded, passed), located)
          }).pipe(
            Effect.catchTag("Tool.Error", (error) => Effect.succeed(`Status: unavailable. ${error.message}`)),
            Effect.flatMap((summary) =>
              send(
                input,
                "submit",
                fill(SUBMIT, input).replace("$SUBMISSION", () => summary),
              ),
            ),
          ),
      })
      // The agents cannot run git commands that change the repository, so the fetch and merge happen here and
      // the model only explains the outcome, delegating leftover conflicts to the updater subagent.
      editor.add({
        name: "update",
        description: "pull course fixes into your fork",
        execute: (input) =>
          SigmaBotUpdate.run(processes, { directory: location.directory }).pipe(
            Effect.flatMap((result) =>
              send(
                input,
                "update",
                fill(UPDATE, input).replace("$RESULT", () => SigmaBotUpdate.report(result)),
              ),
            ),
          ),
      })
    })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "submission_choose",
        description:
          "Shows the trainee the interactive course map, marking which challenges they have passed and which are locked, and returns the challenge key they pick. Only use during /submit, to confirm which challenge to submit.",
        input: ChooseInput,
        execute: (input, context) =>
          Effect.gen(function* () {
            yield* permission
              .assert({
                action: "question",
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })))
            const loaded = yield* course
            const passed = yield* progress.passed(loaded.id)
            const statuses = SigmaBotCourse.status(loaded, passed)
            const located = yield* SigmaBotCourse.locate(processes, loaded, {
              argument: input.argument ?? "",
              passed,
            })
            const state = yield* forms
              .ask({
                sessionID: context.sessionID,
                title: "Course map",
                metadata: { kind: CourseMap.KIND, course: SigmaBotCourse.map(loaded, statuses, located) },
                fields: [
                  {
                    key: "challenge",
                    description: "Which challenge do you want to submit?",
                    type: "string",
                    required: true,
                    custom: false,
                    default: located.guess?.key,
                    options: loaded.challenges.map((challenge) => ({ value: challenge.key, label: challenge.title })),
                  },
                ],
              })
              .pipe(Effect.orDie)
            // Same defect tunnel as the question tool: a plain dismissal ends the step instead of becoming tool output.
            if (state.status === "cancelled" && state.message !== undefined)
              return yield* new ToolFailure({ message: state.message })
            if (state.status === "cancelled") return yield* Effect.die(new QuestionTool.CancelledError())
            const key = String(state.answer.challenge)
            const picked = statuses.find((status) => status.challenge.key === key)
            if (!picked) return yield* new ToolFailure({ message: `No challenge matches "${key}".` })
            const label = `${picked.challenge.key} — "${picked.challenge.title}"`
            return {
              content:
                picked.state === "locked"
                  ? `The trainee picked ${label}, which is locked: ${picked.reason}.`
                  : picked.state === "passed"
                    ? `The trainee picked ${label}, which they have already passed.`
                    : `The trainee picked ${label}.`,
              metadata: { challenge: picked.challenge.key, state: picked.state },
            }
          }),
      })
      editor.add({
        name: "submission_prepare",
        description:
          "Starts grading a pre-course challenge once the trainee has confirmed which one. Runs the provided tests when the challenge has them and returns the tasks, the functional result, the attempt number and the quiz guidance. Only use during /submit.",
        input: ChallengeInput,
        execute: (input) =>
          Effect.gen(function* () {
            const found = yield* challenge(input.challenge)
            const attempts = yield* progress.attempts(found.course.id, found.challenge.key)
            const shell = yield* shells.resolve({ priority: "config" })
            const functional = found.challenge.test
              ? yield* SigmaBotSubmit.tests(processes, {
                  shell,
                  directory: found.challenge.directory,
                  command: found.challenge.test,
                })
              : undefined
            const guidance = found.challenge.quiz
              ? yield* Effect.promise(() => fs.readFile(found.challenge.quiz!, "utf8").catch(() => undefined))
              : undefined
            return {
              content: [
                ...overview(found.course, found.challenge),
                `Attempt: ${attempts.length + 1}${attempts.length ? ` (previous: ${attempts.map(describeAttempt).join("; ")})` : ""}`,
                "",
                ...tasks(found.challenge),
                "",
                ...(functional
                  ? [
                      `Functional tests: ${functional.command}`,
                      `Exit code: ${functional.exitCode ?? "none"}; passed ${functional.passed}, failed ${functional.failed}; score ${percent(functional.score)}`,
                      "Test output:",
                      functional.output.trim() || "(no output)",
                    ]
                  : [
                      "Functional tests: none provided. The grader marks the functional gate from the rubric as well as the non-functional gate.",
                    ]),
                "",
                "Quiz guidance:",
                guidance?.trim() ||
                  "(none provided; write a short quiz on the trainee's own work and the ideas it uses)",
              ].join("\n"),
              metadata: { challenge: found.challenge.key, attempt: attempts.length + 1, functional: functional?.score },
            }
          }),
      })
      editor.add({
        name: "submission_rubric",
        description:
          "Returns the marking rubric for a pre-course challenge, with its tasks and commands. Only the grader agent may call it.",
        input: ChallengeInput,
        execute: (input, context) =>
          Effect.gen(function* () {
            if (context.agent !== GRADER)
              return yield* new ToolFailure({
                message: `Only the ${GRADER} agent may read a rubric. Delegate grading with the subagent tool.`,
              })
            const found = yield* challenge(input.challenge)
            const rubric = yield* SigmaBotSubmit.rubric(found.challenge, rubricKey).pipe(
              Effect.mapError((error) => new ToolFailure({ message: error.message })),
            )
            return {
              content: [
                ...overview(found.course, found.challenge),
                "",
                ...tasks(found.challenge),
                "",
                "Rubric:",
                rubric,
              ].join("\n"),
              metadata: { challenge: found.challenge.key },
            }
          }),
      })
      editor.add({
        name: "submission_record",
        description:
          "Records the result of a graded pre-course submission after all three gates have been marked. Works out whether the attempt passed from the course gates and returns the verdict. Only use during /submit, once per attempt.",
        input: RecordInput,
        execute: (input) =>
          Effect.gen(function* () {
            const found = yield* challenge(input.challenge)
            const gates = found.course.gates
            const quizGate = gates.quiz ?? SigmaBotSubmit.DEFAULT_QUIZ_GATE
            const passed =
              input.functional >= gates.functional &&
              input.nonFunctional >= gates.nonFunctional &&
              input.quiz >= quizGate
            const recorded = yield* progress.record({
              course: { id: found.course.id, version: found.course.version },
              challenge: {
                key: found.challenge.key,
                title: found.challenge.title,
                module: found.challenge.module.id,
              },
              functional: input.functional,
              nonFunctional: input.nonFunctional,
              quiz: input.quiz,
              passed,
              summary: input.summary,
            })
            return {
              content: [
                `Attempt ${recorded.attempt} at ${found.challenge.key} recorded${recorded.synced ? "" : " on this laptop only (Airtable could not be reached, so coaches cannot see it yet)"}.`,
                `Verdict: ${passed ? "passed" : "not passed yet"}`,
                `Functional: ${percent(input.functional)} (needs ${percent(gates.functional)})`,
                `Non-functional: ${percent(input.nonFunctional)} (needs ${percent(gates.nonFunctional)})`,
                `Quiz: ${percent(input.quiz)} (needs ${percent(quizGate)})`,
              ].join("\n"),
              metadata: { challenge: found.challenge.key, attempt: recorded.attempt, synced: recorded.synced, passed },
            }
          }),
      })
    })
  }),
})

function fill(template: string, input: CommandInvocation) {
  return template.replaceAll("$ARGUMENTS", () => input.prompt.text.trim())
}

function overview(course: SigmaBotCourse.Course, challenge: SigmaBotCourse.Challenge) {
  return [
    `Challenge: ${challenge.key} — "${challenge.title}"`,
    `Module: ${challenge.module.title}${challenge.chapter ? ` › ${challenge.chapter.title}` : ""}`,
    `Folder: ${challenge.directory} (run every command from here)`,
    ...(challenge.sandbox ? [`Sandbox: ${challenge.sandbox}`] : []),
    `Course gates: functional ${percent(course.gates.functional)}, non-functional ${percent(course.gates.nonFunctional)}, quiz ${percent(course.gates.quiz ?? SigmaBotSubmit.DEFAULT_QUIZ_GATE)}`,
  ]
}

function tasks(challenge: SigmaBotCourse.Challenge) {
  return [
    `Tasks (${challenge.tasks.length}):`,
    ...challenge.tasks.map((task) =>
      [
        `- ${task.id} "${task.title}"`,
        task.script ? `file ${task.script}` : undefined,
        task.setup ? `setup: ${task.setup}` : undefined,
        task.run ? `run: ${task.run}` : undefined,
        task.test ? `test: ${task.test}` : undefined,
      ]
        .filter(Boolean)
        .join("; "),
    ),
  ]
}

function describeAttempt(attempt: SigmaBotProgress.Attempt) {
  return `${attempt.at.slice(0, 10)} functional ${percent(attempt.functional)}, non-functional ${percent(attempt.nonFunctional)}, quiz ${percent(attempt.quiz)}, ${attempt.passed ? "passed" : "not passed"}`
}

function percent(score: number | undefined) {
  return score === undefined ? "n/a" : `${Math.round(score * 100)}%`
}
