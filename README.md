# Claude Console

Claude Console is a desktop window for [Claude Code](https://claude.com/claude-code) on
Windows. It runs your Claude Code sessions and shells side by side in tiled terminal
panes, lists the git projects on your drive with their branch and changes, and shows
each project's hand-off and progress files at a glance. It runs only on your own
computer: the server listens on 127.0.0.1, every request needs a token made at start,
and nothing is sent anywhere except one optional update check against this repo's
GitHub releases.

## Requirements

- Windows 10 or 11.
- The Claude Code CLI, for Claude panes. Not installed yet? In PowerShell:
  `irm https://claude.ai/install.ps1 | iex`. Shell panes work without it.
- Node.js 24 or newer and Git: the installer installs both for you when they are
  missing (winget, or the official installers as a fallback).
- Microsoft Edge (part of Windows) for the app window; without it the console opens
  in a normal browser tab.

## Install

Open **Windows PowerShell** and run:

```powershell
irm https://github.com/Remus3/claude-console/releases/latest/download/install.ps1 | iex
```

That one command installs Node.js and Git when needed, downloads the latest release,
checks it against the release's `SHA256SUMS.txt`, installs it to
`%LOCALAPPDATA%\Programs\claude-console`, adds **Claude Console** to the Start menu,
the Desktop and Apps & features, puts the `claude-console` command on your user PATH,
and starts the console. It takes about a minute plus the Node.js / Git downloads.
Running it again upgrades or repairs the install.
If Node.js or Git is missing and winget is unavailable, Windows will ask for permission once to install it.

### Install without running a remote script

1. From the [latest release](https://github.com/Remus3/claude-console/releases/latest)
   download `install.ps1`, `claude-console-<version>.zip` and `SHA256SUMS.txt` into one
   folder.
2. Read `install.ps1`. Then, in that folder:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Zip .\claude-console-<version>.zip
   ```

   It checks the zip against `SHA256SUMS.txt` and installs exactly as above.

Fully by hand (Node.js 24+ already installed): check the zip yourself with
`Get-FileHash .\claude-console-<version>.zip -Algorithm SHA256` against
`SHA256SUMS.txt`, extract it, and run, in the extracted `claude-console-<version>`
folder:

```powershell
node bin\claude-console.js install --repo Remus3/claude-console
```

## First run

- The console opens in its own window. Later: Start menu or Desktop, **Claude
  Console**, or `claude-console start --open` in a new terminal
  (full path: `%LOCALAPPDATA%\Programs\claude-console\claude-console.cmd`).
- The left side lists the git projects it finds directly under `C:\`. Click a project
  to open a Claude pane there; right-click for a shell pane.
- Projects somewhere else: add their parent folders as `scanRoots`, or single folders
  as `extraProjects`, in
  `%LOCALAPPDATA%\Programs\claude-console\data\console.local.json` (same shape as
  `config/console.json`; your edits there survive every update).
- Claude Code installed in an unusual place: set `"claudePath"` to the full path of
  `claude.exe` in that same file.
- Optional: `claude-console setup` shows the Claude Code commands and settings the
  console ships (a `/done` command, a status line). Nothing is written until you run
  `claude-console setup --apply --yes`.
- Every feature, in plain words: [docs/capabilities.md](docs/capabilities.md).

## Update

The console checks this repo's releases once a day (one anonymous request; turn it off
with `"updates": {"check": false}` in `console.local.json`). When a new version is out,
an **Update available** badge appears in the top bar; click it, or open Settings >
Updates & repair, to update. Your settings, layouts and local file changes are kept:
a file you changed is merged with the new version, and a clash is kept aside for you
to review. From a terminal: `claude-console update --yes`. Automatic updates inside a
night window can be turned on in Settings > Updates & repair.

## Uninstall

Apps & features > **Claude Console** > Uninstall, or in a terminal:

```powershell
claude-console uninstall
```

This removes the shortcuts, the Apps & features entry, the PATH entry and the program
files. Your settings and layouts in `%LOCALAPPDATA%\Programs\claude-console\data` stay;
`claude-console uninstall --purge` moves them to the Recycle Bin too. Node.js, Git and
Claude Code stay installed.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Claude Code CLI not found` | Install it: `irm https://claude.ai/install.ps1 \| iex`, then open a new pane. Installed elsewhere: set `"claudePath"` in `console.local.json` to the full path of `claude.exe`. |
| `Git not found` during install | The console still works; projects show without git status. Install Git (`winget install Git.Git`) and run the install command again. |
| The install stopped with a self-test failure | The output names the failing test and the error, plus the path of the full test log and the report under `%LOCALAPPDATA%\Programs\claude-console\reports`. Run the install command again after fixing the cause. |
| `claude-console` is not recognized | Open a new terminal (PATH changes reach new windows only), or use the full path `%LOCALAPPDATA%\Programs\claude-console\claude-console.cmd`. |
| The window does not open | `claude-console status` says whether the server runs; `claude-console stop`, then `claude-console start --open`. |
| `stop failed: the console server (pid N) is still running` or `uninstall incomplete: ...` | A program still holds the console open. `claude-console stop --force` ends the server; then run the uninstall again. The line names what is left. |
| Port 7800 is taken | Set `"port"` in `console.local.json` to a free port. |
| Something else is broken | `claude-console reinstall` shows a read-only report and the exact command for a repair or a fresh reinstall; your data is kept. |

## Build from source

```powershell
git clone https://github.com/Remus3/claude-console
cd claude-console
npm ci
npm test
launch.cmd
```

`launch.cmd` runs the server in the foreground; `launch.vbs` starts it hidden. Both
find Node.js on PATH, else in its standard install folder. `claude-console release
--out DIR` builds the release assets (zip, `install.ps1`, `SHA256SUMS.txt`, notes).

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). Claude Console is an
independent project and is not made by or affiliated with Anthropic. Claude and
Claude Code are trademarks of Anthropic.
