#!/bin/sh
# pre-push check (setup profile, item rule-push-policy): this repository is local only.
echo "pre-push: this repository is local only; push refused." >&2
exit 1
