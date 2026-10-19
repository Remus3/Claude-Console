"""Claims check for multi-builder rounds: re-measure every claim a report makes.

Usage: claims_check.py <claims.json>
claims.json: {"files": [paths that must exist], "absent": [paths that must not],
              "counts": {"<label>": {"command": [argv...], "expect": <int>}}}
Each count command must print an integer. Exit 0 when every claim holds; exit 2
(REFUSE) on the first unbacked claim, naming it.
"""
import json
import os
import subprocess
import sys


def main(argv):
    if len(argv) != 1:
        print("usage: claims_check.py <claims.json>")
        return 1
    with open(argv[0], encoding="utf-8") as f:
        claims = json.load(f)
    for p in claims.get("files", []):
        if not os.path.exists(p):
            print("REFUSE missing file " + p)
            return 2
    for p in claims.get("absent", []):
        if os.path.exists(p):
            print("REFUSE file still present " + p)
            return 2
    for label, c in sorted(claims.get("counts", {}).items()):
        r = subprocess.run(c["command"], capture_output=True, text=True)
        try:
            got = int(r.stdout.strip().split()[-1])
        except (ValueError, IndexError):
            print("REFUSE " + label + ": no number in the output")
            return 2
        if got != int(c["expect"]):
            print("REFUSE " + label + ": claimed " + str(c["expect"]) + ", measured " + str(got))
            return 2
    print("OK all claims re-measured")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
