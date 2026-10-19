"""Project slug resolver (setup profile, item rec-project-slug).

    python tools/project_slug.py

Prints the Claude project folder for this repo, resolved from any worktree to the main
checkout (Claude names it after the absolute path with every non-alphanumeric character
replaced by '-'), and lists other project folders that look like stale copies of this
repo, for example after the repo moved to another drive or folder.
"""
import os
import re
import subprocess
import sys


def main_checkout():
    r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True)
    common = r.stdout.decode("utf-8", "replace").strip()
    return os.path.dirname(common) if r.returncode == 0 and common else os.getcwd()


def slug(path):
    return re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(path))


def main():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    projects = os.path.join(base, "projects")
    root = main_checkout()
    mine = slug(root)
    here = os.path.join(projects, mine)
    print("project folder: %s (%s)" % (here, "present" if os.path.isdir(here) else "missing"))
    tail = "-" + slug(os.path.basename(root))
    try:
        others = [n for n in os.listdir(projects) if n != mine and n.endswith(tail)]
    except OSError:
        others = []
    for n in sorted(others):
        print("possible stale copy: %s" % os.path.join(projects, n))
    return 0


if __name__ == "__main__":
    sys.exit(main())
