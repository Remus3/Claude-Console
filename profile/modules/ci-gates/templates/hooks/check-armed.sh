#!/bin/sh
# Hooks armed check (setup profile, item ci-hooks-install-check).
#   sh .githooks/check-armed.sh          quiet; prints one line only when hooks are not armed
#   sh .githooks/check-armed.sh --check  proves the pre-commit gate refuses a planted byte
# A fresh clone runs no hooks until core.hooksPath points at the tracked .githooks folder,
# and a hooks path can drift (absolute path, moved drive). Present is not the same as firing.
root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
mode="$1"
fail() { echo "$1"; if [ "$mode" = "--check" ]; then exit 1; fi; exit 0; }
hp=$(git -C "$root" config --get core.hooksPath)
[ "$hp" = ".githooks" ] || fail "git hooks are NOT armed here (core.hooksPath is '${hp:-unset}'); run: git config --local core.hooksPath .githooks"
missing=""
for h in pre-commit commit-msg pre-push pre-merge-commit; do
  [ -f "$root/.githooks/$h" ] || missing="$missing $h"
done
[ -z "$missing" ] || fail "git hook dispatchers missing:$missing"
[ "$mode" = "--check" ] || exit 0
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
probe="$tmp/probe"
git init -q "$probe" || exit 1
cp -R "$root/.githooks" "$probe/.githooks" || exit 1
at=@
git -C "$probe" config core.hooksPath .githooks
git -C "$probe" config profile.python "$(git -C "$root" config --get profile.python)"
git -C "$probe" config user.name probe
git -C "$probe" config user.email "probe${at}example.invalid"
printf 'planted \342\200\224 byte\n' > "$probe/planted.txt"
git -C "$probe" add planted.txt
if out=$(git -C "$probe" commit -q -m "probe commit" 2>&1); then
  echo "pre-commit did NOT refuse a planted non-ASCII byte: hooks are present but not firing"
  exit 1
fi
case "$out" in
  *non-ASCII*) echo "hooks armed: pre-commit refused the planted byte"; exit 0 ;;
  *) echo "probe commit failed for another reason: $(printf '%s\n' "$out" | head -n 1)"; exit 1 ;;
esac
