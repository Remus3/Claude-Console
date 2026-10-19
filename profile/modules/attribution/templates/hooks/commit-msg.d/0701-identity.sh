#!/bin/sh
# commit-msg check (setup profile, item hook-git-commit-msg): strip AI and bot
# attribution lines from the message file in "$1". Run by the commit-msg dispatcher.
root=$(git rev-parse --show-toplevel) || exit 1
py=$(git config --get profile.python)
if [ -z "$py" ]; then echo "commit-msg: git config profile.python is not set" >&2; exit 1; fi
"$py" "$root/{kit_dir}/kit_identity.py" commit-msg "$1"
