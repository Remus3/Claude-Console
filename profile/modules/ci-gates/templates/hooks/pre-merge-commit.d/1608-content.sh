#!/bin/sh
# pre-merge-commit (setup profile, item ci-hook-pre-merge-commit). git does not run
# pre-commit for a merge commit, so the same pre-commit checks run here.
root=$(git rev-parse --show-toplevel) || exit 1
[ -f "$root/.githooks/pre-commit" ] || exit 0
exec sh "$root/.githooks/pre-commit"
