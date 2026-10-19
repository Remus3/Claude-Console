# Recovery guide

This guide is for the bad day: the console misbehaves, Claude acts strangely after a
setup-profile change, or nothing starts at all. It goes from the easiest fix to the
manual one. Every step is safe to repeat, none of them needs the network, and none of
them needs Claude to be working.

Paths below use the default install folder,
`%LOCALAPPDATA%\Programs\claude-console`. If you installed elsewhere (or set
`CLAUDE_CONSOLE_HOME`), use that folder instead. "The data folder" means `data\` inside
it, and "the profile folder" means `data\profile\`.

## 1. Pick the right level

| Situation | Go to |
|---|---|
| The console runs, but something it or the profile started is misbehaving | 2. Stop everything from the console |
| The console window or server will not start | 3. The recovery script |
| Claude is broken and you want a second opinion | 4. Get help in the browser |
| PowerShell scripts cannot run at all, or the script itself fails | 5. Manual recovery |
| You only want to undo the last setup-profile change | 6. Undo one profile change |

## 2. Stop everything from the console

Open the `...` menu and choose **Stop everything...**, then confirm. From a terminal the
same thing is `claude-console stop-all --yes`. It:

1. ends the processes the console started (its panes and their child processes, and
   background Claude runs), matched by the process id and start time it recorded when
   it started them, never by program name;
2. disables, without deleting, the scheduled tasks the setup profile registered, after
   exporting each one's XML;
3. turns the profile's hooks off: it writes the marker file `HOOKS_OFF` in the profile
   folder, which every profile hook checks first, and renames the `"hooks"` key to
   `"hooks.profile-disabled"` in each settings file the profile put hooks into, so the
   hooks stay off even if a hook script is broken;
4. unsets the background-run kill-switch variable, so no new background run can start.
   Its value is kept, protected for your Windows user only, so it can be restored.

Each stop writes a record in `data\profile\stop-all\`. `claude-console resume --yes`
(or **Resume** in the console) replays the newest record in reverse and reads every
step back. Stopped panes are not restarted; open them again. Nothing the console did
not start is ever touched.

## 3. The recovery script

`recover.ps1` is a standalone Windows PowerShell 5.1 script. It needs no Node.js, no
console server and no network; it reads the profile's lock, journal and stop records
directly. You find it inside the install folder under `app\<version>\release\`, and
every release on GitHub also has it as a separate download.

Open Windows PowerShell and find it:

```powershell
$r = (Get-ChildItem "$env:LOCALAPPDATA\Programs\claude-console\app\*\release\recover.ps1" |
  Select-Object -Last 1).FullName
