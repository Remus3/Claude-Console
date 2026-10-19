"""Ephemeral agent spawn (setup profile, item rta-ephemeral-spawn).

Runs ONE agent task through the profile's headless spawn helper (the kit), never by
starting claude directly: the helper enforces the route, the run budget and the usage
line. Each run gets its charter as an appended system prompt, an explicit --allowedTools
list, no session persistence, JSON output and a timeout. Provider auth variables are
stripped from the child. The public template never passes a skip-permissions flag.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "{kit_dir}"))
TIMEOUT_S = 900
ALLOWED_TOOLS = "Read,Grep,Glob,Edit,Write"
STRIP = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN")


def run(charter, task):
    import kit_headless
    for name in STRIP:
        os.environ.pop(name, None)
    prompt = "Task %s: %s" % (task.get("id"), task.get("text", ""))
    extra = ["--append-system-prompt-file", charter, "--allowedTools", ALLOWED_TOOLS]
    try:
        line = kit_headless.spawn(ROOT, "{repo_code}", prompt, note="agent:" + os.path.basename(charter),
                                  writes_code=True, timeout=TIMEOUT_S, extra=extra, kind="build")
    except Exception as e:  # the helper refused before anything started
        return dict(ok=False, why="refused: %s" % e)
    ok = line.get("rc") == 0 and not line.get("error")
    return dict(ok=ok, why=line.get("error") or "")
