"""Stop hook: flag a "tests pass" claim made without a test run in the same turn.

Reads the transcript path from the hook event, looks at the last turn, and when the
final reply claims green but no tool call in that turn ran a test command, prints
one line of additionalContext. It never blocks Stop and never raises.
"""
import json
import re
import sys

CLAIM = re.compile(r"(?i)\b(all tests pass|tests? (are )?(green|passing)|suite (is )?green)\b")
RUN = re.compile(r"(?i)\b(pytest|npm (run )?test|node --test|go test|cargo test|dotnet test|make test|suite_gate)\b")


def main():
    event = json.load(sys.stdin)
    path = event.get("transcript_path")
    if not path:
        return 0
    with open(path, encoding="utf-8") as f:
        rows = [json.loads(ln) for ln in f if ln.strip()]
    turn = []
    for row in reversed(rows):
        if row.get("type") == "user" and isinstance((row.get("message") or {}).get("content"), str):
            break
        turn.append(row)
    text = json.dumps(turn)
    if CLAIM.search(text) and not RUN.search(text):
        msg = "Green claimed without a test run in this turn: run the suite before reporting it."
        sys.stdout.write(json.dumps({"systemMessage": msg}) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
