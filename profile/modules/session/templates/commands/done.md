---
description: End the session - checks, hand-off rewrite with every open item carried forward, one commit, verified done marker, then one line.
argument-hint: [optional note for the next session]
---

# /done - end of session

Run every step. Chat shows nothing but the final line (or the failure that
stopped the ritual). Note for the next session, if any: $ARGUMENTS

<!-- profile:begin done-dispatch -->
<!-- profile:end done-dispatch -->

## 0. Pre-flight

- Every checklist task is done or carried into the hand-off.
- `git status --short`: every changed path is expected; nothing belongs to
  another repository.
- Stop every watch, monitor or loop this session started.

<!-- profile:begin done-halt -->
<!-- profile:end done-halt -->

## 1. Checks - counts observed in THIS run only

- ASCII and LF on every changed text file.
- The project's tests, if this session changed code. Record pass/fail/skip
  counts; never carry a count forward from earlier or from a sub-agent.

<!-- profile:begin done-suite-gate -->
<!-- profile:end done-suite-gate -->
<!-- profile:begin done-budget -->
<!-- profile:end done-budget -->

## 2. Roadmap and briefs

- ROADMAP.md: closed items out, new work in, one line each.
- Measured facts and decisions go into the relevant brief, dated.

## 3. The hand-off `{handoff_name}`

- Start from the CURRENT file. Every item this session did not act on stays,
  verbatim or tighter.
- First line `SESSION: <n+1>`. Then: the single next action, open items with
  their acceptance checks, decisions not to re-litigate (each with what would
  reverse it), and anything waiting on a physical act or a login, batched.
- Overwrite the whole file. ASCII, LF. Never print it into chat.

<!-- profile:begin done-handoff-archive -->
<!-- profile:end done-handoff-archive -->
<!-- profile:begin done-handoff-lint -->
<!-- profile:end done-handoff-lint -->
<!-- profile:begin done-notes -->
<!-- profile:end done-notes -->
<!-- profile:begin done-operator-acts -->
<!-- profile:end done-operator-acts -->

## 4. Commit - one commit, after the hand-off is read back

- Read the hand-off back. Stage deliberately (read `git status` first).
- One commit: imperative message, what and why, any adjudicated call recorded.
  Multi-line messages go through a file and `git commit -F`.

<!-- profile:begin done-commit-lock -->
<!-- profile:end done-commit-lock -->

<!-- profile:begin done-backup -->
<!-- profile:end done-backup -->
<!-- profile:begin done-board -->
<!-- profile:end done-board -->

<!-- profile:begin done-marker -->
<!-- profile:end done-marker -->

## Last. The only chat output

Exactly one line: `Done ritual complete, safe to clear`. If a step failed and
could not be fixed, print that failure in one line instead.
