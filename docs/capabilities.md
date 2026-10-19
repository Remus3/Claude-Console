# Claude Console - what it can do

This guide lists every feature of Claude Console in plain words. Each feature says
what it does, whether it is on when you first start the console, how to turn it on
or off, and gives a short example. Sections follow the screen: left, middle, right,
top, bottom, then Settings. For the technical reference see `../README.md`.

How to read the "Default" lines:

- **On by default** - it works as soon as the console starts. The line says how to
  turn it off.
- **Off by default (opt-in)** - nothing happens until you turn it on. The line says
  where, and why you might.
- **Always on** - part of how the console works; there is nothing to switch.

Almost every switch is in **Settings** (top right). Settings are saved on this
computer only.

Two words used below:

- **pane**: one terminal box in the console, running Claude Code or a shell.
- **headless run**: a Claude run in the background with no pane, started by a
  project's own automation.

---

## 1. Start, stop and reopen

The console is a web page that runs Claude Code in terminal panes. It only works on
this computer; nothing on your network can reach it.

- **Start**: double-click the Desktop shortcut **Claude Console**. A second click
  while it runs just opens another window.
- **Close the window**: your panes keep running. Open the shortcut again to get
  them back.
- **Quit** (top right, red): stops the console and every pane. It asks first. Any
  command still running in a pane is ended; a Claude pane can be resumed later from
  its `reopen:` chip in the bottom bar.

Default: always on.

Example: you close the window by mistake in the middle of a long task. Double-click
the shortcut; the pane is still there and still working.

## 2. Projects list (left side)

