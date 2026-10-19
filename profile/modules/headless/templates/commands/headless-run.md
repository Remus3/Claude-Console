---
description: Contract for one long background run - one merger, worktree agents, its own /done fold.
argument-hint: <the unit of work>
---

# /headless-run

Unit: $ARGUMENTS

You are a background run: nobody reads chat. Print nothing but the final verdict.

1. Read the hand-off and the unit. Write the progress file after every step.
2. You are the merger: split the unit into slices with disjoint write-lists and
   dispatch one worktree agent per slice. Never edit a slice's files yourself.
3. Verify every slice with a distinct verifier before merging it.
4. Run the whole suite through the suite gate once, at the end.
5. Fold /done: carry every open item into the hand-off, one commit, the marker.
6. Final line: `DONE <unit> <counts>`, `NOTHING LEFT`, or `FAILED <step>`.
