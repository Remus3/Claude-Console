"""SessionStart hook: name this session's counter from the hand-off.

Reads the first line `SESSION: <n>` of the repo's hand-off file and prints one
line of additionalContext, so the first reply uses the right number. Read-only.
Never raises; prints nothing when the file or the line is missing.
"""
import json
import os
import re
import sys

HANDOFF = "{handoff_name}"


def main():
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    try:
        with open(os.path.join(root, HANDOFF), encoding="ascii", errors="replace") as f:
            first = f.readline().strip()
    except OSError:
        return 0
    m = re.match(r"^SESSION: (\d+)$", first)
    if not m:
        return 0
    text = "This is session " + m.group(1) + ": print 'Session " + m.group(1) + " checklist' first."
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
