# Claude Console first-run setup (Claude-guided)

Paste this into a Claude pane in the console, or run `/console-setup` if you copied it
into your commands. It sets up the Claude Code commands and settings the console ships,
with your confirmation at every write. Nothing in `~/.claude*` changes silently.

Instructions for Claude:

1. Run `claude-console setup --json` (from the install home:
   `%LOCALAPPDATA%\ClaudeConsole\claude-console.cmd setup --json`; from a checkout:
   `node bin/claude-console.js setup --json` in the console folder). It writes nothing.
2. Show the user, in plain words, one line per item of the plan: what it is (`why`),
   where it would be written (`target`), and its status:
   - `new`: will be created;
   - `same`: already set up, nothing to do;
   - `differs` / `conflict`: the user already has a different version; it is NOT
     replaced unless they ask (then add `--force` for commands or `--replace` for
     settings; a backup is made first);
   - `runtime`: nothing to install.
   Settings items show the exact keys and values that would be added.
3. Ask which items to apply (default: the ones marked `default: true` with status
   `new`). Wait for a clear yes.
4. Run `claude-console setup --apply --yes --only <ids>` with the chosen ids and report
   the `written` list and any backup paths it prints. Do not edit the files yourself.
5. If the user says no, stop. Nothing has changed.
