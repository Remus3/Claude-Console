"""Print each budgeted file against its size budget.

Usage: doc_budget.py [--repo DIR] [--memory DIR]
Budgets come from .claude/doc-budgets.json (KB). Exit 1 only when a HARD budget is
exceeded; warnings (and files at 90 percent of a hard budget) never fail.

  hard: claude_md_kb (CLAUDE.md), auto_loaded_kb (.claude/session-default.md),
        memory_index_kb (MEMORY.md), handoff_kb (*-NEXT-SESSION.txt),
        agent_file_kb (each .claude/agents/*.md)
  warn: memory_leaf_kb (each memory leaf), roadmap_kb (ROADMAP.md)
"""
import glob
import json
import os
import sys

HARD = {"claude_md_kb": ["CLAUDE.md"], "auto_loaded_kb": [".claude/session-default.md"],
        "handoff_kb": ["*-NEXT-SESSION.txt"], "agent_file_kb": [".claude/agents/*.md"]}
WARN = {"roadmap_kb": ["ROADMAP.md"]}


def rows(repo, memory, budgets):
    out = []
    def add(key, paths, hard):
        if key not in budgets:
            return
        limit = int(budgets[key]) * 1024
        for p in paths:
            size = os.path.getsize(p)
            if size > limit:
                level = "FAIL" if hard else "WARN"
            elif hard and size > limit * int(budgets.get("handoff_warn_pct", 90)) // 100:
                level = "WARN"
            else:
                level = "ok"
            out.append((level, key, os.path.relpath(p, repo), size, limit))
    for key, pats in HARD.items():
        add(key, [p for pat in pats for p in sorted(glob.glob(os.path.join(repo, pat)))], True)
    for key, pats in WARN.items():
        add(key, [p for pat in pats for p in sorted(glob.glob(os.path.join(repo, pat)))], False)
    if memory and os.path.isdir(memory):
        index = os.path.join(memory, "MEMORY.md")
        add("memory_index_kb", [index] if os.path.isfile(index) else [], True)
        leaves = [p for p in sorted(glob.glob(os.path.join(memory, "*.md"))) if os.path.basename(p) != "MEMORY.md"]
        add("memory_leaf_kb", leaves, False)
    return out


def main(argv):
    repo = argv[argv.index("--repo") + 1] if "--repo" in argv else os.getcwd()
    memory = argv[argv.index("--memory") + 1] if "--memory" in argv else None
    with open(os.path.join(repo, ".claude", "doc-budgets.json"), encoding="utf-8") as f:
        budgets = json.load(f)["budgets"]
    worst = 0
    for level, key, rel, size, limit in rows(repo, memory, budgets):
        pct = 100 * size // limit if limit else 0
        print(level.ljust(4) + " " + rel + " " + str(size) + " B / " + str(limit) + " B (" + str(pct) + "%) " + key)
        if level == "FAIL":
            worst = 1
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
