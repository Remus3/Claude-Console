"""Toolchain check (setup profile, item ci-verify-env).

    python tools/verify_env.py

Compares the versions of the tools in toolchain.txt with what is installed, before a suite
runs, so counts measured under a different interpreter or environment are caught.
toolchain.txt: one line per tool, '<name> <version prefix>' (for example 'python 3.12').
Exit 0 = all match, 1 = a mismatch or a missing tool.
"""
import re
import subprocess
import sys

PROBES = (
    ("python", [sys.executable, "--version"]),
    ("node", ["node", "--version"]),
    ("git", ["git", "--version"]),
    ("pytest", [sys.executable, "-m", "pytest", "--version"]),
    ("npm", ["npm.cmd" if sys.platform == "win32" else "npm", "--version"]),
)


def installed(cmd):
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(r"(\d+\.\d+(?:\.\d+)?)", (r.stdout + r.stderr).decode("utf-8", "replace"))
    return m.group(1) if m else None


def main():
    want = []
    with open("toolchain.txt", encoding="ascii") as fh:
        for line in fh:
            line = line.strip()
            if line and not line.startswith("#"):
                name, _, ver = line.partition(" ")
                want.append((name, ver.strip()))
    probes = dict(PROBES)
    bad = 0
    for name, ver in want:
        have = installed(probes[name]) if name in probes else None
        if have is None or not have.startswith(ver):
            print("verify-env: %s wants %s, found %s" % (name, ver, have or "nothing"), file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
