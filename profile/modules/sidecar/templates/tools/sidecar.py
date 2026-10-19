"""Sidecar areas (setup profile, item sc-sidecar-root).

    python tools/sidecar.py root           print the sidecar root of this repo
    python tools/sidecar.py init           create the five areas if missing
    python tools/sidecar.py path <area>    print one area: Worktree Scratch Temp Walk Archive

The root comes from git config --local profile.sidecarRoot (an empty value disables the
sidecar). It is the same for every worktree of the repo, so lanes and copies resolve to
one place. Repos stay small, backups stay lean, and heavy output has one known home.
"""
import os
import subprocess
import sys

AREAS = ("Worktree", "Scratch", "Temp", "Walk", "Archive")


def root():
    r = subprocess.run(["git", "config", "--get", "profile.sidecarRoot"], capture_output=True)
    value = r.stdout.decode("utf-8", "replace").strip()
    return value or None


def area(name):
    base = root()
    if base is None:
        raise SystemExit("sidecar: profile.sidecarRoot is not set (the sidecar is disabled)")
    if name not in AREAS:
        raise SystemExit("sidecar: unknown area %s (one of %s)" % (name, ", ".join(AREAS)))
    return os.path.join(base, name)


def main(argv):
    cmd = argv[1] if len(argv) > 1 else "root"
    if cmd == "root":
        print(root() or "")
        return 0 if root() else 1
    if cmd == "init":
        for name in AREAS:
            os.makedirs(area(name), exist_ok=True)
        print("sidecar: %s ready" % root())
        return 0
    if cmd == "path" and len(argv) == 3:
        print(area(argv[2]))
        return 0
    print(__doc__.strip(), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
