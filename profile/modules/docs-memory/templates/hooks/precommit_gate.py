"""PreToolUse hook: run the fast gates before a git commit tool call.

Fires on Bash/PowerShell calls whose command contains `git commit`. Runs the doc
budget checker; on a hard failure it denies the call with a one-line reason.
Any other call passes silently. Never raises (an internal error lets the call
through: the git hooks remain the authoritative gate).
"""
import json
import os
import subprocess
import sys


def main():
    event = json.load(sys.stdin)
    cmd = str((event.get("tool_input") or {}).get("command") or "")
    if "git commit" not in cmd:
        return 0
    root = os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    tool = os.path.join(root, ".claude", "tools", "doc_budget.py")
    if not os.path.isfile(tool):
        return 0
    r = subprocess.run([sys.executable, tool, "--repo", root], capture_output=True, text=True)
    if r.returncode == 0:
        return 0
    first = next((ln for ln in r.stdout.splitlines() if ln.startswith("FAIL")), "doc budget failed")
    out = {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                  "permissionDecisionReason": ("commit gate: " + first)[:160]}}
    sys.stdout.write(json.dumps(out) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
