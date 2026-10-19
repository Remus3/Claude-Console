#!/bin/sh
# PreToolUse text-first guard wrapper (setup profile, item cfg-text-first-guard).
dir="${CLAUDE_PROJECT_DIR:-.}"
off=$(git -C "$dir" config --get profile.hooksOff 2>/dev/null)
if [ -n "$off" ] && [ -f "$off" ]; then exit 0; fi
py=$(git -C "$dir" config --get profile.python 2>/dev/null)
[ -n "$py" ] || exit 0
exec "$py" "$dir/.claude/hooks/text_first_guard.py"
