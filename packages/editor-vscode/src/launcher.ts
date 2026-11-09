import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  commands,
  StatusBarAlignment,
  Uri,
  ViewColumn,
  window,
  workspace,
  type ExtensionContext,
  type Webview,
} from "vscode"

const TERMINAL_NAME = "SigmaBot"
const INSTALL_TERMINAL_NAME = "SigmaBot Install"
const WELCOME_COMMANDS = ["sigmabot.install", "sigmabot.open"]

export function registerLauncher(context: ExtensionContext) {
  const item = window.createStatusBarItem(StatusBarAlignment.Left, 0)
  item.text = "$(mortar-board) SigmaBot"
  item.tooltip = "Open SigmaBot"
  item.command = "sigmabot.open"
  item.show()

  context.subscriptions.push(
    item,
    commands.registerCommand("sigmabot.open", open),
    commands.registerCommand("sigmabot.install", install),
    // Welcome views cannot show images, so the sidebar is a script-free webview that may only run the launcher commands.
    window.registerWebviewViewProvider("sigmabot.welcome", {
      resolveWebviewView(view) {
        const media = Uri.joinPath(context.extensionUri, "media")
        view.webview.options = { enableCommandUris: WELCOME_COMMANDS, localResourceRoots: [media] }
        view.webview.html = welcomeHtml(
          view.webview,
          view.webview.asWebviewUri(Uri.joinPath(media, "sigma-labs-logo.png")),
        )
      },
    }),
  )
}

function welcomeHtml(webview: Webview, logo: Uri) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 12px 20px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.4; }
    .logo { display: block; width: 100%; max-width: 220px; height: auto; margin: 4px 0 16px; }
    p { margin: 0; }
    ol { margin: 20px 0 0; padding-left: 1.4em; }
    li { margin-bottom: 18px; padding-left: 2px; }
    .hint { margin-top: 4px; color: var(--vscode-descriptionForeground); }
    .button, .button:hover { display: block; box-sizing: border-box; width: 100%; max-width: 300px; margin-top: 8px; padding: 4px 8px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; text-align: center; text-decoration: none; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .button:hover { background: var(--vscode-button-hoverBackground); }
    .button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    h2 { margin: 28px 0 8px; font-size: 1.1em; font-weight: 600; }
    .agents { margin: 12px 0 0; padding: 0; list-style: none; }
    .agents li { margin-bottom: 12px; padding-left: 10px; border-left: 3px solid var(--agent); }
    .tag { margin-left: 6px; padding: 1px 6px; border-radius: 9px; font-size: 0.85em; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
    kbd { display: inline-block; padding: 1px 5px; border: 1px solid var(--vscode-keybindingLabel-border); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); border-radius: 3px; box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow); color: var(--vscode-keybindingLabel-foreground); background: var(--vscode-keybindingLabel-background); font-family: inherit; font-size: 0.85em; line-height: 1.3; vertical-align: middle; }
  </style>
</head>
<body>
  <img class="logo" src="${logo}" alt="Sigma Labs">
  <p>Welcome to SigmaBot, Sigma Labs' AI tutor that teaches you coding concepts and best practices interactively.</p>
  <h2>Setup</h2>
  <p>Complete the following steps to get started:</p>
  <ol>
    <li>
      Install the CLI
      <a class="button" href="command:sigmabot.install">Install CLI</a>
    </li>
    <li>
      Open SigmaBot
      <a class="button" href="command:sigmabot.open">Open SigmaBot</a>
    </li>
    <li>
      Sign in with your @sigmalabs.co.uk email
      <p class="hint">Follow the link and code shown in the terminal.</p>
    </li>
    <li>
      Ask it any question about your code. If you're stuck it can help you, and it can help you set up anything you need.
    </li>
  </ol>
  <h2>Meet your coaches</h2>
  <p>SigmaBot has three coaches, each with its own job:</p>
  <ul class="agents">
    <li style="--agent: #ff9a67">
      <strong>Tutor</strong><span class="tag">Default</span>
      <p class="hint">Explains concepts and guides you through exercises and bugs with hints, so you learn to solve them yourself.</p>
    </li>
    <li style="--agent: #ef4444">
      <strong>Reviewer</strong>
      <p class="hint">Reviews your code and gives feedback on correctness, style and concepts, without rewriting it.</p>
    </li>
    <li style="--agent: #3b82f6">
      <strong>IT Support</strong>
      <p class="hint">Fixes problems with your laptop setup, such as Python not running, errors in your terminal, and other environment issues.</p>
    </li>
  </ul>
  <h2>Switching agents</h2>
  <p>Press <kbd>Shift</kbd> + <kbd>Tab</kbd> in SigmaBot to switch to the next agent in the list. After IT Support it goes back to Tutor.</p>
  <p class="hint">The current agent's name appears under the message box, and the box's border turns that agent's colour.</p>
</body>
</html>`
}

async function open() {
  const existing = window.terminals.find((terminal) => terminal.name === TERMINAL_NAME)
  if (existing) return existing.show()

  const binary = await findBinary()
  if (!binary) {
    const choice = await window.showWarningMessage("The SigmaBot CLI is not installed.", "Install")
    if (choice === "Install") await install()
    return
  }

  window
    .createTerminal({
      name: TERMINAL_NAME,
      shellPath: binary,
      cwd: workspace.workspaceFolders?.[0]?.uri.fsPath,
      location: { viewColumn: ViewColumn.Beside },
    })
    .show()
}

async function install() {
  const command = workspace.getConfiguration("sigmabot").get<string>("installCommand")?.trim()
  if (!command) return window.showErrorMessage("Set sigmabot.installCommand to install the SigmaBot CLI.")

  const choice = await window.showInformationMessage(
    "Run this command in a terminal to install the SigmaBot CLI?",
    { modal: true, detail: command },
    "Run",
  )
  if (choice !== "Run") return

  const terminal = window.createTerminal({ name: INSTALL_TERMINAL_NAME })
  terminal.show()
  terminal.sendText(command)
  window.showInformationMessage("When the install finishes, run SigmaBot: Open again.")
}

// A GUI-launched VS Code often lacks the installer's ~/.opencode/bin on PATH, so check it explicitly.
async function findBinary() {
  const candidates = ["sigmabot", join(homedir(), ".opencode", "bin", "sigmabot")]
  for (const candidate of candidates) {
    if (await runs(candidate)) return candidate
  }
  return undefined
}

function runs(binary: string) {
  return new Promise<boolean>((resolve) => {
    execFile(binary, ["--version"], { timeout: 10_000, shell: process.platform === "win32" }, (error) =>
      resolve(!error),
    )
  })
}
