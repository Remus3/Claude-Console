"""Headless driver lane: run one unit of work per cycle through the spawn helper.

Usage: driver_lane.py <lane-name> <prompt-file> [--cycles N]
Each cycle: stop if {control_dir}/<lane-name>.halt exists; write the progress file;
spawn one run through the kit (it enforces route, budget and timeout); record the
receipt; stop when the run reports nothing left to do or the cycle cap is reached.
"""
import json
import os
import subprocess
import sys
import time

KIT = os.path.join("{kit_dir}", "kit_headless.py")


def progress(lane, pct, step, status):
    d = os.path.join("{control_dir}", "progress")
    os.makedirs(d, exist_ok=True)
    doc = {"task": lane, "pct": pct, "step": step, "eta_s": 0, "status": status,
           "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    with open(os.path.join(d, lane + ".json"), "w", encoding="ascii", newline="\n") as f:
        json.dump(doc, f)


def main(argv):
    if len(argv) < 2:
        print("usage: driver_lane.py <lane-name> <prompt-file> [--cycles N]")
        return 1
    lane, prompt = argv[0], argv[1]
    cycles = int(argv[argv.index("--cycles") + 1]) if "--cycles" in argv else 12
    for n in range(1, cycles + 1):
        if os.path.exists(os.path.join("{control_dir}", lane + ".halt")):
            progress(lane, 100, "halted by halt file", "done")
            return 0
        progress(lane, 100 * (n - 1) // cycles, "cycle " + str(n), "running")
        r = subprocess.run([sys.executable, KIT, "spawn", "--root", os.getcwd(), "--code", "{repo_code}",
                            "--note", lane + "-cycle-" + str(n), "--kind", "build", "--prompt-file", prompt,
                            "--progress-task", lane], capture_output=True, text=True)
        if r.returncode != 0:
            progress(lane, 100 * n // cycles, "spawn refused or failed: rc " + str(r.returncode), "failed")
            return r.returncode
        if "NOTHING LEFT" in r.stdout:
            break
    progress(lane, 100, "finished", "done")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
