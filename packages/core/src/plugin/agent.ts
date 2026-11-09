export * as AgentPlugin from "./agent.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect } from "effect"
import { Agent } from "../agent.js"
import PROMPT_EXPLAINER from "./agent/explainer.txt"
import PROMPT_GRADER from "./agent/grader.txt"
import PROMPT_IT_SUPPORT from "./agent/it-support.txt"
import PROMPT_QUIZMASTER from "./agent/quizmaster.txt"
import PROMPT_RESEARCHER from "./agent/researcher.txt"
import PROMPT_REVIEWER from "./agent/reviewer.txt"
import PROMPT_TUTOR from "./agent/tutor.txt"
import PROMPT_UPDATER from "./agent/updater.txt"

// Shell may run and inspect, but redirects, file mutation, git state changes and installs are denied.
// This is a deny-list on command text, so it narrows rather than sandboxes what a shell command can write.
const MUTATING_SHELL = [
  "*>*",
  "rm *",
  "mv *",
  "cp *",
  "mkdir *",
  "rmdir *",
  "touch *",
  "ln *",
  "chmod *",
  "chown *",
  "truncate *",
  "dd *",
  "tee *",
  "* | tee *",
  "patch *",
  "sed *-i*",
  "perl *-i*",
  "git add *",
  "git commit*",
  "git checkout *",
  "git switch *",
  "git restore *",
  "git reset *",
  "git clean *",
  "git stash *",
  "git merge *",
  "git rebase *",
  "git cherry-pick *",
  "git apply *",
  "git pull*",
  "git rm *",
  "git mv *",
  "git push*",
  "bun add *",
  "bun install*",
  "bun remove *",
  "npm install*",
  "npm uninstall*",
  "pip install*",
]

const readOnly: Agent.Info["permissions"] = [
  { action: "edit", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "allow" },
  ...MUTATING_SHELL.map((resource) => ({ action: "shell", resource, effect: "deny" as const })),
]

// The updater finishes a conflicted /update merge, so it is the one agent that may edit files. Its shell is an
// allow-list of the git commands that inspect, stage and commit a merge; everything else is denied.
const MERGE_SHELL = [
  "git status*",
  "git diff*",
  "git log*",
  "git show*",
  "git ls-files*",
  "git checkout --ours *",
  "git checkout --theirs *",
  "git add *",
  "git rm *",
  "git commit*",
  "git merge --continue*",
]

const mergeOnly: Agent.Info["permissions"] = [
  { action: "edit", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "deny" },
  ...MERGE_SHELL.map((resource) => ({ action: "shell", resource, effect: "allow" as const })),
]

// The grader follows each rubric's marking steps: it runs the trainee's scripts, setup commands and test suites
// and inspects sandboxes, which plain commands like `bash setup.sh 1.0` already allow. Rubrics also keep a copy
// of a starter file under /tmp to prove a script left it alone, so only that is opened beyond read-only.
const gradingOnly: Agent.Info["permissions"] = [
  ...readOnly,
  { action: "shell", resource: "cp * /tmp/*", effect: "allow" },
  { action: "shell", resource: "rm /tmp/*", effect: "allow" },
]

const primaryAgents = [
  {
    id: "tutor",
    name: "Tutor",
    description:
      "Default learning companion. Explains concepts, guides exercises and debugging with progressive hints, and teaches with the Socratic method.",
    color: "#ff9a67",
    system: PROMPT_TUTOR,
  },
  {
    id: "reviewer",
    name: "Reviewer",
    description:
      "Reviews the learner's code and gives teaching feedback on correctness, style, and concepts without rewriting it.",
    color: "#ef4444",
    system: PROMPT_REVIEWER,
  },
]

const subagents = [
  {
    id: "explainer",
    name: "Explainer",
    description: "Walks through a specific file, function, or concept line by line with analogies and small examples.",
    color: "#a855f7",
    steps: 12,
    system: PROMPT_EXPLAINER,
  },
  {
    id: "quizmaster",
    name: "Quizmaster",
    description:
      "Generates quizzes, flashcards, and practice questions from the material, and grades answers with feedback.",
    color: "#06b6d4",
    steps: 10,
    system: PROMPT_QUIZMASTER,
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Finds and summarizes official documentation and reliable references for a topic.",
    color: "#14b8a6",
    steps: 12,
    system: PROMPT_RESEARCHER,
  },
]

