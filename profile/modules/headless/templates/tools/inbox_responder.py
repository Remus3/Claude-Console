"""Inbox responder tick: classify new notes for free, act only on ORDER / FIX / RULING.

Run every 15 minutes by its scheduled task. Stops at once while
{control_dir}/RESPONDER.halt exists (for example during /done). Each new note in
{inbox_dir}/ is classified by kit_inbox.classify(): SKIP and ACK get a ledger line
only; WORK starts one run through the spawn helper; TRIAGE gets one cheap run.
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, "{kit_dir}")
import kit_inbox  # noqa: E402

SEEN = os.path.join("{control_dir}", "inbox_seen.jsonl")


def seen():
    try:
        with open(SEEN, encoding="utf-8") as f:
            return set(json.loads(ln)["note"] for ln in f if ln.strip())
    except OSError:
        return set()


def mark(note, action):
    os.makedirs("{control_dir}", exist_ok=True)
    with open(SEEN, "a", encoding="ascii", newline="\n") as f:
        f.write(json.dumps({"note": note, "action": action}) + "\n")


def main():
    if os.path.exists(os.path.join("{control_dir}", "RESPONDER.halt")):
        return 0
    done = seen()
    notes = sorted((n for n in os.listdir("{inbox_dir}") if n not in done),
                   key=lambda n: os.path.getmtime(os.path.join("{inbox_dir}", n)))
    for n in notes:
        with open(os.path.join("{inbox_dir}", n), encoding="utf-8", errors="replace") as f:
            head = f.read(4000)
        d = kit_inbox.classify(n, "{repo_code}", head)
        action = getattr(d, "action", None) or d[0]
        if action in ("WORK", "TRIAGE"):
            kind = "inbox" if action == "WORK" else "triage"
            prompt = os.path.join("{inbox_dir}", n)
            subprocess.run([sys.executable, os.path.join("{kit_dir}", "kit_headless.py"), "spawn", "--root", os.getcwd(),
                            "--code", "{repo_code}", "--note", n, "--kind", kind, "--prompt-file", prompt])
        mark(n, action)
    return 0


if __name__ == "__main__":
    sys.exit(main())
