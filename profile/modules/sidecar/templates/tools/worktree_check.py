"""Worktree removal check (setup profile, item sc-worktree-area).

    python tools/worktree_check.py <worktree> [--base <branch>] [--remove]

Reports whether a linked worktree can go: its HEAD is merged into the base branch, its
status is clean, it is not locked, and its ignored files are listed (a worktree never
had the main checkout's ignored files, but it may have made its own). With --remove it
saves the HEAD under refs/profile-archive/<name> when anything is unmerged and then
runs git worktree remove, refusing on any open check.
Exit 0 = removable (or removed), 1 = blocked, 2 = usage.
"""
import os
import subprocess
import sys


def git(*args, cwd=None):
    r = subprocess.run(["git"] + list(args), cwd=cwd, capture_output=True)
    return r.returncode, r.stdout.decode("utf-8", "replace").strip()


def main(argv):
    if len(argv) < 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    wt = os.path.abspath(argv[1])
    base = argv[argv.index("--base") + 1] if "--base" in argv else "main"
    blocked = []
    rc, head = git("rev-parse", "HEAD", cwd=wt)
    if rc != 0:
        print("worktree: %s is not a git worktree" % wt, file=sys.stderr)
        return 1
    rc, _ = git("merge-base", "--is-ancestor", head, base, cwd=wt)
    merged = rc == 0
    if not merged:
        blocked.append("HEAD is not merged into %s" % base)
    rc, status = git("status", "--porcelain", cwd=wt)
    if status:
        blocked.append("uncommitted changes")
    rc, gitdir = git("rev-parse", "--absolute-git-dir", cwd=wt)
    if os.path.exists(os.path.join(gitdir, "locked")):
        blocked.append("worktree is locked (a live lane may own it)")
    rc, ignored = git("status", "--ignored", "--porcelain", cwd=wt)
    extra = [x[3:] for x in ignored.splitlines() if x.startswith("!!")]
    for x in extra:
        print("worktree: ignored file to back up first: %s" % x)
    if extra and "--ignored-backed-up" not in argv:
        blocked.append("ignored files present (back them up, then pass --ignored-backed-up)")
    if "--remove" not in argv:
        for b in blocked:
            print("worktree: blocked: %s" % b)
        return 1 if blocked else 0
    if [b for b in blocked if not b.startswith("HEAD is not merged")]:
        for b in blocked:
            print("worktree: blocked: %s" % b, file=sys.stderr)
        return 1
    if not merged:
        name = os.path.basename(wt.rstrip("\\/"))
        rc, _ = git("update-ref", "refs/profile-archive/" + name, head, cwd=wt)
        if rc != 0:
            print("worktree: could not save the unmerged HEAD; nothing removed", file=sys.stderr)
            return 1
        print("worktree: unmerged HEAD saved as refs/profile-archive/%s" % name)
    rc, out = git("worktree", "remove", wt)
    if rc != 0:
        print("worktree: git worktree remove failed: %s" % out, file=sys.stderr)
        return 1
    print("worktree: removed %s" % wt)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
