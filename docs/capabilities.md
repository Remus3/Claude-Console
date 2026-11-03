# Claude Console - what it can do

This guide lists every feature of Claude Console in plain words. Each feature says
what it does, whether it is on when you first start the console, how to turn it on
or off, and gives a short example. Sections follow the screen: left, middle, right,
top, bottom, then Settings.

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
- **background run**: a Claude run with no pane, started by a project's own automation.
  The Status panel marks one `headless`.

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

Every git repository found directly under `C:\`, in your user folder or in its
Documents, Desktop, `source\repos`, Projects and code folders is listed. Click a project
to open Claude Code in it. If a pane for it is already open, the click takes you there.
Shift+click always opens a new one.

- **Rescan** finds new repositories.
- **Tasks** opens the scheduled-tasks screen (section 3).
- **+ New** (new pane) opens a dialog: project, **Use another folder** (with a folder
  browser and a line saying where the pane opens), kind (claude or shell), account, and
  extra arguments (for example `--continue` to pick up the last conversation). A git
  repository you open this way stays listed.
- Right-click a project: the same dialog, set to a shell in that project.
- Drag projects to reorder them. The order is saved.
- **Groups**: `+ Group` at the bottom makes a named group. Drag projects onto its
  header to put them in it. A group's caret folds it: `v` is open, `^` is shut.
- **Collapse the list**: the menu button at the top left, or Ctrl+Alt+B. A thin
  strip with one status dot per project stays visible.

Default: always on.

Example: make a group called "Daily", drag your three most used projects onto it,
and fold everything else shut.

### Tools under a project

A project can carry its own shortcuts: programs, scripts, files, folders or web
pages. They show as indented rows under the project when you open its `^` caret.

- **Add a tool**: click `+ Tool`, or drag a file, folder or Desktop shortcut from
  Explorer onto a project row.
- **Change a tool**: hover it and use `...` to Rename, Edit path or Remove. Remove
  only hides the entry; the file on disk is never touched.

Default: off until you add a tool. A project without tools shows no caret.

Example: drag `notes.txt` from your Desktop onto the project row. A `notes` row
appears under the project; clicking it opens the file in Notepad.


### Hide a project from the list

Settings > Projects > **Hide**. You must type `DELETE PROJECT` to confirm, though only
the listing goes: the folder and its files are never touched. A project with open panes
cannot be hidden until they are closed. Hidden projects stay in Settings > Projects with
**Show**, which brings them back.

## 3. Scheduled tasks (Tasks button)

**Tasks**, next to Rescan, lists your Windows scheduled tasks (Microsoft's own are
left out).

- Tasks are grouped by the project, or the console, they run in. The list at the
  top shows one project only. **Refresh** reloads the list.
- Each row shows the trigger and the state.
- Tasks that run at boot or logon are marked: they add work to every start-up.
- Tasks from other programs sit folded under **Other tasks on this PC**. There, Disable
  asks twice, like Remove.
- "What the result codes mean" lists the codes that look like errors but are not
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

- **Header**: state glyph, title, what Claude is doing (`working 2m`, `thinking 3m`; no tool names),
  the project's running task with its progress, a badge when it needs you, and Max,
  Min and X (close). Everything else (text size A- / A+, Find, Hide message box,
  Restart, and the pane's kind, account and folder) is in the `...` menu.
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

## 5. The message box

Under every pane is a message box with **Attach** and **Send** beside it. Enter sends,
Shift+Enter starts a new line, and Alt+Up / Alt+Down bring back earlier messages.

- **Quick chips**: one-click messages under the box. The first three are
  `continue`, `/done` and `/clear`; `/done` shows only where the project has that
  command, and a shell pane has no chips. In Settings > Quick chips you can untick a
  chip, change its text, remove it, or add your own with **+ Add chip** (up to 12).
- **Key buttons**: Esc and S-Tab show at first. Settings > Pane key buttons adds ^C,
  Enter, ^X^S and the four arrows; a phone shows them all. **^X^S** is Claude Code's own
  "send now": it sends a message you typed or queued while Claude was still busy.
- **Slash list**: type `/` at the start of the box to see the commands and skills
  of that project. Up / Down choose, Tab or Enter fill it in, Esc closes.
- **Attachments**: drop a file or image onto a pane, paste an image, or click
  **Attach**. The file is copied into a folder the console keeps for attachments,
  and its path goes into your message so Claude can read it. Files over 50 MB are
  refused. Attachments older than 14 days go to the Recycle Bin.

Default: on. Each chip and key can be turned off in Settings.

Example: Claude is busy and you type "also check the tests". With the ^X^S key turned
on, click it and Claude takes your message now instead of after its current step.

### Message box only

Claude Code draws its own input box and status rows at the bottom of the terminal.
The console hides them, so the message box is the only place you type. A small chip
in the pane header shows what those rows said (`2 agents . 1 shell . ctx 9%`; ctx
is how full Claude's memory of the conversation is). Hover the chip to read the
rows; click it to show or hide them in that pane. When Claude shows a menu or asks
for permission, nothing is hidden.

Default: on. Turn it off in Settings: **Message box only: hide Claude Code's own input
box and status rows (this window)**.

## 6. Progress rows and the ETA clock

A progress file is a JSON file in the project's `ops/loop/control/progress` folder with
the fields `task`, `pct`, `step`, `eta_s`, `status` (`running`, `done` or `failed`) and
`updated`, and optionally `started`. Anything can write one: a script, a build or Claude
itself. The console shows them as fixed rows above the pane's terminal and on its status
card:

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

Settings > Pane progress rows chooses how many rows and which states:

- **Rows shown** (0 hides the strip): 0 to 12, default 6.
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

Default: always on, but it needs a `/done` that writes the marker the console checks, as
the setup profile's Session shape module does.

## 8. Status panel (right side)

One card per project, refreshed every few seconds. It only reads; it changes
nothing. A card shows the git branch, how many files are changed, open tasks with
their progress. Click a card to expand it.

- **Next:** an expanded card shows one "Next:" line: the first sentence of the
  project's next action. Hover for the whole text; click to open it in place.
- **headless**: a tinted card has a background run going right now.
- **Trackers**, at the top of the panel: your projects' scheduled tasks. Click the heading
  to fold it. Settings > Status panel trackers can add **Machine**: this computer's CPU,
  commit charge and free disk space.
- Drag cards to reorder them.

Default: on. The **Status** button in the top bar hides or shows the panel.

Example: a card shows `2 uncommitted`. Click the project to open a pane and deal with
it.

## 9. Top bar

- **Usage strip**: for each account, how much of each usage window is used and when
  it resets, for example `7d 62%: 2d4h`. The windows are 7-day, 5-hour, and Fable
  (the separate weekly limit for that model). Numbers turn orange at 70 percent and
  red at 90. The gear at the end picks what to show. In a narrow window the strip folds
  into one `Use NN%` button.
- **Resource readout**: CPU, RAM, GPU, each drive's activity and network use, the
  same numbers Task Manager shows.
- **Update available**: shown only when a newer console release is found
  (section 16). Click it to go to Settings > Updates & repair.

Default: on, showing the 7-day window. The gear lists a third account and Extra Usage
only when there is something to show for them.

Example: you also watch the 5-hour limit. Open the gear and tick it; the strip gets one
number longer.

## 10. Bottom bar

- **Minimized panes**, with a `waiting` or `needs you` badge.
- **Closed panes** stay as dashed `reopen:` chips. Reopening a Claude pane resumes
  the same conversation; Shift+click starts fresh.
- **Version**: the console's version (for example `v0.1.0`) at the bottom right.

Default: always on.

## 11. Look and feel (Settings)

- **Theme**: system (follows Windows), dark or light. It applies at once.
- **Terminal font px**, **Font family**, **Line height**: how text in the terminals
  looks. A pane's own A- / A+, in its `...` menu, changes only that pane.
- **Scrollback lines**: how much past output each pane keeps (1,000 to 100,000).
- **Default shell**: the shell a new shell pane uses.
- **Fine-tune console text size** sets the console's own text (not the terminals) in six
  levels, each its own size in pixels: Header (top bar), Subheader (titles), Body,
  Secondary, Mono (rows, paths) and Badges. Changes show at once; Cancel undoes them;
  **Reset** goes back.
- **After /clear in a Claude pane**: keep Claude running and restart the progress rows
  (the default), or restart Claude with a new session.

Default: on, with the standard sizes and the system theme.

Example: the top bar is hard to read from across the room. Raise Header from 16 to 20
and Badges from 11.5 to 14, then Save.

## 12. Notifications and badges (Settings)

- **Badge panes waiting for input**: a badge on a pane, or its bottom-bar chip,
  when Claude is waiting for you. Default: on. Untick it to stop the badges.
- **Desktop notification when a hidden pane needs you**: a Windows notification
  when a pane you cannot see asks for permission. Default: off (opt-in). Turn it on
  to work in another window and still hear when Claude is stuck.
- **Needs-you list**: the top-bar `? N` button counts the panes that need you (a
  permission prompt) or wait unread after a turn, and lists them one line per pane.
  Click a line to restore and focus that pane; **Ctrl+Alt+U** jumps to the newest
  unread one, also from inside a terminal. Default: always on.
- **Progress line**: a 2 px line along the pane header while Claude generates, from
  Claude Code's own progress signal. Default: always on.

## 13. Accounts (Settings)

Claude Code keeps each login in its own config folder, and the console can run panes on
more than one. With one account configured, Settings shows a single line that points
here.

To add an account, add it to the `accounts` block in `data\console.local.json` with a
label and a folder of its own (your first account stays as it is, whatever else that
file holds), create the folder, and restart the console:

```json
{ "accounts": { "acct2": { "label": "Account 2", "configDir": "D:\\claude\\account2" } } }
```

Then open a Claude pane on that account from **+ New** and log in there.

**Account for new Claude panes** in Settings then chooses the account new Claude panes
start on, and the New pane dialog can pick another one for a single pane. The lists show
labels only, never names, emails or ids. Where background runs go is set by the setup
profile's **Background runs on a second account** module, not here.

Default: on, with your first account.

Example: pick Account 2 and Save. The next Claude pane you open starts on Account 2; panes
already open keep their account.

## 14. Health & cleanup (Settings)

Settings > Health & cleanup > **Run health check...** opens a list of checks and
cleanups.

- Each row says how long it usually takes, what it costs and what it deletes.
  Everything costs `$0 / 0 tokens`.
- Tick the rows you want and click **Run**. Each step shows progress, and the run
  ends with a short report.
- Anything deleted goes to the Recycle Bin, so it can be restored.
- Console checks: old attachments, panes that ended long ago, leftover processes,
  the console's own memory growth, scrollback size. "Leftover processes" is
  unticked; tick it to end processes left behind by closed panes.
- A run is refused, with the reason, while another run is in progress.

Default: nothing runs until you click Run.


## 15. Watchdog (observe only)

Settings > Health & cleanup > **Watchdog readings...** shows what the background
watchdog has measured:

- processes whose memory or handle count keeps growing;
- paging: pages per second, available memory, commit;
- crashes and hangs per app.

It samples every 10 minutes and keeps 14 days of readings. **Sample now** takes a
reading at once.

It only measures. It never stops a process and never sends a report. Its warning
limits stay unset until enough normal readings exist to choose them.

Default: on (measuring only). Turn it off with `"watchdog": {"enabled": false}` in
`data\console.local.json`.

Example: open **Watchdog readings...** after a day. A process listed under "Handle
growth" with an r2 close to 1 has been climbing steadily all day.

### Machine advisor

The `...` menu, **Machine advisor...**, or Settings > Machine > **Open machine advisor...**.

- **Read machine**: one read-only query of your hardware and Windows, saved in one file on
  this computer. Claude panes can read that file, so Claude may see it.
- **Suggest changes** proposes changes. Each is off until you tick it, is previewed first,
  backed up, read back and revertable.
- **View machine data** shows what is saved; **Delete machine data...** removes it, to the
  Recycle Bin.

Default: nothing is read or changed until you press a button.

## 16. Updates & repair (Settings)

Settings > Updates & repair shows the installed version and, after a check, whether a
newer one exists.

- **Check now** looks for a new release.
- **Update now** asks first, then downloads, verifies and installs it next to the
  current one. Your own changes to console files are merged in and backed up. The
  new version runs after the next restart. `claude-console rollback` goes back.
- **Repair...** restores missing console files and keeps your tweaks. It first
  shows what it will restore and keep, then asks you to type a phrase; the red
  **Repair** button runs it. It only touches the console's own program files and
  makes a backup first.
- **Save my edits as a patch** saves a cleaned patch of your local changes in the
  console's reports folder. Nothing is sent.

Default: no check runs by itself. Check now looks when you press it; the optional task
from `autoupdate --register` checks daily. A console run from a git copy (a developer
setup) updates through git, and these buttons are disabled there.

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
| `setup` | Shows the setup plan for the console's own items (section 18). |
| `stop-all --yes`, `resume --yes` | Stop what the console and the setup profile started, and undo that stop. |
| `crash-report`, `recover-prompt` | Build a scrubbed problem report or help text for you to read first. |
| `profile` | The setup profile from a terminal: list, view, apply, revert, adopt. |
| `uninstall` | Remove the console. It stops while a setup profile is applied (`--keep-profile` overrides); `--purge` also recycles your data. |
| `autoupdate --register` | Writes a script that creates the auto-update task; you run it yourself. |
| `release` | Builds a release package on this computer. It never uploads. |

Default: always available once installed.

Example: `claude-console status` says whether the console is running and which
version is installed.

## 18. Setting up Claude Code for the console

The pane hooks that tell the console when a pane is waiting are never installed: each
pane gets them at start. Two other pieces are yours to add, and both go through the setup
profile, so every apply shows its plan first and `claude-console profile revert --last
--apply --yes` undoes it.

- **The `/done` command** behind the quick chip is written into a project. `claude-console
  profile apply --target repo:C:\code\my-app --only cmd-done --var repo_code=APP` shows
  the plan, and adding `--apply --yes` writes it. It brings the project's hand-off file
  with it, named from that code.
- **A status line outside the console**: `claude-console profile enable set-statusline-user`,
  then `claude-console profile apply --target user --only set-statusline-user`, and the
  same with `--apply --yes`. It shows in every project.

`claude-console setup` installs neither. It looks at `claude-console profile apply --target
user --only console`, whose items live in a project or inside the console, so it normally
has nothing to write: it says so, even `--apply --yes` then records nothing, and it names
the wizard (the `...` menu, **Run setup...**).

The console's simpler status line (account, model, repository, context and quota) has no
install command. It is `statusline.js` in the install folder, for a `statusLine` entry you
add to your Claude settings yourself; remove that entry the same way.

Default: nothing is written. Your global Claude settings never change without your yes.

## 19. What the console never does

- It never listens on the network: only this computer can open it.
- It never shows account names, emails or ids; usage is numbers only.
- It never changes another project's files.
- It never changes your global Claude Code settings without a shown plan and your
  yes.
- It never deletes your files directly: cleanups use the Recycle Bin.

## Setup profile, adoption and recovery

These have their own pages: [the setup profile](profile.md), [adopting an existing
project](adopt.md), [recovery](recovery.md) and [privacy](privacy.md). **Report a
problem** and **Get help in the browser** are in the `...` menu; both show you the exact
text first.
