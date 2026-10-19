"""Move protocol (setup profile, item sc-move-protocol).

    python tools/sidecar_move.py <source> <area> [--apply]

Moves a folder or file into a sidecar area without ever losing it:
1. HOLD when anything tracked in the repo names the source (a consumer still uses it);
2. copy it (links are copied as links, never followed);
3. compare file count, bytes and sha256 of every file;
4. prove the Recycle Bin will take the source (size against the bin cap; no
   delete-immediately setting), then send the source to the Recycle Bin.
Without --apply it reports what it would do. Worktrees move with git worktree move instead.
Exit 0 = done, 1 = failed, 3 = HOLD (consumer), 4 = the bin cannot take it.
"""
import hashlib
import os
import re
import shutil
import subprocess
import sys


def files(top):
    out = dict()
    if os.path.isfile(top):
        return dict([(os.path.basename(top), top)])
    for d, dirs, names in os.walk(top, followlinks=False):
        dirs[:] = [x for x in dirs if not os.path.islink(os.path.join(d, x))]
        for n in names:
            p = os.path.join(d, n)
            out[os.path.relpath(p, top)] = p
    return out


def digest(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def same(src, dst):
    a, b = files(src), files(dst)
    if sorted(a) != sorted(b):
        return False
    for rel in a:
        if os.path.islink(a[rel]):
            continue
        if os.path.getsize(a[rel]) != os.path.getsize(b[rel]) or digest(a[rel]) != digest(b[rel]):
            return False
    return True


def bin_cap_bytes():
    """Smallest Recycle Bin cap configured for this user, or None when unknown."""
    if sys.platform != "win32":
        return None
    key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\BitBucket\\Volume"
    r = subprocess.run(["reg", "query", key, "/s"], capture_output=True)
    text = r.stdout.decode("utf-8", "replace")
    if re.search(r"NukeOnDelete\s+REG_DWORD\s+0x1\b", text):
        return 0
    caps = [int(m, 16) for m in re.findall(r"MaxCapacity\s+REG_DWORD\s+0x([0-9a-fA-F]+)", text)]
    return min(caps) * 1024 * 1024 if caps else None


def recycle(path):
    """Send path to the Recycle Bin; never unlink."""
    if sys.platform != "win32":
        if shutil.which("gio"):
            return subprocess.run(["gio", "trash", path]).returncode == 0
        print("move: no trash command here; move the source to the trash yourself", file=sys.stderr)
        return False
    kind = "DeleteDirectory" if os.path.isdir(path) else "DeleteFile"
    ps = ("Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::" + kind +
          "($env:PROFILE_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')")
    env = dict(os.environ, PROFILE_RECYCLE_PATH=path)
    r = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], env=env,
                       capture_output=True)
    return r.returncode == 0 and not os.path.exists(path)


def main(argv):
    if len(argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    src = os.path.abspath(argv[1])
    r = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "sidecar.py"), "path", argv[2]],
                       capture_output=True)
    if r.returncode != 0:
        print(r.stderr.decode("utf-8", "replace").strip(), file=sys.stderr)
        return 1
    dst = os.path.join(r.stdout.decode("utf-8", "replace").strip(), os.path.basename(src))
    g = subprocess.run(["git", "grep", "-l", "-F", os.path.basename(src)], capture_output=True)
    users = [x for x in g.stdout.decode("utf-8", "replace").splitlines() if x]
    if users:
        print("move: HOLD - tracked files name it: %s" % ", ".join(users[:5]), file=sys.stderr)
        return 3
    size = sum(os.path.getsize(p) for p in files(src).values() if not os.path.islink(p))
    cap = bin_cap_bytes()
    if cap is not None and size > cap:
        print("move: the Recycle Bin cannot take %d bytes (cap %d); free it or raise the cap" % (size, cap),
              file=sys.stderr)
        return 4
    if "--apply" not in argv:
        print("move: would copy %s to %s (%d bytes), compare, then recycle the source" % (src, dst, size))
        return 0
    if os.path.exists(dst):
        print("move: %s already exists" % dst, file=sys.stderr)
        return 1
    if os.path.isdir(src):
        shutil.copytree(src, dst, symlinks=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
    if not same(src, dst):
        print("move: the copy differs from the source; the source is kept", file=sys.stderr)
        return 1
    if not recycle(src):
        print("move: copied and verified, but the source could not be recycled", file=sys.stderr)
        return 1
    print("move: %s -> %s (verified, source in the Recycle Bin)" % (src, dst))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
