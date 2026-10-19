"""Memory validator (setup profile, item rec-memory-validate).

    python tools/memory_validate.py [--dir <memory dir>]

Checks the memory folder of this project: every leaf has name, description and type in
its frontmatter; every leaf is reachable from MEMORY.md (directly or through an
INDEX_*.md it links); MEMORY.md stays under 20 KB and each leaf under 6 KB (warning).
An unindexed leaf is never recalled, and an oversized index costs context every session.
Without --dir it uses the Claude project folder of the main checkout.
Exit 0 = valid, 1 = findings.
"""
import os
import re
import subprocess
import sys

INDEX_KB, LEAF_KB = 20, 6
LINK = re.compile(r"\(([^)\s]+\.md)\)|\[\[([^\]]+)\]\]")


def default_dir():
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True)
    common = r.stdout.decode("utf-8", "replace").strip()
    main = os.path.dirname(common) if common else os.getcwd()
    slug = re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(main))
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "projects", slug, "memory")


def frontmatter(text):
    if not text.startswith("---\n"):
        return dict()
    end = text.find("\n---", 4)
    if end < 0:
        return dict()
    out = dict()
    for line in text[4:end].splitlines():
        k, sep, v = line.partition(":")
        if sep:
            out[k.strip()] = v.strip()
    return out


def links(text):
    out = []
    for a, b in LINK.findall(text):
        name = a or (b if b.endswith(".md") else b + ".md")
        out.append(os.path.basename(name))
    return out


def main(argv):
    d = argv[argv.index("--dir") + 1] if "--dir" in argv else default_dir()
    index = os.path.join(d, "MEMORY.md")
    if not os.path.isfile(index):
        print("memory: no MEMORY.md in %s" % d, file=sys.stderr)
        return 1
    leaves = [n for n in os.listdir(d) if n.endswith(".md") and n != "MEMORY.md"]
    bad = 0
    if os.path.getsize(index) > INDEX_KB * 1024:
        print("memory: MEMORY.md is over %d KB; split it into domain indexes" % INDEX_KB, file=sys.stderr)
        bad += 1
    seen, todo = set(), ["MEMORY.md"]
    while todo:
        name = todo.pop()
        if name in seen or not os.path.isfile(os.path.join(d, name)):
            continue
        seen.add(name)
        with open(os.path.join(d, name), encoding="utf-8", errors="replace") as fh:
            body = fh.read()
        todo.extend(links(body))
    for n in sorted(leaves):
        p = os.path.join(d, n)
        with open(p, encoding="utf-8", errors="replace") as fh:
            meta = frontmatter(fh.read())
        if not n.startswith("INDEX_"):
            missing = [k for k in ("name", "description", "type") if not meta.get(k)]
            if missing:
                print("memory: %s: frontmatter lacks %s" % (n, ", ".join(missing)), file=sys.stderr)
                bad += 1
            if os.path.getsize(p) > LEAF_KB * 1024:
                print("memory: warning: %s is over %d KB" % (n, LEAF_KB), file=sys.stderr)
        if n not in seen:
            print("memory: %s is not reachable from MEMORY.md" % n, file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
