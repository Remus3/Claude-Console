"""PostToolUse edit guard (setup profile, item ci-posttooluse-edit-guard).

After an Edit or Write it checks the touched file: ASCII only, LF only (unless
.gitattributes marks it eol=crlf), Python compiles, JSON parses. Silent when clean. On a
problem it prints ONE line on stderr and exits 2, so Claude fixes it in the same turn
instead of at commit time.
"""
import json
import os
import subprocess
import sys

TEXT_EXT = (".py", ".ps1", ".psm1", ".sh", ".md", ".txt", ".json", ".yml", ".yaml", ".toml",
            ".ini", ".cfg", ".js", ".mjs", ".cjs", ".ts", ".css", ".html", ".xml", ".csv")


def crlf_ok(path):
    r = subprocess.run(["git", "check-attr", "eol", "--", os.path.basename(path)],
                       cwd=os.path.dirname(path) or ".", capture_output=True)
    return r.stdout.decode("utf-8", "replace").strip().endswith(": crlf")


def problems(path, blob):
    out = []
    low = path.lower()
    if not low.endswith(TEXT_EXT) or b"\0" in blob[:8000]:
        return out
    if any(b > 126 or (b < 32 and b not in (9, 10, 13)) for b in blob):
        out.append("non-ASCII or control byte")
    if b"\r" in blob and not crlf_ok(path):
        out.append("CR line ending (LF only)")
    if low.endswith(".py"):
        try:
            compile(blob, path, "exec")
        except SyntaxError as e:
            out.append("does not compile (line %s)" % e.lineno)
    elif low.endswith(".json"):
        try:
            json.loads(blob.decode("utf-8"))
        except ValueError as e:
            out.append("invalid JSON (%s)" % e)
    return out


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    path = (data.get("tool_input") or dict()).get("file_path") or ""
    if not path or not os.path.isfile(path):
        return 0
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError:
        return 0
    found = problems(path, blob)
    if not found:
        return 0
    print("edit guard: %s: %s" % (os.path.basename(path), ", ".join(found)), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
