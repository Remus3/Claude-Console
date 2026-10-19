"""Pre-push leak scan (setup profile, item ci-hook-pre-push-leak).

Grades EVERY commit in the pushed range (refs read once from standard input), not just
HEAD: added lines and the commit message are scanned for secret-shaped strings, machine
paths and the private needles in .git/info/leak-needles.txt. That file holds one needle
per line (your user name, host name, private project names) and is never tracked.
Findings name the commit, the file and the kind of hit, never the matched text.
Exit 0 = clean, 2 = HALT (findings), 3 = FAULT (could not scan).
"""
import os
import re
import subprocess
import sys

ZERO = "0" * 40
SECRET = re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
                    r"|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[abprs]-[A-Za-z0-9-]{10,}")
MACHINE_PATH = re.compile(r"\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\s]+"
                          r"|/(?:home)/[A-Za-z0-9._-]+/|[\\/]Users[\\/][A-Za-z0-9._-]+[\\/]")


class Fault(Exception):
    pass


def git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True)
    if r.returncode != 0:
        raise Fault("git %s failed" % args[0])
    return r.stdout.decode("utf-8", "replace")


def needles(root):
    path = os.path.join(root, ".git", "info", "leak-needles.txt")
    try:
        with open(path, encoding="utf-8") as fh:
            rows = [x.strip().lower() for x in fh if x.strip() and not x.startswith("#")]
    except OSError:
        return []
    return [x for x in rows if len(x) >= 3]


def commits(local, remote):
    if remote == ZERO:
        out = git("rev-list", local, "--not", "--remotes")
    else:
        out = git("rev-list", "%s..%s" % (remote, local))
    return [c for c in out.split() if c]


def scan_commit(c, private):
    hits = []
    text = git("show", "--format=%B%x00", "-U0", "--no-color", "--no-ext-diff", c)
    message, _, diff = text.partition("\0")
    rows = [("(message)", message)]
    current = "(unknown)"
    for line in diff.split("\n"):
        if line.startswith("+++ "):
            current = line[6:] if line.startswith("+++ b/") else line[4:]
        elif line.startswith("+"):
            rows.append((current, line[1:]))
    for where, body in rows:
        low = body.lower()
        if SECRET.search(body):
            hits.append((where, "secret-shaped string"))
        if MACHINE_PATH.search(body):
            hits.append((where, "machine path"))
        if any(n in low for n in private):
            hits.append((where, "private needle"))
    return sorted(set(hits))


def main():
    try:
        root = git("rev-parse", "--show-toplevel").strip()
        private = needles(root)
        found = 0
        for line in sys.stdin.read().splitlines():
            parts = line.split()
            if len(parts) != 4 or parts[1] == ZERO:
                continue
            for c in commits(parts[1], parts[3]):
                for where, kind in scan_commit(c, private):
                    print("pre-push: %s %s: %s" % (c[:10], where, kind), file=sys.stderr)
                    found += 1
    except Fault as e:
        print("pre-push: %s" % e, file=sys.stderr)
        return 3
    return 2 if found else 0


if __name__ == "__main__":
    sys.exit(main())
