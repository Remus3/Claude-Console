# Privacy

## The statement

Claude Console never sends your data to its author or to anyone else. That covers your
files, prompts, pane output, settings, secrets, machine details and how you use the
console. There is no telemetry, no analytics and no automatic crash upload, and there
never will be: "no telemetry" is one of the setup profile's locked safety floors.

The console makes exactly two kinds of network call, plus one you can turn on:

1. **The update check and download.** Once a day it asks this project's GitHub
   releases whether a newer version exists. The request carries nothing about you. When
   you update, it downloads the release from GitHub. You can turn the check off with
   `"updates": {"check": false}` in `data\console.local.json`.
2. **Actions you start yourself.** For example an install step that fetches Node.js or
   Git, or a button that opens a GitHub issue page or claude.ai. Those pages open in
   your browser after your click; the console process itself does not contact them.
3. **API spend, only if you turn it on.** Settings > API keys and credits has a box,
   off by default, that reads your own organization's month-to-date API spend from
   api.anthropic.com with an Admin key you keep in a user environment variable. The
   key stays in the console's server process; the page shows numbers only.

Everything else stays on your computer. The console's server listens on 127.0.0.1 only
and every request needs a token made at start. The panes, and the optional proxy for
background runs that you configure yourself, talk over 127.0.0.1 too.

Claude Code itself talks to Anthropic as it always does; the console does not change
that, add to it or read it.

## Allowed hosts

| Host | Why |
|---|---|
| `api.github.com` | the release list (update check) |
| `github.com` | the release download, and the issue page opened in your browser |
| `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | where GitHub serves release files |
| `claude.ai` | the help chat, opened in your browser after a click |
| `api.anthropic.com` | OFF by default. Only after you tick "Read this month's API spend" in Settings > API keys and credits, and only with an Admin key in `CLAUDE_CONSOLE_<ACCOUNT>_API_KEY`: the month-to-date cost report, shown as numbers. While off, no key is read and the policy refuses this host. |
| `127.0.0.1`, `localhost`, `::1` | the console's own server, panes and your local proxy |

The list lives in `installer/egress.json`.

## How it is enforced

- A static test reads every shipped `.js`, `.ps1` and `.cmd` file for network code
  (HTTP, sockets, `fetch`, web requests, URL literals). Every hit must be listed in
  `egress.json` with its file, host and reason. A new hit or a new host fails the
  build.
- A runtime test replaces every network function with a recorder that refuses, then
  drives the server, a profile apply, an adoption scan and the setup wizard. Every
  recorded attempt must be to 127.0.0.1, apart from one update check when updates are
  on. With an Admin key set and the API spend box off, it records no outside attempt;
  with the box on, the only outside host is api.anthropic.com.
- The release is also tested in Windows Sandbox with networking turned off: setup,
  adoption and the wizard all complete, and the only thing that reports a problem is the
  update check, which says `offline`.
- The build fails if an analytics or crash-upload library appears among the
  dependencies.

## Crash reports and help texts

A crash report (Settings, **Report a problem**, or `claude-console crash-report`) and a
browser help text (**Get help in the browser**) are built on your machine and shown to
you in full before anything happens. They contain versions, the failing step and the
console's own recent log lines. Your user name, host name, home paths, e-mail addresses
and anything shaped like a token or key are replaced first, and a second pass refuses
the text if any of them is still there. Pane output, prompts, transcripts, hand-off
files, memory, machine-profile data, environment variable values and settings values
are never included. Nothing is sent: you choose to open an issue page, hand the text to
a local Claude pane, or save it to a file.

## Data the console keeps

Everything the console stores is in its own folders on your computer:

- `data\` in the install folder: your settings, layouts, the setup profile's selection,
  backups and undo journals;
- `data\profile\secrets\`: keys you entered, protected with Windows DPAPI for your user
  only and never written in plain text;
- `data\machine\`, only if you turn on the machine profile: the local scan and advice.
  You can view and delete it from the console, and it is never exported or reported.

`claude-console uninstall --purge` moves the data folder to the Recycle Bin.
