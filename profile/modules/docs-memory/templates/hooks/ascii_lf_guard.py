"""PostToolUse hook: flag a non-ASCII byte or a CR in the file just written.

Reads the hook event from stdin. When the edited file breaks ASCII/LF, prints one
line of additionalContext naming the first offending line; otherwise silent.
Never blocks and never raises.
"""
import json
import sys


def main():
    event = json.load(sys.stdin)
    path = (event.get("tool_input") or {}).get("file_path")
    if not path:
        return 0
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return 0
    for n, line in enumerate(data.split(b"\n"), 1):
        bad = b"\r" in line or any(b > 126 or (b < 32 and b != 9) for b in line)
        if bad:
            msg = "ASCII/LF: " + path + " line " + str(n) + " has a CR or a non-ASCII byte."
            out = {"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": msg[:160]}}
            sys.stdout.write(json.dumps(out) + "\n")
            break
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
