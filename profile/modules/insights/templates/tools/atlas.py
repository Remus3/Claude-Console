"""Atlas: one self-contained offline HTML page with the state of every repository.

Reads ops/roster.json and, read-only, each repository's git state and hand-off
next action. Writes {reports_dir}/atlas.html with no external resources. Skips the
write when nothing changed since the last run (state hash in {control_dir}).
"""
import hashlib
import html
import json
import os
import subprocess
import sys

OUT = os.path.join(r"{reports_dir}", "atlas.html")
STATE = os.path.join("{control_dir}", "atlas-state.json")


def git(root, *args):
    r = subprocess.run(["git", "-C", root] + list(args), capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ""


def next_action(root):
    for name in sorted(os.listdir(root)):
        if name.endswith("-NEXT-SESSION.txt"):
            with open(os.path.join(root, name), encoding="ascii", errors="replace") as f:
                lines = f.read().splitlines()
            for i, ln in enumerate(lines):
                if "NEXT ACTION" in ln.upper() and i + 1 < len(lines):
                    return lines[i + 1].strip("- ").strip()
    return ""


def main():
    with open(os.path.join("ops", "roster.json"), encoding="utf-8") as f:
        repos = [r for r in json.load(f)["repos"] if r.get("root") and not r.get("retired")]
    rows = []
    for r in repos:
        root = r["root"]
        rows.append([r["code"], git(root, "rev-parse", "--abbrev-ref", "HEAD"), git(root, "log", "-1", "--format=%cs %s"),
                     str(len(git(root, "status", "--porcelain").splitlines())), next_action(root)])
    digest = hashlib.sha256(json.dumps(rows).encode()).hexdigest()
    try:
        with open(STATE, encoding="utf-8") as f:
            if json.load(f).get("digest") == digest:
                print("skip: nothing changed")
                return 0
    except (OSError, ValueError):
        pass
    cells = "".join("<tr>" + "".join("<td>" + html.escape(c) + "</td>" for c in row) + "</tr>" for row in rows)
    page = ("<!doctype html><meta charset=utf-8><title>Atlas</title><style>body" + chr(123) + "font:14px sans-serif" + chr(125)
            + "td,th" + chr(123) + "padding:4px 8px;border-bottom:1px solid #ccc" + chr(125) + "</style>"
            + "<table><tr><th>Code</th><th>Branch</th><th>Last commit</th><th>Dirty</th><th>Next action</th></tr>"
            + cells + "</table>")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="ascii", errors="xmlcharrefreplace", newline="\n") as f:
        f.write(page)
    os.makedirs("{control_dir}", exist_ok=True)
    with open(STATE, "w", encoding="ascii", newline="\n") as f:
        json.dump({"digest": digest}, f)
    print("wrote atlas for " + str(len(rows)) + " repositories")
    return 0


if __name__ == "__main__":
    sys.exit(main())
