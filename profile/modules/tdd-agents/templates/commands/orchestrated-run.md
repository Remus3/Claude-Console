---
description: Plan, build disjoint slices in parallel worktrees, verify, merge - as one command.
argument-hint: <what to build>
---

# /orchestrated-run

Goal: $ARGUMENTS

0. Recall: hand-off, git log, roadmap, rulings, memory. A CLOSED or REFUTED hit
   stops here with one line.
1. Plan: dispatch the planner. It returns the spec and slices with disjoint
   write-lists. Check the lists really are disjoint before going on.
2. Build: one builder per slice, each in its own worktree, test first.
3. Verify: the verifier re-runs everything from clean. Findings go to adversaries
   (lens set scaled by the diff's risk), then to the adjudicator.
4. Merge the verified slice branches in order. Record counts and any ruling in
   the commit message.
5. Report one line: what landed, the counts, the head commit.
