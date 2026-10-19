"""SessionStart hook: declare the caveman (ultra) chat dialect for this session.

Prints one line of additionalContext. Never raises; exits 0 silently on any error.
"""
import json
import sys

BANNER = ("Chat dialect for this session: caveman ultra (see /caveman). Results only: numbers, "
          "paths, verdicts, errors. Files keep full prose.")


def main():
    out = {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": BANNER}}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