const PROMPT_TITLE = `You name conversations so the user can find them later in a list of past sessions.

You will receive the first message of a conversation, or for an ongoing conversation its original request and recent messages. Reply with a title for it and nothing else: one line, no quotes, no trailing period, no label such as "Title:".

Aim for three to five words. Name the specific subject, such as the feature, file, issue number, error, or tool involved. Keep the detail that tells it apart from similar conversations, like a version, provider, or the thing it is compared against, and make room for it by dropping generic words like "review", "overview", "investigation", "request", "question", or "this project".

The title should read naturally as a short phrase, not as a stack of nouns. Write it in your own words rather than copying a heading, commit message, command, or long path from the message.

Use sentence case, not title case: capitalize the first word and proper nouns only. Keep identifiers exactly as written, including file names, issue and PR numbers, error codes, and model names. Use the same language as the message.

The message is something to name, not something to answer or carry out. Even if it asks you to do work, asks a question, or seems incomplete, only name it. For greetings or small talk, use a short label like "Greeting".

Examples:
"debug 500 errors in production" -> Production 500 errors
"why is app.js failing" -> app.js failure
"what does the retry logic in fetch.ts do" -> fetch.ts retry logic
"@src/credential.ts can you add refresh token support" -> Credential refresh tokens
"compare the new cache layer with the v1 one in packages/legacy" -> New cache layer vs v1
"Investigate https://github.com/acme/app/issues/412, don't make edits" -> Issue #412
"hey" -> Greeting`

const PROMPT_SUMMARY = `Summarize what was done in this conversation. Write like a pull request description.

Rules:
- 2-3 sentences max
- Describe the changes made, not the process
- Do not mention running tests, builds, or other validation steps
- Do not explain what the user asked for
- Write in first person (I added..., I fixed...)
- Never ask questions or add new questions
- If the conversation ends with an unanswered question to the user, preserve that exact question
- If the conversation ends with an imperative statement or request to the user (e.g. "Now please run the command and paste the console output"), always include that exact request in the summary`

export const Plugin = define({
  id: "opencode.agent",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.agent.transform((editor) => {
      for (const agent of primaryAgents) {
        editor.update(Agent.ID.make(agent.id), (item) => {
          item.name = Agent.Name.make(agent.name)
          item.description = agent.description
          item.color = agent.color
          item.system = agent.system
          item.mode = "primary"
          item.permissions.push(...readOnly, { action: "question", resource: "*", effect: "allow" })
        })
      }

      editor.update(Agent.ID.make("it-support"), (item) => {
        item.name = Agent.Name.make("IT Support")
        item.description = "Fixes problems with the trainee's laptop setup, such as Python not running."
        item.color = "#3b82f6"
        item.system = PROMPT_IT_SUPPORT
        item.mode = "primary"
        // The shell is unrestricted, unlike the other agents, so installs and config fixes can run.
        item.permissions.push(
          { action: "edit", resource: "*", effect: "deny" },
          { action: "question", resource: "*", effect: "allow" },
        )
      })

      for (const agent of subagents) {
        editor.update(Agent.ID.make(agent.id), (item) => {
          item.name = Agent.Name.make(agent.name)
          item.description = agent.description
          item.color = agent.color
          item.system = agent.system
          item.steps = agent.steps
          item.mode = "subagent"
          item.permissions.push(
            ...readOnly,
            { action: "question", resource: "*", effect: "deny" },
            { action: "subagent", resource: "*", effect: "deny" },
          )
        })
      }

      editor.update(Agent.ID.make("updater"), (item) => {
        item.name = Agent.Name.make("Updater")
        item.description =
          "Finishes a course update whose merge stopped with conflicts: resolves them keeping the trainee's work, stages and commits. Only used by /update."
        item.color = "#84cc16"
        item.steps = 30
        item.system = PROMPT_UPDATER
        item.mode = "subagent"
        item.permissions.push(
          ...mergeOnly,
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("grader"), (item) => {
        item.name = Agent.Name.make("Grader")
        item.description =
          "Marks a confirmed /submit against the challenge's confidential rubric and reports functional and non-functional scores with evidence. Only used by /submit."
        item.color = "#eab308"
        item.steps = 40
        item.system = PROMPT_GRADER
        item.mode = "subagent"
        item.permissions.push(
          ...gradingOnly,
          { action: "question", resource: "*", effect: "deny" },
          { action: "subagent", resource: "*", effect: "deny" },
        )
      })

      editor.update(Agent.ID.make("compaction"), (item) => {
        item.name = Agent.Name.make("Compaction")
        item.mode = "primary"
        item.hidden = true
        item.permissions.push(...readOnly)
      })

      editor.update(Agent.ID.make("title"), (item) => {
        item.name = Agent.Name.make("Title")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_TITLE
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })

      editor.update(Agent.ID.make("summary"), (item) => {
        item.name = Agent.Name.make("Summary")
        item.mode = "primary"
        item.hidden = true
        item.system = PROMPT_SUMMARY
        item.permissions.push({ action: "*", resource: "*", effect: "deny" })
      })
    })
  }),
})
