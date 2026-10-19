"""SessionStart hook: inject the repository's verified facts file.

Prints .claude/facts.md (at most 20 lines) as additionalContext. Silent when the
file is missing or empty; never raises.
"""
import json
import os
import sys


def main():
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        with open(os.path.join(root, ".claude", "facts.md"), encoding="utf-8") as f:
            lines = [ln.rstrip() for ln in f if ln.strip() and not ln.startswith("#")][:20]
    except OSError:
        return 0
    if not lines:
        return 0
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "\n".join(lines)}}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
