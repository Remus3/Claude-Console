#!/bin/sh
# pre-push suite gate (setup profile, item ci-hook-pre-push-suite).
# git config --local profile.testCommand  the suite command (required)
# git config --local profile.testJunit    junit file it writes (optional; zero tests = refuse)
# git config --local profile.suiteGate    prefix that queues the run for a suite slot (optional)
root=$(git rev-parse --show-toplevel) || exit 1
cmd=$(git config --get profile.testCommand)
if [ -z "$cmd" ]; then echo "pre-push: set git config --local profile.testCommand first" >&2; exit 1; fi
junit=$(git config --get profile.testJunit)
gate=$(git config --get profile.suiteGate)
head_before=$(git rev-parse HEAD)
cd "$root" || exit 1
[ -z "$junit" ] || rm -f "$junit"
if [ -n "$gate" ]; then sh -c "$gate $cmd" < /dev/null; else sh -c "$cmd" < /dev/null; fi
rc=$?
if [ "$rc" -ne 0 ]; then echo "pre-push: the suite failed (exit $rc)" >&2; exit 1; fi
if [ -n "$junit" ] && ! grep -Eq 'tests="[1-9][0-9]*"' "$junit" 2>/dev/null; then
  echo "pre-push: the suite ran zero tests or wrote no junit file; an empty run is not a pass" >&2; exit 1
fi
if [ "$(git rev-parse HEAD)" != "$head_before" ]; then
  echo "pre-push: HEAD moved while the suite ran; push again so the tested commit is the pushed one" >&2; exit 1
fi
exit 0
