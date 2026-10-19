#!/bin/sh
# pre-commit content gate (setup profile, item ci-hook-pre-commit-content).
# Judges the STAGED bytes, so what is checked is exactly what gets committed.
root=$(git rev-parse --show-toplevel) || exit 1
py=$(git config --get profile.python)
if [ -z "$py" ]; then
  echo "pre-commit: git config profile.python is not set (apply the setup profile again)" >&2
  exit 1
fi
exec "$py" "$root/.githooks/checks/content_gate.py"
