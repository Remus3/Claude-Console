# Adopting an existing project

Adopting brings a project you already have in line with the setup profile, in part or
in full, without risking it. The rule behind every step: your original project is only
ever read until you decide to replace it, and it is never deleted directly.

Start it from the `...` menu, **Adopt a project...**, or from a terminal:

```powershell
claude-console profile adopt C:\code\my-app --report
```

`--report` stops after the report, so you can look without deciding anything. Without
it, the command walks you through every step and asks before each one.

## What is guaranteed

| Guarantee | How it is kept |
|---|---|
| The original is read-only until you promote | the engine opens it through a read-only view; every write goes to the copy |
| No byte of yours is lost | every original file is either unchanged in the copy or listed, line by line, in the change report; moved text is shown in both places with the same fingerprint |
| "Works" means this exact copy | your confirmation is stored with a hash of the copy; any later edit to the copy needs a new confirmation |
| The original goes only by a later, separate step | to the Recycle Bin or a zip archive, after a typed phrase |
| Every step can be undone byte for byte | per change, per module, or the whole adoption |
| Nothing is committed or pushed for you | the copy is a branch or folder you own; the console prints a suggested commit message |

## 1. Copy

The console always works on a copy; there is no in-place adoption.

- When the project is a git repository with a clean working tree, the copy is a new
  worktree on its own branch, `profile-adopt/<stamp>`.
- Otherwise (uncommitted changes, ignored files that matter, or not a git repository)
  it makes a full copy of the folder, untracked and ignored files included, and records
  a fingerprint of every original file.

You see the size of the copy first and can leave out folders the checks do not need,
such as `node_modules` (`--exclude node_modules`). The copy lives in the console's data
folder under `data\adopt\` (or in the sidecar area when that module is on), never inside
your project and never in Temp.

## 2. Report

The console scans the copy and classifies every profile item as `conforms` (already
there), `differs` (there in another form), `missing`, `conflicts` (something the item
clashes with is present) or `local` (your own content that no item claims, always
kept). For every change it proposes, the report shows:

- the rule it comes from, the file, and the line range in the original and in the copy;
- the kind of change (insert, replace, relocate, normalise line endings, create, move,
  settings key, git setting) and the exact diff;
- why the profile proposes it, its risk, and a **break risk** warning when the change
  might break your project. Examples: a data file or script that must keep Windows line
  endings, or a file your code opens by its path (the report lists every place that
  refers to it).

Text the profile would move out of an oversized file is relocated, never deleted, and
the report shows it in both places. Strings that look like secrets are reported for
you to move; they are never rewritten. The report is saved as `adopt-report.txt` and
`adopt-report.json` beside the copy.

## 3. Yes or no

You accept or refuse each module and each change. The defaults are cautious: missing
low-risk items are ticked; changes to something your project already does its own way,
conflicts, and anything with a break risk are not. "Accept all for this module" ticks a
module's changes, and asks a second time before it includes break-risk ones. High-risk
items need the typed phrase `apply <item-id>`. With the author's settings preset the
modules it uses are pre-ticked, but this screen is never skipped.

From a terminal: `claude-console profile adopt choose <id> --accept all-safe` (missing,
low risk and no break risk), `--accept module:<module-id>`, or single change ids. Your
choice is saved, so you can change it and run the check again without a new scan.

## 4. Function check

The console applies your choices to the copy, then runs your project's own checks on
both the original and the copy and compares them side by side.

1. It looks for the checks: the test command (`package.json`, `pytest`, `go test`,
   `cargo test`, `dotnet test`, `make test`, CI workflow steps), the build command, and
   a start command with a time limit and a readiness signal (a port that answers or a
   line in the log). You confirm or edit each command before anything runs
   (`profile adopt checks <id>`).
2. Each check runs on the original (with its output redirected so the original is not
   written) and on the copy (`profile adopt check <id>`).
3. Each row gets a verdict: `same`, `better` or `WORSE`, with exit codes, durations,
   test counts and the first line that differs.

Any `WORSE` row blocks the next step. The console then narrows down which of your
accepted changes caused it, names it, and offers to revert just that change
(`profile adopt revert <id> --change <change-id> --apply --yes`) and run the check
again.

When you are satisfied, confirm by typing `works` (`profile adopt works <id> --type
works`). The full diff of the copy against the original is shown next to the
confirmation.

## 5. Promote

Only after "works" can the copy become your project. Choose one way:

- **git**: the copy's branch is merged into your project's current branch, as a
  fast-forward when possible. The console makes only that merge and never pushes. If
  you changed the original after the copy was made, it refuses and lists the changes.
- **folder swap**: your original folder is renamed to `<name>.pre-profile-<stamp>`
  beside it, and the copy moves into its place. Both are shown.

The function check runs once more on the promoted project. If it is worse, the promote
is undone automatically. From a terminal: `profile adopt promote <id> --method git` or
`--method swap`, with `--apply --yes`.

## 6. Remove the original, later

Removing the kept original is a separate step. It is never offered in the same run as
the promote, and by default not until 24 hours after it. Two methods only, both behind
the typed phrase `remove original <name>`:

- **Recycle Bin** (the default): the folder goes to the Recycle Bin.
- **zip**: the folder is archived into the adopt area, the archive's fingerprint is
  recorded, and the folder then goes to the Recycle Bin.

```powershell
claude-console profile adopt remove-original <id> --method recycle --confirm "remove original my-app" --apply --yes
```

A git promote keeps one folder, so there is no separate original to remove.

## Undo and adopt more later

- Before promote: `profile adopt revert <id> --change <change-id>`, `--module
  <module-id>` or `--all` puts the copy back to the state you choose.
- After promote: `--all` returns to the recorded state before the promote (the git ref,
  or the folders swapped back) while the original still exists. After the original was
  removed, restore it from the Recycle Bin or the zip first; the command tells you which.
- Every revert ends with a fingerprint comparison against the recorded earlier state.
- `profile adopt list` shows every adoption; run adopt again on the promoted project to
  take more modules later.
