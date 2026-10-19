- LANES. Background work runs in lanes: one git worktree per lane, at most 3 lanes
  per repository and 3 on the machine, shared fairly; a lane writes
  `{control_dir}/progress/lane-<i>.json` in the main checkout.
