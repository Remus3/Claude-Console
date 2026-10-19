"""Impact-based test selection (setup profile, item ci-test-selection).

    python tools/select_tests.py <base-ref>

Prints FULL, NONE, or SELECT followed by test paths, from the files changed since
<base-ref>. Rules live in tools/test-select.txt. It escalates to FULL when a config file
changes, when a changed path matches no rule, or when more than MAX_PATHS paths changed:
a selection is an optimisation, never a reason to skip a test that might be affected.
"""
import fnmatch
import subprocess
import sys

MAX_PATHS = 300


def rules(path="tools/test-select.txt"):
    full, maps, ignore = [], [], []
    with open(path, encoding="ascii") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            kind, _, rest = line.partition(" ")
            if kind == "full":
                full.append(rest.strip())
            elif kind == "ignore":
                ignore.append(rest.strip())
            elif kind == "map":
                src, _, tests = rest.partition("->")
                maps.append((src.strip(), tests.split()))
    return full, maps, ignore


def main(argv):
    if len(argv) != 2:
        print("usage: select_tests.py <base-ref>", file=sys.stderr)
        return 2
    out = subprocess.run(["git", "diff", "--name-only", argv[1] + "...HEAD"], capture_output=True)
    if out.returncode != 0:
        print("FULL")
        return 0
    changed = [p for p in out.stdout.decode("utf-8", "replace").splitlines() if p]
    full, maps, ignore = rules()
    if len(changed) > MAX_PATHS:
        print("FULL")
        return 0
    picked = []
    for p in changed:
        if any(fnmatch.fnmatch(p, g) for g in full):
            print("FULL")
            return 0
        if any(fnmatch.fnmatch(p, g) for g in ignore):
            continue
        hit = [tests for src, tests in maps if fnmatch.fnmatch(p, src)]
        if not hit:
            print("FULL")
            return 0
        for tests in hit:
            picked.extend(t for t in tests if t not in picked)
    print("SELECT " + " ".join(picked) if picked else "NONE")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