```

Look first. `-WhatIf` prints what would happen and changes nothing:

```powershell
powershell -ExecutionPolicy Bypass -File $r -WhatIf -Stop -DisableHooks -PauseTasks
```

Then run the parts you want:

| Switch | What it does |
|---|---|
| `-Stop` | ends the console's recorded process trees and unsets the kill-switch variable |
| `-DisableHooks` | writes `HOOKS_OFF` and renames `"hooks"` in every settings file the profile manages |
| `-PauseTasks` | disables (never deletes) the profile's scheduled tasks, XML exported first |
| `-Resume` | undoes every open stop record, newest first, back to the first snapshot |
| `-Revert last` | undoes the last profile transaction from its journal (or `-Revert <id>`) |
| `-Prompt` | writes a scrubbed help text, copies it and opens claude.ai (see 4) |

For example, the full stop is:

```powershell
powershell -ExecutionPolicy Bypass -File $r -Stop -DisableHooks -PauseTasks
```

The script uses the default folders. Add `-InstallDir`, `-DataDir` or `-ConfigDir`
(your Claude settings folder, normally `%USERPROFILE%\.claude`) if yours differ. A
missing data folder means there is nothing to undo, and the script says so.

## 4. Get help in the browser

When Claude itself does not work, a fresh chat at claude.ai can still help. In the
console use the `...` menu, **Get help in the browser**; from a terminal
`claude-console recover-prompt --yes`; with the console down `recover.ps1 -Prompt`.
Each builds one self-contained text with what is wrong, your versions, the settings
key names and hooks list (values masked), the last profile transactions and the exact
undo steps. User names, host names, home paths and token-shaped strings are replaced
before you see it. The text is copied to the clipboard and claude.ai opens in your
browser; paste it into a new chat. The console itself sends nothing.

## 5. Manual recovery

Use this when neither the console nor the script can run. You need File Explorer, Task
Scheduler and the Windows environment variable editor; nothing else.

### 5.1 Stop the processes

Open Task Manager, Details tab. End `node.exe` processes whose command line contains
`claude-console`, and the `claude.exe` processes the console started. If you are unsure
which `claude.exe` belongs to the console, sign out of Windows and back in instead:
that ends every console process and nothing else is lost.

### 5.2 Turn the profile's hooks off

1. In the profile folder, create an empty text file named `HOOKS_OFF` (no extension).
   Every profile hook exits quietly while it exists.
2. If a hook script is itself broken, also open each settings file the profile manages
   in a text editor and rename the top-level key `"hooks"` to `"hooks.profile-disabled"`.
   The files are your Claude settings (`%USERPROFILE%\.claude\settings.json`) and
   `.claude\settings.json` in each project you applied the profile to. The list of
   projects is in `data\profile\targets.json`.
3. To turn the hooks on again later, delete `HOOKS_OFF` and rename the key back.

### 5.3 Pause the scheduled tasks

Open Task Scheduler, select **Task Scheduler Library**, and find the tasks whose names
start with `ClaudeProfile-`. The profile only ever creates tasks with that prefix, in
that root folder. Right-click each one and choose **Disable**. Do not delete them if
you may want them back; disabling is enough.

### 5.4 Remove or restore environment variables

Open **Edit environment variables for your account** from the Start menu. The profile
writes user variables only. The one that matters for recovery is
`CLAUDE_HEADLESS_BASE_URL`: deleting it stops every new background Claude run. Any
other variable a profile change set is listed in that change's journal (see 5.5).
Terminals opened afterwards see the change; already open ones do not.

### 5.5 Restore files from a profile change

Every apply is a transaction in `data\profile\tx\<id>\`, where the id starts with the
date and time. Inside:

- `journal.jsonl` - one line per change, in order: the file, settings key, variable,
  git setting or task, and its value before the change (or `absent`);
- `pre\` - the previous copy of every file the change replaced;
- `report.json` - whether the change completed;
- `revert.json` - present once the change has been undone.

To undo the newest change by hand, work through its `journal.jsonl` from the last line
to the first. Copy a file from `pre\` back over the current one; a file that was
`absent` before was created by the profile and can go to the Recycle Bin. Settings keys
are restored the same way, from the earlier copy of the settings file in `pre\`.

### 5.6 Git settings in a project

The profile writes only local git settings of the projects you applied it to. To turn
its git hooks off in one project, run in that project:

```powershell
git config --local --unset core.hooksPath
```

The other keys it may set start with `profile.` or `kit.` and can be listed with
`git config --local --get-regexp "^(profile|kit)\."`.

## 6. Undo one profile change

With the console working: `claude-console profile revert --last` shows what would be
undone, and `claude-console profile revert --last --apply --yes` does it. Use
`--tx <id>` for an older change. Revert restores every file byte for byte; a file you
edited after the profile wrote it is kept, flagged, and a `<file>.profile-removed` copy
with the profile's version is put beside it so you can compare.

To remove the profile entirely, `claude-console profile uninstall --all` shows the
plan and `--apply --yes` carries it out. Files the profile created go to the Recycle
Bin, never straight to deletion.

## 7. After recovery

- `claude-console profile status` shows what is applied and whether anything drifted.
- `claude-console profile verify` reads back everything the profile manages.
- If a stop is still open, `claude-console resume --yes` brings it back once the cause
  is fixed.
- Consider a crash report (Settings, **Report a problem**) so the cause gets fixed;
  you see the exact text before anything is sent.
