# Written outside this repo

Every path this repo or its tools write outside the repo folder, why, and how it is
cleaned. A new outside path is added here in the same change that introduces it.

| Path (with variables, never a literal home path) | Why | Cleanup |
|---|---|---|
| sidecar root, Worktree area | lane and adopt worktrees | tools/worktree_check.py |
| sidecar root, Scratch / Temp / Walk areas | per-run output | tools/sidecar_reap.py (measured retention, Recycle Bin) |
| sidecar root, Archive area | verified bundles and retired copies | never automatic |
