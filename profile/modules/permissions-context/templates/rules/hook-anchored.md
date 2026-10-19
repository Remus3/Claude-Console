- ANCHORED HOOKS. Every hook command starts from an absolute anchor such as
  "$CLAUDE_PROJECT_DIR", never a path relative to the current folder: after a cd, a
  relative hook path fails, and a hook that exits 2 blocks every tool.