Every git repository found directly under `C:\` is listed. Click a project to open
Claude Code in it. If a pane for it is already open, the click takes you there.
Shift+click always opens a new one.

- **Rescan** finds new repositories.
- **Tasks** opens the scheduled-tasks screen (section 3).
- **+ New pane** opens a dialog: project, working folder (with a folder browser),
  kind (claude or shell), account, and extra options (for example `--continue` to
  pick up the last conversation).
- Right-click a project: a new pane in that project.
- Drag projects to reorder them. The order is saved.
- **Groups**: `+ Group` at the bottom makes a named group. Drag projects onto its
  header to put them in it. Groups fold open and shut with `+` / `-`.
- **Collapse the list**: the menu button at the top left, or Ctrl+Alt+B. A thin
  strip with one status dot per project stays visible.

Default: always on.

Example: make a group called "Daily", drag your three most used projects onto it,
and fold everything else shut.

### Tools under a project

A project can carry its own shortcuts: programs, scripts, files, folders or web
pages. They show as indented rows under the project when you open it with `+`.

- **Add a tool**: click `+ Tool`, or drag a file, folder or Desktop shortcut from
  Explorer onto a project row.
- **Change a tool**: hover it and use `...` to Rename, Edit path or Remove. Remove
  only hides the entry; the file on disk is never touched.
- **Status board**: a project that has a claude.ai status board gets a
  `Status board` row. It opens the board in your normal browser.

Default: off until you add a tool. A project without tools shows no `+`.

Example: drag `notes.txt` from your Desktop onto the project row. A `notes` row
appears under the project; clicking it opens the file in Notepad.

### Sub-categories

Some projects have more than one kind of row under them, for example local model
controls, a service stack and tools. Each kind then gets its own header row with a
one-line summary and its own `+` / `-`. Its rows show only while that header is
open. Nothing shows while the project itself is folded shut. A project with only
tools keeps a plain list.

Default: always on. Which headers are open is remembered in this window.

### Remove a project from the list

Settings > Projects > Remove. You must type `DELETE PROJECT` to confirm. Only the
listing is hidden; the folder and its files are never touched. A project with open
panes cannot be removed until they are closed.

## 3. Scheduled tasks (Tasks button)

**Tasks**, next to Rescan, lists your Windows scheduled tasks (Microsoft's own are
left out).

- Tasks are grouped by the project, or the console, they run in. The list at the
  top shows one project only. **Refresh** reloads the list.
- Each row shows the trigger and the state.
- Tasks that run at boot or logon are marked: they add work to every start-up.
- "Machine facts" lists the result codes that look like errors but are not
  (still running, never run, repeat refused).

What you can change:

- **Disable** / **Enable** a task.
- **Edit** changes its trigger (time, days, repeat, delay); **Change trigger**
  saves it and **Cancel edit** leaves it as it was.
- **Remove** asks twice: the button turns into **Confirm remove** for 4 seconds.
- **Add a task**: name, folder, program (full path), arguments, start-in folder and
  a trigger (once, daily, weekly, logon or boot), then **Add task**.

Every change saves a backup of the task first and reads the task back afterwards.
If the result does not match, the change is undone.

Default: viewing is always on. Nothing changes until you click.

Example: a nightly script should run at 03:00 instead of 04:00. Click **Edit** on
its row, set the time to 03:00, click **Change trigger**.

## 4. Panes (middle)

Each pane is a real terminal. Panes tile in a grid that reflows as you open more.

- **Header**: state glyph, title, what Claude is doing (`Bash 2m`, `thinking 3m`),
  the project's running task with its progress, a badge when it needs you, and Max,
  Min and X (close). Everything else (text size A- / A+, Find, Compose, Restart,
  and the pane's kind, account and folder) is in the `...` menu.
- **Move panes**: drag a pane's title onto another pane to swap them, or onto the
  bottom bar to minimize it.
- **Your input stands out**: every line you send is marked with a tinted band, so
  you can find your own messages again.
- **Copy and paste**: select and press Ctrl+C to copy. Ctrl+C with nothing selected
  interrupts, as usual. Ctrl+V pastes.
- **Phone or narrow window**: one pane at a time; the others wait in the bottom bar.

Default: always on.

Example: double-click a pane's header to make it fill the grid; double-click again
to put it back.

## 5. The message box (composer)

Under every pane is a message box. Enter sends, Shift+Enter starts a new line, and
Alt+Up / Alt+Down bring back earlier messages.

- **Quick chips**: one-click messages under the box. The first three are
  `continue`, `/done` and `/clear`. In Settings > Quick chips you can untick a
  chip, change its text, remove it, or add your own with **+ Add chip** (up to 12).
- **Key buttons**: Esc, ^C, Enter, ^X^S, S-Tab and the four arrows send that key to
  the pane. **^X^S** is Claude Code's own "send now": it sends a message you typed
  or queued while Claude was still busy. Hide any key you never use in Settings >
  Pane key buttons.
- **Slash list**: type `/` at the start of the box to see the commands and skills
  of that project. Up / Down choose, Tab or Enter fill it in, Esc closes.
- **Attachments**: drop a file or image onto a pane, paste an image, or click
  **Attach**. The file is copied into a folder the console keeps for attachments,
  and its path goes into your message so Claude can read it. Files over 50 MB are
  refused. Attachments older than 14 days go to the Recycle Bin.

Default: on. Each chip and key can be turned off in Settings.

Example: Claude is busy and you type "also check the tests". Click **^X^S** and
Claude takes your message now instead of after its current step.

### Composer-only Claude panes

Claude Code draws its own input box and status rows at the bottom of the terminal.
The console hides them, so the message box is the only place you type. A small chip
in the pane header shows what those rows said (`2 agents . 1 shell . ctx 9%`; ctx
is how full Claude's memory of the conversation is). Hover the chip to read the
rows; click it to show or hide them in that pane. When Claude shows a menu or asks
for permission, nothing is hidden.

Default: on. Turn it off in Settings: **Composer-only claude panes: hide claude's
own input box and status rows (this window)**.

## 6. Workflow rows and the ETA clock

When a project writes progress files, the console shows them as fixed rows above
the pane's terminal and on its status card:

```
[>] build    45%  ~4m of 9m [3:42PM]  running tests
[+] docs
[x] deploy                            failed
```

- `[>]` running, `[+]` done, `[x]` failed.
- Rows never jump around: a finished task stays where it was and turns `[+]`.
- A running row whose file says when it started shows the clock: percent, minutes
  left, total minutes, and the time it should finish. Without a start time it
  shows `45%  ~4m`.
- **After /clear** the pane's rows and the project's card start fresh. Rows from
  before the clear stay out until that task writes progress again.

Settings > Pane workflow rows chooses how many rows and which states:

- **Rows shown (0 hides the strip)**: 0 to 12, default 6.
- One box per state: running, stale, failed, pending and idle are ticked; done is
  not.

Default: on.

Example: you only care about trouble. Untick running, pending and idle. The rows
now show only stale and failed tasks.

## 7. The /done band

When a Claude session ends with `/done`, a one-line band appears under the pane
header: `[+] DONE S12 - safe to clear`, or `[x] /done failed: <reason>`. It appears
only when the console can check that the session really finished and nothing
changed since (no new commit, no new prompt). The project's dot in the list and its
status card show the same. The next prompt or `/clear` removes it.

Default: always on.

## 8. Status panel (right side)

One card per project, refreshed every few seconds. It only reads; it changes
nothing. A card shows the git branch, how many files are changed, open tasks with
their progress, and new inbox notes. Click a card to expand it.

- **Next:** an expanded card shows one "Next:" line: the first sentence of the
  project's next action. Hover for the whole text; click to open it in place.
- **inbox N new**: notes that arrived since the project's last `/done` (or in the
  last 24 hours). Hover to see the newest note's kind and subject.
- **headless**: a tinted card has a headless run going right now.
- Drag cards to reorder them.

Default: on. The **Status** button in the top bar hides or shows the panel.

Example: a card reads `inbox 2 new`. Hover it to see that the newest is an ORDER,
then click the project to open a pane and act on it.

## 9. Top bar

- **Usage strip**: for each account, how much of each usage window is used and when
  it resets, for example `7d 62%: 2d4h`. The windows are 7-day, 5-hour, and Fable
  (the separate weekly limit for that model). Numbers turn orange at 70 percent and
  red at 90. The gear at the end picks which windows and accounts to show. In a
  narrow window the strip folds into one `Use NN%` button.
- **Resource readout**: CPU, RAM, GPU, each drive's activity and network use, the
  same numbers Task Manager shows.
- **A- / A+**: the default terminal text size for every pane. A pane changed with
  its own A- / A+ (in its `...` menu) keeps its size.
- **Update available**: shown only when a newer console release is found
  (section 16). Click it to go to Settings > Updates & repair.

Default: on. Account 3 starts hidden; API and Extra Usage show `--` while there is
no data for them.

Example: you only watch the weekly limit. Open the gear and untick 5h and Fable;
the strip gets shorter.

## 10. Bottom bar

- **Minimized panes**, with a `waiting` or `needs you` badge.
- **Closed panes** stay as dashed `reopen:` chips. Reopening a Claude pane resumes
  the same conversation; Shift+click starts fresh.
- **Version**: the console's version (for example `v0.1.0`) at the bottom right.

Default: always on.

## 11. Look and feel (Settings)

- **Theme**: system (follows Windows), dark or light. **Toggle** flips it at once.
- **Default terminal font size**, **Font family**, **Line height**: how text in the
  terminals looks.
- **Scrollback lines**: how much past output each pane keeps (1,000 to 100,000).
- **Default shell**: the shell a new shell pane uses.
- **Text size** sets the console's own text (not the terminals) in six levels:
  header (top bar), subheader (titles), body, nested / secondary, mono (rows,
  paths) and badges / meters. You set one base size in pixels and an offset per
  level. Changes show at once; Cancel undoes them; **Reset to defaults** goes back.

Default: on, with the standard sizes and the system theme.

Example: the top bar is hard to read from across the room. Raise "Header (top bar)"
from 1 to 3 and "Badges / meters" from -3.5 to -1.5, then Save.

## 12. Notifications and badges (Settings)

- **Badge panes waiting for input**: a badge on a pane, or its bottom-bar chip,
  when Claude is waiting for you. Default: on. Untick it to stop the badges.
- **Desktop notification when a hidden pane needs you**: a Windows notification
  when a pane you cannot see asks for permission. Default: off (opt-in). Turn it on
  to work in another window and still hear when Claude is stuck.

## 13. Accounts (Settings)

Claude Code can run on more than one account. Settings has two lists side by side:

- **Main / orchestrator account (interactive panes)**: the account new Claude panes
  start on. The New pane dialog can pick another one for a single pane.
- **Headless lane account**: the account headless runs use. Leave it unset to keep
  the normal split. Picking the same account as the main one runs everything on one
  account.

The lists show labels only, never names, emails or ids. The line under them shows
which route is really in effect. A choice that cannot work is refused, with the
reason.

Default: on, with the configured main account and the headless account unset.

Example: pick Account 2 as the main account and Save. The next Claude pane you open
starts on Account 2; panes already open keep their account.

## 14. Health & cleanup (Settings)

Settings > Health & cleanup > **Run health check...** opens a list of checks and
cleanups.

- Each row says how long it usually takes, what it costs and what it deletes.
  Everything costs `$0 / 0 tokens` except the optional AI report.
- Tick the rows you want and click **Run**. Each step shows progress, and the run
  ends with a short report.
- Anything deleted goes to the Recycle Bin, so it can be restored.
- Console checks: old attachments, panes that ended long ago, leftover processes,
  the console's own memory growth, scrollback size. "Leftover processes" is
  unticked; tick it to end processes left behind by closed panes.
- A run is refused, with the reason, while another run is in progress.

Default: nothing runs until you click Run.

### Scheduled health check

The same dialog has a **Schedule** box.

- Tick **Run on a schedule**, pick a time and, if you like, days (no day ticked =
  every day), then **Save schedule**.
- A scheduled run uses read-only steps only: disk, boot, scheduled tasks,
  repository drift and progress. It never deletes, never starts another task and
  never spends tokens.
- Each run writes a report and one status line, shown in Settings.
- Turning it off disables the task; it is not deleted.

Default: off (opt-in). Turn it on to get a daily health line without clicking
anything. It needs a plugin; without it the box says why it is unavailable.

Example: tick **Run on a schedule**, set 07:30, tick Mon to Fri, **Save schedule**.
Each weekday morning the health line in Settings shows that morning's result.

## 15. Watchdog (observe only)

Settings > Health & cleanup > **Watchdog readings...** shows what the background
watchdog has measured:

- processes whose memory or handle count keeps growing;
- known problem cases;
- paging: pages per second, available memory, commit;
- crashes and hangs per app.

It samples every 10 minutes and keeps 14 days of readings. **Sample now** takes a
reading at once.

It only measures. It never stops a process and never sends a report. Its warning
limits stay unset until enough normal readings exist to choose them.

Default: on (measuring only).

Example: open **Watchdog readings...** after a day. A process listed under "Handle
growth" with a high r2 has been climbing steadily all day.

## 16. Updates & repair (Settings)

Settings > Updates & repair shows the installed version and whether a newer one
exists.

- **Check now** looks for a new release.
- **Update now** asks first, then downloads, verifies and installs it next to the
  current one. Your own changes to console files are merged in and backed up. The
  new version runs after the next restart. `claude-console rollback` goes back.
- **Auto-update**: tick **Auto-update inside the update window, only when no pane
  is busy** to get updates while you are away (window 04:00 to 05:00 unless
  changed). A restart never happens while a pane is working. If your changes clash
  with the new version, the update stops at "needs review" and the old version
  stays.
- **Repair...** restores missing console files and keeps your tweaks. It first
  shows what it will restore and keep, then asks you to type a phrase; the red
  **Repair** button runs it. It only touches the console's own program files and
  makes a backup first.
- **Contribute?** saves a cleaned patch of your local changes in the console's
  reports folder. Nothing is sent.

Default: off (opt-in). No release source is set yet, so no check runs and the top
bar badge stays hidden. A console run from a git copy (a developer setup) updates
through git, and these buttons are disabled there.

Example: the top bar shows **Update available v0.2.0**. Click it, then **Update
now**, confirm, and restart the console when the panes are idle.

## 17. The claude-console command

An installed console has a command-line tool, `claude-console`. From a developer
copy run it as `node bin/claude-console.js <command>`.

| Command | What it does |
|---|---|
| `install` | Checks that Node, Claude Code, Edge and git are present, then installs the console with Desktop and Start-menu shortcuts. Your data is kept apart from the program files. |
| `start`, `stop`, `status` | Start, stop or check the console. |
| `update` | Same as **Update now**; `update --check` only looks. |
| `rollback` | Go back to the previous installed version. |
| `reinstall` | Shows what a repair, fresh or factory reinstall would do; each needs a typed confirmation. |
| `contribute` | Saves a cleaned patch of your local changes; sends it only when you add `--send --yes`. |
| `setup` | Shows the Claude Code pieces the console ships (section 18). |
| `autoupdate --register` | Writes a script that creates the auto-update task; you run it yourself. |
| `release` | Builds a release package on this computer. It never uploads. |

Default: always available once installed.

Example: `claude-console status` says whether the console is running and which
version is installed.

## 18. Setting up Claude Code for the console

The console ships a few Claude Code pieces: the `/done` command behind the quick
chip, an optional status line for Claude Code outside the console, and the pane
hooks that tell the console when a pane is waiting.

`claude-console setup` only **shows a plan**, one line per piece:

- **new**: would be added;
- **same**: already there, nothing to do;
- **differs** / **conflict**: you already have a different version; it is kept.

Nothing is written. To apply the plan, run `claude-console setup --apply --yes`
(add `--only <ids>` to pick pieces). A backup is made first. A different file you
already have is replaced only if you also add `--force` (commands) or `--replace`
(settings). The pane hooks are never installed: each pane gets them at start.

For a guided version, paste `claude/first-run.md` into a Claude pane. Claude shows
the plan in plain words and asks before each write.

Default: plan only. Your global Claude settings never change without your yes.

Example: `claude-console setup` lists `cmd-done new`. Run
`claude-console setup --apply --yes --only cmd-done` to add just the `/done`
command.

## 19. What the console never does

- It never listens on the network: only this computer can open it.
- It never shows account names, emails or ids; usage is numbers only.
- It never changes another project's files.
- It never changes your global Claude Code settings without a shown plan and your
  yes.
- It never deletes your files directly: cleanups use the Recycle Bin.
