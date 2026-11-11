# SigmaBot Coach

SigmaBot is Sigma Labs' AI tutor. It teaches you coding concepts and best practices interactively, and it never writes your code for you. This extension puts SigmaBot next to your editor and lets it see what you are working on, so you can ask about the code in front of you without copying and pasting.

## Get started

1. Open the **SigmaBot** view in the activity bar, or run **SigmaBot: Install CLI** from the Command Palette, and confirm the install command.
2. When the install finishes, click **SigmaBot** in the status bar (or run **SigmaBot: Open**). SigmaBot opens in a terminal beside your editor.
3. Sign in with your `@sigmalabs.co.uk` email. Follow the link and code shown in the terminal.
4. Ask it anything about your code. If you are stuck it will help you work it out, and it can help you set up anything you need.

## What it does

- **Launches SigmaBot in VS Code.** A status bar button, an editor title button and the activity bar view all open SigmaBot in a terminal beside your editor. If the CLI is missing, the extension offers to install it.
- **Shares your editor with SigmaBot.** SigmaBot knows which file you have open, what you have selected and which tabs are open, so "what does this do?" and "why is this failing?" just work.
- **Gives you three coaches.** Press `Shift` + `Tab` in SigmaBot to switch between them:
  - **Tutor** (default) explains concepts and guides you through exercises and bugs with hints, so you learn to solve them yourself.
  - **Reviewer** reviews your code and gives feedback on correctness, style and concepts, without rewriting it.
  - **IT Support** fixes problems with your laptop setup, such as Python not running or errors in your terminal.

## Commands

| Command                 | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `SigmaBot: Open`        | Open SigmaBot in a terminal beside your editor.              |
| `SigmaBot: Install CLI` | Run the SigmaBot installer in a terminal, after you confirm. |

## Settings

| Setting                   | Description                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `sigmabot.installCommand` | The shell command **SigmaBot: Install CLI** runs. Defaults to the official installer. |

## Privacy

Your editor state stays on your machine. The extension runs a local server that only accepts connections from `127.0.0.1` with a per-session secret token, and only the SigmaBot CLI running on your machine can read it. The extension does not send your files anywhere itself.

## Feedback

Found a problem? [Open an issue](https://github.com/Sigma-Labs-XYZ/PrecourseSigmaBot/issues).
