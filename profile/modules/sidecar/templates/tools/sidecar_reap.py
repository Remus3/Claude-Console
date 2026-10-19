"""Sidecar retention (setup profile, item sc-cleanup-policy).

    python tools/sidecar_reap.py --histogram     age histogram per area (input for the retention)
    python tools/sidecar_reap.py                 dry run: what would go
    python tools/sidecar_reap.py --apply         send it to the Recycle Bin

Applies to the per-run folders in Temp, Scratch and Walk. A folder's age is the age of the
NEWEST file inside it, not the folder's own timestamp. Worktree is handled by
tools/worktree_check.py and Archive is never cleaned automatically. The retention below was
proposed from this repo's measured age histogram, not picked as a round number. A folder
named by a tracked file is kept (it still has a consumer).
"""
import os
import subprocess
import sys
import time

RETENTION_DAYS = {sidecar_retention_days}
AREAS = ("Temp", "Scratch", "Walk")
BUCKETS = (1, 2, 7, 14, 30, 60, 90, 180, 365)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sidecar  # noqa: E402
import sidecar_move  # noqa: E402


def newest(top):
    best = os.path.getmtime(top)
    for d, dirs, names in os.walk(top, followlinks=False):
        dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(d, x))]
        for n in names:
            try:
                best = max(best, os.lstat(os.path.join(d, n)).st_mtime)
            except OSError:
                pass
    return best


def runs():
    now = time.time()
    for a in AREAS:
        base = sidecar.area(a)
        if not os.path.isdir(base):
            continue
        for n in sorted(os.listdir(base)):
            p = os.path.join(base, n)
            if os.path.islink(p):
                continue
            yield a, p, (now - newest(p)) / 86400.0


def consumer(path):
    g = subprocess.run(["git", "grep", "-l", "-F", os.path.basename(path)], capture_output=True)
    return bool(g.stdout.strip())


def main(argv):
    rows = list(runs())
    if "--histogram" in argv:
        for a in AREAS:
            ages = [age for area, _, age in rows if area == a]
            counts = [sum(1 for x in ages if x <= b) for b in BUCKETS]
            print("%s: %d runs; at most N days old: %s" % (a, len(ages), " ".join(
                "%d:%d" % (b, c) for b, c in zip(BUCKETS, counts))))
        return 0
    bad = 0
    for a, p, age in rows:
        if age <= RETENTION_DAYS:
            continue
        if consumer(p):
            print("reap: keep %s (named by a tracked file)" % p)
            continue
        if "--apply" not in argv:
            print("reap: would recycle %s (%.0f days)" % (p, age))
        elif sidecar_move.recycle(p):
            print("reap: recycled %s" % p)
        else:
            print("reap: could not recycle %s" % p, file=sys.stderr)
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
