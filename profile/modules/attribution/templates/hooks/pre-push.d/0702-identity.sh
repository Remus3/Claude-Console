#!/bin/sh
# pre-push check (setup profile, item hook-git-pre-push-identity): refuse pushed
# commits with a foreign author, committer or attribution trailer. The pushed refs
# arrive on standard input from the dispatcher, which read them once.
root=$(git rev-parse --show-toplevel) || exit 1
py=$(git config --get profile.python)
if [ -z "$py" ]; then echo "pre-push: git config profile.python is not set" >&2; exit 1; fi
"$py" "$root/{kit_dir}/kit_identity.py" pre-push "$1"
