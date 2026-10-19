"""Pre-commit content gate (setup profile, item ci-hook-pre-commit-content).

Reads the INDEX, never the working tree, so it judges exactly what will be committed:
- added lines are ASCII, and LF unless .gitattributes marks the file eol=crlf;
- added lines carry no secret-shaped string (the finding never prints the match);
- staged .py files compile and staged .json files parse;
- staged files named in .githooks/md-budgets.txt fit their budget: a warning at
  warn_pct percent of it, a refusal above it (move detail to an archive with a pointer).
Exit 0 = pass, 1 = refused, one line per finding on stderr.
"""
import fnmatch
import json
import os
import re
import subprocess
import sys

TEXT_EXT = (".py", ".ps1", ".psm1", ".sh", ".md", ".txt", ".json", ".yml", ".yaml", ".toml",
            ".ini", ".cfg", ".js", ".mjs", ".cjs", ".ts", ".css", ".html", ".xml", ".csv")
SECRET = re.compile(r"sk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}"
                    r"|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[abprs]-[A-Za-z0-9-]{10,}")
NON_ASCII = re.compile(rb"[^\x09\x0a\x0d\x20-\x7e]")


def git(*args):
    return subprocess.run(["git"] + list(args), capture_output=True).stdout


def staged():
    out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    return [p for p in out.decode("utf-8", "replace").split("\0") if p]


def crlf_allowed(path):
    out = git("check-attr", "eol", "--", path).decode("utf-8", "replace").strip()
    return out.endswith(": crlf")


def added_lines(path):
    out = git("diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--", path)
    return [raw[1:] for raw in out.split(b"\n") if raw.startswith(b"+") and not raw.startswith(b"+++")]


def budgets(root):
    warn, rows = 90, []
    try:
        with open(os.path.join(root, ".githooks", "md-budgets.txt"), encoding="ascii") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                key, _, val = line.rpartition(" ")
                if key == "warn_pct":
                    warn = int(val)
                elif key:
                    rows.append((key, int(val)))
    except (OSError, ValueError):
        pass
    return warn, rows


def check(path, blob, warn_pct, rows):
    found = []
    if path.lower().endswith(TEXT_EXT) and b"\0" not in blob[:8000]:
        lines = added_lines(path)
        if any(NON_ASCII.search(x) for x in lines):
            found.append("non-ASCII byte in an added line")
        if not crlf_allowed(path) and any(x.endswith(b"\r") for x in lines):
            found.append("CR line ending in an added line (LF only)")
        if any(SECRET.search(x.decode("latin-1")) for x in lines):
            found.append("secret-shaped string in an added line (move it to a secret store)")
        if path.lower().endswith(".py"):
            try:
                compile(blob, path, "exec")
            except SyntaxError as e:
                found.append("does not compile (line %s)" % e.lineno)
        elif path.lower().endswith(".json"):
            try:
                json.loads(blob.decode("utf-8"))
            except ValueError as e:
                found.append("invalid JSON (%s)" % e)
    for pattern, kb in rows:
        if fnmatch.fnmatch(path, pattern):
            limit = kb * 1024
            if len(blob) > limit:
                found.append("%d bytes, over its %d KB budget (relocate detail with a pointer)" % (len(blob), kb))
            elif len(blob) * 100 >= limit * warn_pct:
                print("pre-commit: warning: %s is at %d%% of its %d KB budget"
                      % (path, len(blob) * 100 // limit, kb), file=sys.stderr)
            break
    return found


def main():
    root = git("rev-parse", "--show-toplevel").decode("utf-8", "replace").strip()
    warn_pct, rows = budgets(root)
    bad = 0
    for path in staged():
        for finding in check(path, git("show", ":" + path), warn_pct, rows):
            print("pre-commit: %s: %s" % (path, finding), file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
