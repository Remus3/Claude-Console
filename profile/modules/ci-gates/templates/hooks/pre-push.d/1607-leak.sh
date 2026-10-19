#!/bin/sh
# pre-push leak scan (setup profile, item ci-hook-pre-push-leak). The pushed refs arrive on
# standard input (the dispatcher read them once); the scan grades every pushed commit.
root=$(git rev-parse --show-toplevel) || exit 1
py=$(git config --get profile.python)
if [ -z "$py" ]; then echo "pre-push: git config profile.python is not set" >&2; exit 1; fi
"$py" "$root/.githooks/checks/leak_scan.py" "$@"
rc=$?
case "$rc" in
  0) exit 0 ;;
  2) echo "pre-push: HALT - remove the findings above from the pushed commits, then push again" >&2; exit 1 ;;
  *) echo "pre-push: FAULT - the leak scan could not run (exit $rc); nothing was pushed" >&2; exit 1 ;;
esac
