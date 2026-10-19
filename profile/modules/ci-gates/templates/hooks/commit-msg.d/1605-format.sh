#!/bin/sh
# commit-msg format check (setup profile, item ci-hook-commit-msg-format). It runs after
# the attribution strip: the commit-msg dispatcher runs its checks in name order.
msg="$1"
[ -f "$msg" ] || exit 0
subject=$(grep -v '^#' "$msg" | sed -n '/[^[:space:]]/p' | head -n 1)
if [ -z "$subject" ]; then echo "commit-msg: empty subject" >&2; exit 1; fi
len=$(printf '%s' "$subject" | wc -c | tr -d ' ')
if [ "$len" -gt 72 ]; then echo "commit-msg: subject is $len characters (at most 72)" >&2; exit 1; fi
if grep -v '^#' "$msg" | LC_ALL=C grep -q '[^[:print:][:space:]]'; then
  echo "commit-msg: non-ASCII or control byte in the message" >&2; exit 1
fi
lower=$(printf '%s' "$subject" | tr 'A-Z' 'a-z')
case "$lower" in
  wip|tmp|temp|test|update|updates|changes|fix|fixes|misc|stuff|.|..|...)
    echo "commit-msg: placeholder subject; say what changed and why" >&2; exit 1 ;;
esac
exit 0
