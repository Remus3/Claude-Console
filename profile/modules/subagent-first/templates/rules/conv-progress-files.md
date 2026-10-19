- LONG WORK REPORTS AS IT GOES. Anything expected to take over 5 minutes runs in
  the background and writes `{control_dir}/progress/<task>.json` after every step:
  {"task", "pct", "step", "eta_s", "status": running|done|failed, "updated"}.
  The file lives in the main checkout even when written from a worktree. A file
  that stops updating for twice its own ETA is treated as a failure.
