"""Gate verdict cache (setup profile, item ci-verdict-cache).

    python .githooks/checks/verdict_cache.py check  <range> <file>...
    python .githooks/checks/verdict_cache.py record <range> <file>...

A PASS is cached under a key made from the commit range and the bytes of every gate file
named (hook and check scripts). Pushing the same range to several remotes then runs the
gates once. Any change to a gate file or the range changes the key; failures are never
cached. Cache: .git/profile-verdicts/ (never tracked).
"""
import hashlib
import os
import subprocess
import sys


def key(rng, files):
    h = hashlib.sha256()
    h.update(rng.encode("utf-8"))
    for f in sorted(files):
        h.update(b"\0" + f.encode("utf-8") + b"\0")
        with open(f, "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()


def cache_dir():
    git_dir = subprocess.run(["git", "rev-parse", "--git-common-dir"], capture_output=True)
    d = os.path.join(git_dir.stdout.decode("utf-8", "replace").strip(), "profile-verdicts")
    os.makedirs(d, exist_ok=True)
    return d


def main(argv):
    if len(argv) < 4 or argv[1] not in ("check", "record"):
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    path = os.path.join(cache_dir(), key(argv[2], argv[3:]))
    if argv[1] == "check":
        return 0 if os.path.exists(path) else 1
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii") as fh:
        fh.write("PASS\n")
    os.replace(tmp, path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
