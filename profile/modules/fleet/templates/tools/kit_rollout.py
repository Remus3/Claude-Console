"""Nightly rollout: deliver queued notes and record each repository's profile drift.

Reads ops/roster.json. For every live repository it copies each queued note from
{outbox_dir}/queue/ into that repository's {inbox_dir}/ (byte copy, re-hashed),
then runs `claude-console profile status --json` against it. Writes one summary
to {control_dir}/rollout.json. Applies nothing: adopting a new profile stays an
explicit act in each repository. Stops at the deadline (default 50 minutes).
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time

DEADLINE_S = 50 * 60


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    start = time.time()
    with open(os.path.join("ops", "roster.json"), encoding="utf-8") as f:
        repos = [r for r in json.load(f)["repos"] if r.get("root") and not r.get("retired")]
    queue = os.path.join("{outbox_dir}", "queue")
    notes = sorted(os.listdir(queue)) if os.path.isdir(queue) else []
    summary = {"started": int(start), "notes": len(notes), "repos": []}
    for r in repos:
        if time.time() - start > DEADLINE_S:
            summary["stopped"] = "deadline"
            break
        reached = 0
        for n in notes:
            src = os.path.join(queue, n)
            dst = os.path.join(r["root"], "{inbox_dir}", n)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(src, dst)
            reached += int(sha(src) == sha(dst))
        st = subprocess.run(["claude-console", "profile", "status", "--json", "--target", "repo:" + r["root"]],
                            capture_output=True, text=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        summary["repos"].append({"code": r["code"], "reached": str(reached) + "/" + str(len(notes)),
                                 "status_rc": st.returncode})
    os.makedirs("{control_dir}", exist_ok=True)
    with open(os.path.join("{control_dir}", "rollout.json"), "w", encoding="ascii", newline="\n") as f:
        json.dump(summary, f, indent=1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
