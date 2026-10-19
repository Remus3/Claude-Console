"""Read-only census of the Temp folder: which name prefixes hold the files.

Usage: temp_census.py [--top 20]
Groups top-level entries by their name prefix (letters before the first digit,
dash or underscore) and prints file count and size per prefix. Deletes nothing.
"""
import os
import re
import sys
import tempfile


def prefix(name):
    m = re.match(r"[A-Za-z.]+", name)
    return (m.group(0) if m else name[:4]).lower()


def main(argv):
    top = int(argv[argv.index("--top") + 1]) if "--top" in argv else 20
    root = tempfile.gettempdir()
    groups = {}
    for entry in os.scandir(root):
        n, size = 0, 0
        if entry.is_dir(follow_symlinks=False):
            for dirpath, _, files in os.walk(entry.path):
                for f in files:
                    n += 1
                    try:
                        size += os.path.getsize(os.path.join(dirpath, f))
                    except OSError:
                        pass
        else:
            n, size = 1, entry.stat().st_size
        g = groups.setdefault(prefix(entry.name), [0, 0, 0])
        g[0] += 1
        g[1] += n
        g[2] += size
    for k, (entries, files, size) in sorted(groups.items(), key=lambda kv: -kv[1][1])[:top]:
        print(str(files).rjust(9) + " files " + str(size // 1048576).rjust(7) + " MB " + str(entries).rjust(6) + " entries  " + k)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
