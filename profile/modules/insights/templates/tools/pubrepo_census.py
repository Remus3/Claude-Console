"""Public-repository posture: what an outsider sees first. Read-only.

Usage: pubrepo_census.py
Scans the tracked files, the commit subjects and the tag names of this repository
for user home paths, email addresses and token-shaped strings, and prints one line
per hit (file and line, never the matched value).
"""
import re
import subprocess
import sys

PATTERNS = {
    "home path": re.compile(r"(?i)\b[a-z]:[\\/]users[\\/][^\\/\s]+|[/]home[/][a-z]"),
    "email": re.compile(r"[A-Za-z0-9._%+-]+[@][A-Za-z0-9-]+[.][A-Za-z]{2,}"),
    "token": re.compile("sk-" + r"ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b"),
}


def git(*args):
    return subprocess.run(["git"] + list(args), capture_output=True, text=True, errors="replace").stdout


def main():
    hits = 0
    for path in git("ls-files").splitlines():
        try:
            with open(path, encoding="utf-8", errors="replace") as f:
                for n, line in enumerate(f, 1):
                    for label, rx in PATTERNS.items():
                        if rx.search(line):
                            print(label + ": " + path + ":" + str(n))
                            hits += 1
        except OSError:
            continue
    for label, rx in PATTERNS.items():
        for n, subject in enumerate(git("log", "--format=%s").splitlines(), 1):
            if rx.search(subject):
                print(label + ": commit subject #" + str(n))
                hits += 1
        for tag in git("tag").splitlines():
            if rx.search(tag):
                print(label + ": tag " + str(len(tag)) + " chars")
                hits += 1
    print(str(hits) + " hit(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
