"""Runtime reaper (setup profile, item sc-runtime-ignored-reaped).

    python tools/reap_runtime.py            dry run
    python tools/reap_runtime.py --apply    delete what is over the limits

The gitignored .runtime/ folder holds regenerable output only: logs, journals, caches.
Files older than the retention go, then the oldest files until the folder is under the
size cap. The retention was proposed from the measured age histogram of this folder.
Only regenerable runtime files live here, so they are deleted, not recycled; anything
worth keeping belongs in the sidecar Archive area instead.
"""
import os
import sys
import time

RETENTION_DAYS = {runtime_retention_days}
MAX_BYTES = 100 * 1024 * 1024
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".runtime")


def listing():
    out = []
    for d, dirs, names in os.walk(ROOT, followlinks=False):
        dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(d, x))]
        for n in names:
            p = os.path.join(d, n)
            if not os.path.islink(p):
                st = os.stat(p)
                out.append((st.st_mtime, st.st_size, p))
    return sorted(out)


def main(argv):
    if not os.path.isdir(ROOT):
        return 0
    apply = "--apply" in argv
    cutoff = time.time() - RETENTION_DAYS * 86400
    rows = listing()
    total = sum(size for _, size, _ in rows)
    gone = 0
    for mtime, size, p in rows:
        if mtime >= cutoff and total <= MAX_BYTES:
            continue
        print("reap: %s %s" % ("delete" if apply else "would delete", os.path.relpath(p, ROOT)))
        if apply:
            os.remove(p)
        total -= size
        gone += 1
    print("reap: %d files %s" % (gone, "deleted" if apply else "to delete"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
