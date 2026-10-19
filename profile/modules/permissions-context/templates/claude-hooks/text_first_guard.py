"""PreToolUse text-first guard (setup profile, item cfg-text-first-guard).

The first screenshot, screen-scrape or clipboard call of a session is denied with a
reminder to read the same content as text first (a file, an API, the page text or an
accessibility snapshot). A second call in the same session is allowed: the guard asks
for one attempt at text, it never locks the tool. A screenshot costs far more context
than the text it shows.
"""
import json
import os
import re
import sys
import tempfile

PATTERN = re.compile(r"screenshot|screen_?shot|capture_screen|clipboard|scrape", re.I)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    tool = str(data.get("tool_name") or "")
    if not PATTERN.search(tool):
        return 0
    session = re.sub(r"[^A-Za-z0-9_-]", "", str(data.get("session_id") or "none"))[:64]
    marker = os.path.join(tempfile.gettempdir(), "claude-text-first-" + session)
    if os.path.exists(marker):
        return 0
    try:
        with open(marker, "w", encoding="ascii") as fh:
            fh.write("1\n")
    except OSError:
        return 0
    reason = ("Read this as text first (file, API, page text or an accessibility snapshot); "
              "if text cannot answer, call the tool again.")
    out = dict(hookSpecificOutput=dict(hookEventName="PreToolUse", permissionDecision="deny",
                                       permissionDecisionReason=reason))
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
