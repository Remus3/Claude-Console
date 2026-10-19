- WORKTREE AREA. Lane and adopt worktrees live in the sidecar Worktree area, never inside
  the repo. Remove one only through tools/worktree_check.py --remove: merged into its base,
  clean, not locked, ignored files listed, and unmerged commits saved under a ref first.
