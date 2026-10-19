"""Send finished progress files older than N days to the Recycle Bin.

Usage: progress_prune.py [--days 7] [--apply]
Without --apply it lists what it would move (dry run). Only files whose status is
done, failed or abandoned qualify; running ones are never touched. On Windows the
file goes to the Recycle Bin through the shell; elsewhere the tool refuses rather
than unlinking.
"""
import json
import os
import subprocess
import sys
import time

PROGRESS = os.path.join("{control_dir}", "progress")
FINISHED = ("done", "failed", "abandoned")


def recycle(path):
    if sys.platform != "win32":
        raise RuntimeError("no Recycle Bin on this platform; move the file yourself")
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; "
          "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:PRUNE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')")
    env = dict(os.environ, PRUNE_PATH=os.path.abspath(path))
    subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], check=True, env=env,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))


def candidates(root, days, now):
    out = []
    d = os.path.join(root, PROGRESS)
    if not os.path.isdir(d):
        return out
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        if not name.endswith(".json") or not os.path.isfile(p):
            continue
        try:
            with open(p, encoding="utf-8") as f:
                status = json.load(f).get("status")
        except (OSError, ValueError):
            continue
        if status in FINISHED and now - os.path.getmtime(p) > days * 86400:
            out.append(p)
    return out


def main(argv):
    days = 7
    if "--days" in argv:
        days = int(argv[argv.index("--days") + 1])
    files = candidates(os.getcwd(), days, time.time())
    for p in files:
        if "--apply" in argv:
            recycle(p)
            print("recycled " + os.path.relpath(p))
        else:
            print("would recycle " + os.path.relpath(p))
    print(str(len(files)) + " file(s)" + ("" if "--apply" in argv else " (dry run)"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
