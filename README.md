# SigmaBot

An education and learning harness: read-only AI agents that teach, coach, quiz and plan without editing your code.

## Development

```bash
bun install
bun run dev        # start the TUI
./dev.sh           # start the TUI with the OpenRouter key from .env (OPENROUTER_KEY=...)
bun run check      # lint and type-check
```

Run tests from a package directory (for example `packages/tui`), never from the repo root.

## Sign-in

The TUI is blocked until the user signs in through Auth0 with a verified `@sigmalabs.co.uk` email address. Sign-in uses the Auth0 device flow: SigmaBot shows a link and code, the user approves it in their browser, and the session is kept in `sigma-auth.json` in the state directory. Each launch exchanges the stored refresh token for a fresh, signature-checked ID token.

The Auth0 tenant is defined as `SIGMA_AUTH0` in [`packages/tui/src/sigma-auth.ts`](packages/tui/src/sigma-auth.ts) and can be overridden with `AUTH0_DOMAIN` and `AUTH0_CLIENT_ID` in `.env` (exported by `dev.sh` and `build.sh`). The Auth0 application must be a Native app with the Device Code and Refresh Token grants enabled.

## Agents

Agents are built into the product ([`packages/core/src/plugin/agent.ts`](packages/core/src/plugin/agent.ts), prompts in [`packages/core/src/plugin/agent/`](packages/core/src/plugin/agent)), so they are available from any directory. The upstream `build`, `plan`, `general` and `explore` agents are gone. No agent can edit files, and shell commands that write to the project are denied; the one exception is the `updater` subagent, which `/update` uses to finish a conflicted merge and whose shell is limited to the git commands that do so. A project or global config can still add or override agents by ID.

| Agent             | Mode     | Purpose                                                                                                        |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `tutor` (default) | primary  | Explains concepts, guides exercises and debugging with hints, and teaches with the Socratic method.            |
| `it-support`      | primary  | Fixes the trainee's laptop setup with an unrestricted shell; used by `/setup`.                                 |
| `reviewer`        | primary  | Gives teaching feedback on the learner's code without rewriting it.                                            |
| `explainer`       | subagent | Walks through a file, function or concept line by line.                                                        |
| `quizmaster`      | subagent | Generates quizzes and flashcards and grades answers with feedback.                                             |
| `researcher`      | subagent | Finds and summarizes official docs and reliable references.                                                    |
| `updater`         | subagent | Resolves the conflicts of a `/update` merge, keeping the trainee's work, then commits. Only used by `/update`. |

## Commands

Slash commands are built in too ([`packages/core/src/plugin/sigmabot-commands.ts`](packages/core/src/plugin/sigmabot-commands.ts), prompts in [`packages/core/src/plugin/command/sigmabot/`](packages/core/src/plugin/command/sigmabot)).

| Command   | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/update` | Pulls the latest course content from [SelfPacedPreCourse](https://github.com/Sigma-Labs-XYZ/SelfPacedPreCourse) into the trainee's local fork. SigmaBot adds the repository as the `upstream` remote if no remote points at it, fetches, and merges its default branch into the checked-out branch with `--autostash`; the tutor then explains the result. If the merge conflicts, the tutor hands the resolution to the `updater` subagent. Running `/update` again while a merge is unfinished reports the remaining conflicts. |
| `/setup`  | Switches the conversation to the `it-support` agent and works through the course's setup guide: the closest `SETUP.md` (or `INSTALL.md`, `GETTING_STARTED.md`, also in a `docs` folder) in the current folder or above it, up to the repository root. IT Support skips steps that are already done or meant for another operating system, runs the rest, and hands anything needing a password or personal details back to the trainee.                                                                                           |
| `/submit` | Switches the conversation to the `tutor` agent and submits the trainee's work on the current challenge for grading.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/report` | Files a GitHub issue about a problem with the course content.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Course layout

`/submit` reads the course from the trainee's fork of [SelfPacedPreCourse](https://github.com/Sigma-Labs-XYZ/SelfPacedPreCourse) ([`packages/core/src/plugin/sigmabot-course.ts`](packages/core/src/plugin/sigmabot-course.ts)). Everything SigmaBot needs lives in a hidden `.course` folder, so the trainee's folders show only the work:

```
<course>/
  .course/manifest.json          the course: gates and its modules, in order
  01-shell/
    .course/manifest.json        a module (or chapter): its children, in order
    01-getting-around/           a challenge
      0.0-overview.md
      1.0-morning-walk-round.sh
      .course/
        manifest.json            tasks, test commands and where its files are
        rubric.json              what the grader marks against
        quiz-guidance.md         what the quiz is written from
```

- SigmaBot finds the course by walking up from the working directory to the nearest `.course/manifest.json` of type `course`. A challenge's key is its folder path from the course root, such as `01-shell/01-getting-around`.
- Paths in a manifest are relative to the manifest file: a child is `../01-getting-around`, a file next to `.course` is `../name`, and `rubric.json` or `quiz-guidance.md` is just the name. Task commands run with the folder that holds `.course` as the working directory, so task scripts are reported relative to it.
- A child whose folder does not exist yet (planned content) is skipped.
- `rubric.json` and `quiz-guidance.md` may be encrypted so trainees cannot read the answers. SigmaBot decrypts them in memory during `/submit` and never writes the plain text to disk; plain files work too, so content can stay readable while it is being written. An encrypted file is a text header ending in a `-----END HEADER-----` line, then the output of this command, which is also how to decrypt it with `openssl enc -d`:

  ```sh
  openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -md sha256 -a -pass pass:sigmalabs
  ```

  The password is always `sigmalabs` and is built into SigmaBot ([`sigmabot-submit.ts`](packages/core/src/plugin/sigmabot-submit.ts)). It keeps the answers out of sight while the course is worked through; it is not a secret.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). SigmaBot is built on [OpenCode](https://github.com/anomalyco/opencode); see [LICENSE](./LICENSE).
