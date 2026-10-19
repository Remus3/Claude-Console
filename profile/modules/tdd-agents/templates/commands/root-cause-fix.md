---
description: Fix a bug at its root - reproduction test first, every sibling case, minimal fix, backfill check.
argument-hint: <the bug>
---

# /root-cause-fix

Bug: $ARGUMENTS

1. Reproduce it with a test that fails for the reported reason. No test, no fix.
2. Name the root cause in one sentence. Search the code for every other place with
   the same shape and list them.
3. Make the smallest change that fixes the cause in every listed place. Each one
   gets its own failing-then-passing test.
4. Data check: if the bug wrote bad data, find the rows already affected and fix
   them in the same change.
5. Run the relevant tier of tests. Report: cause, places fixed, rows backfilled,
   counts.
