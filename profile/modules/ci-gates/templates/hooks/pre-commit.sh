#!/bin/sh
# git pre-commit dispatcher (setup profile, item ci-hooks-install-check).
# Runs every check file in .githooks/pre-commit.d/ in name order and stops at the first
# refusal. Standard input is read ONCE into a file and handed to every check, so no
# check can drain it for the next one. Add your own checks as files in that folder
# (the number prefix sets the order); this file stays the same in every repo.
root=$(git rev-parse --show-toplevel) || exit 1
off=$(git config --get profile.hooksOff 2>/dev/null)
if [ -n "$off" ] && [ -f "$off" ]; then exit 0; fi
dir="$root/.githooks/pre-commit.d"
[ -d "$dir" ] || exit 0
stdin_file=$(mktemp) || exit 1
trap 'rm -f "$stdin_file"' EXIT
: > "$stdin_file"
for check in "$dir"/*; do
  [ -f "$check" ] || continue
  case "$check" in *.disabled|*~|*.bak) continue ;; esac
  if ! sh "$check" "$@" < "$stdin_file"; then
    echo "pre-commit: refused by $(basename "$check")" >&2
    exit 1
  fi
done
exit 0
