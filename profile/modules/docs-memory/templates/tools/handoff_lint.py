"""Lint the hand-off file before /done commits it.

Usage: handoff_lint.py [path]   (default: the repo's *-NEXT-SESSION.txt)
Fails (exit 1) when the file is under 2,000 bytes, has not exactly one SESSION:
line (and it is line 1), has more than one fenced block, carries a byte outside
ASCII, or holds a secret-shaped string or a user home path.
"""
import glob
import re
import sys

SECRET = re.compile("sk-" + r"ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b")
HOME = re.compile(r"(?i)\b[a-z]:[\\/]users[\\/]|[/]home[/][a-z]")


def problems(data):
    out = []
    if len(data) < 2000:
        out.append("under 2,000 bytes - truncated?")
    if any(b > 126 or (b < 32 and b not in (9, 10)) for b in data):
        out.append("non-ASCII or control byte")
    text = data.decode("ascii", errors="replace")
    lines = text.split("\n")
    if sum(1 for ln in lines if ln.startswith("SESSION:")) != 1 or not lines[0].startswith("SESSION:"):
        out.append("needs exactly one SESSION: line, on line 1")
    if text.count("```") > 2:
        out.append("more than one fenced block")
    if SECRET.search(text):
        out.append("secret-shaped string")
    if HOME.search(text):
        out.append("user home path")
    return out


def main(argv):
    paths = argv or sorted(glob.glob("*-NEXT-SESSION.txt"))
    if not paths:
        print("no hand-off file")
        return 1
    with open(paths[0], "rb") as f:
        found = problems(f.read())
    for p in found:
        print("FAIL " + p)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
