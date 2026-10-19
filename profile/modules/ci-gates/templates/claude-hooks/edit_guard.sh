#!/bin/sh
# PostToolUse edit guard wrapper (setup profile, item ci-posttooluse-edit-guard).
# Silent when the interpreter is not configured: a guard must never lock the tools out.
dir="${CLAUDE_PROJECT_DIR:-.}"
off=$(git -C "$dir" config --get profile.hooksOff 2>/dev/null)
if [ -n "$off" ] && [ -f "$off" ]; then exit 0; fi
py=$(git -C "$dir" config --get profile.python 2>/dev/null)
[ -n "$py" ] || exit 0
exec "$py" "$dir/.claude/hooks/edit_guard.py"
