---
description: End the session cleanly - commit the work, write NEXT-SESSION.txt with every open item, then say "Done, safe to clear".
argument-hint: [optional note for the next session]
---

# /done - end of session (shipped with Claude Console)

The console's quick chips offer `/done`, `continue` and `/clear`. This command is the
`/done` they expect. A project's own `.claude/commands/done.md` takes precedence over
this one, so a repo with its own ritual keeps it.

Note for the next session, if any: $ARGUMENTS

1. Run the project's tests if it has a test command and this session changed code.
   Record pass/fail counts; do not hide a failure.
2. `git status --short`: every changed file is expected. Commit the session's work
   in coherent commits. Never push unless the project's own instructions say so.
3. Write `NEXT-SESSION.txt` at the repo root (replace the old one):
   - first line `SESSION: <n>` (previous value + 1, or 1);
   - THE SINGLE NEXT ACTION, one or two lines;
   - every item not finished this session, carried forward verbatim or tighter,
     never dropped;
   - anything the user must do by hand (passwords, physical acts), batched.
   Commit it.
4. Print exactly one line: `Done, safe to clear`.
   If a step failed, print the failure instead.
