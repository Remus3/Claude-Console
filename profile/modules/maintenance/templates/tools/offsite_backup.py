"""Off-machine git backup: incremental bundles to a second machine over ssh.

Usage: offsite_backup.py run [--min-age-hours 4] | status
For this repository: create a bundle of the refs changed since the last run (a full
bundle once a week), copy it with scp to {backup_target}:<path>/<code>/, verify the
remote copy's size, then record the run in {control_dir}/offsite-backup.json.
Skips when the last success is younger than --min-age-hours. Uses only the ssh
alias you configured; never stores a key or password.
"""
import json
import os
import subprocess
import sys
import time

STATE = os.path.join("{control_dir}", "offsite-backup.json")
TARGET = "{backup_target}"
REMOTE_DIR = "backups/{repo_code}"


def load():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(doc):
    os.makedirs("{control_dir}", exist_ok=True)
    with open(STATE, "w", encoding="ascii", newline="\n") as f:
        json.dump(doc, f, indent=1)


def run(min_age_h):
    st = load()
    if time.time() - st.get("last_success", 0) < min_age_h * 3600:
        print("skip: last success is recent")
        return 0
    full = time.time() - st.get("last_full", 0) > 7 * 86400
    stamp = time.strftime("%Y%m%d-%H%M%S")
    bundle = os.path.join("{control_dir}", "bundle-" + stamp + (".full" if full else "") + ".bundle")
    revs = ["--all"] if full or not st.get("last_head") else [st["last_head"] + "..HEAD", "--branches", "--tags"]
    subprocess.run(["git", "bundle", "create", bundle] + revs, check=True)
    subprocess.run(["ssh", TARGET, "mkdir", "-p", REMOTE_DIR], check=True)
    subprocess.run(["scp", "-q", bundle, TARGET + ":" + REMOTE_DIR + "/"], check=True)
    remote = subprocess.run(["ssh", TARGET, "wc", "-c", "<", REMOTE_DIR + "/" + os.path.basename(bundle)],
                            capture_output=True, text=True, check=True).stdout.strip()
    if int(remote or 0) != os.path.getsize(bundle):
        print("FAIL remote size differs")
        return 1
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    st.update({"last_success": int(time.time()), "last_head": head, "ok": True})
    if full:
        st["last_full"] = int(time.time())
    save(st)
    os.remove(bundle)
    print("ok " + os.path.basename(bundle))
    return 0


def main(argv):
    if argv[:1] == ["status"]:
        st = load()
        print(json.dumps({"ok": st.get("ok", False), "last_success": st.get("last_success")}))
        return 0
    if argv[:1] == ["run"]:
        age = float(argv[argv.index("--min-age-hours") + 1]) if "--min-age-hours" in argv else 0
        return run(age)
    print("usage: offsite_backup.py run [--min-age-hours H] | status")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
