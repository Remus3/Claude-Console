"""Single-writer task queue (setup profile, item rta-task-queue).

Append-only JSON lines in runtime/state/task_queue.jsonl. Only the lead writes it: every
write takes an exclusive lock file first, so two writers can never interleave and lose a
task. The current state of a task is its last line. Categories map to a gate: hard gate
(waits for your approval), policy gate (gatekeeper), or ready. A failed task retries once,
then goes to dead-letter. The file rotates past MAX_BYTES so it cannot grow without limit.
"""
import json
import os
import time

HERE = os.path.dirname(os.path.abspath(__file__))
QUEUE = os.path.join(HERE, "state", "task_queue.jsonl")
LOCKF = QUEUE + ".lock"
MAX_BYTES = 8 * 1024 * 1024
HARD_GATE, POLICY_GATE = set(), set()  # categories, filled in by the project


class Locked(object):
    def __enter__(self):
        os.makedirs(os.path.dirname(QUEUE), exist_ok=True)
        for _ in range(200):
            try:
                self.fd = os.open(LOCKF, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return self
            except FileExistsError:
                time.sleep(0.05)
        raise RuntimeError("queue lock busy")

    def __exit__(self, *exc):
        os.close(self.fd)
        os.remove(LOCKF)


def _append(row):
    row["at"] = time.time()
    with Locked():
        if os.path.exists(QUEUE) and os.path.getsize(QUEUE) > MAX_BYTES:
            os.replace(QUEUE, QUEUE + ".%d" % int(time.time()))
        with open(QUEUE, "a", encoding="ascii") as fh:
            fh.write(json.dumps(row, ensure_ascii=True) + "\n")


def states():
    out = dict()
    try:
        with open(QUEUE, encoding="ascii") as fh:
            for line in fh:
                row = json.loads(line)
                out[row["id"]] = row
    except FileNotFoundError:
        pass
    return out


def file_task(task_id, category, text):
    gate = "waiting-approval" if category in HARD_GATE else "policy-gate" if category in POLICY_GATE else "ready"
    _append(dict(id=task_id, category=category, text=text, state=gate, tries=0))


def transition(task_id, state, why=""):
    row = dict(states().get(task_id) or dict(id=task_id))
    if state == "retry":
        state = "dead-letter" if row.get("tries", 0) >= 1 else "ready"
        row["tries"] = row.get("tries", 0) + 1
    row.update(state=state, why=why)
    _append(row)


def next_ready():
    for row in states().values():
        if row.get("state") == "ready":
            transition(row["id"], "running")
            return row
    return None


def reconcile(stale_s, limbo_s):
    now = time.time()
    for row in list(states().values()):
        age = now - row.get("at", now)
        if row.get("state") == "running" and age > stale_s:
            transition(row["id"], "retry", "stale")
        elif row.get("state") in ("waiting-approval", "policy-gate") and age > limbo_s:
            transition(row["id"], "dead-letter", "gate limbo")
