"""Runtime supervisor skeleton (setup profile, item rta-supervisor).

    python runtime/supervisor.py

One process owns runtime state: it refreshes a heartbeat lock, reconciles stale tasks and
dispatches ready tasks to their agent through runtime/spawn.py. This is a skeleton: the
project adds its own categories and agent mapping in AGENT_FOR. It opens no network port.
"""
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import task_queue  # noqa: E402

LOCK = os.path.join(HERE, "state", "supervisor.lock")
HEARTBEAT_S, RECONCILE_S, STALE_S, LIMBO_S = 5, 300, 1800, 7 * 86400
AGENT_FOR = dict()  # category -> agent charter file name, filled in by the project


def take_lock():
    os.makedirs(os.path.dirname(LOCK), exist_ok=True)
    try:
        st = os.stat(LOCK)
        if time.time() - st.st_mtime < 3 * HEARTBEAT_S:
            raise SystemExit("supervisor: another supervisor is alive")
    except FileNotFoundError:
        pass
    with open(LOCK, "w", encoding="ascii") as fh:
        fh.write(json.dumps(dict(pid=os.getpid())))


def beat():
    os.utime(LOCK, None)


def dispatch(task):
    import spawn
    charter = AGENT_FOR.get(task.get("category"))
    if not charter:
        return task_queue.transition(task["id"], "dead-letter", "no agent for category")
    result = spawn.run(os.path.join(HERE, "agents", charter), task)
    task_queue.transition(task["id"], "done" if result.get("ok") else "retry", result.get("why", ""))


def main():
    take_lock()
    last_reconcile = 0.0
    while True:
        beat()
        now = time.time()
        if now - last_reconcile >= RECONCILE_S:
            task_queue.reconcile(stale_s=STALE_S, limbo_s=LIMBO_S)
            last_reconcile = now
        task = task_queue.next_ready()
        if task:
            dispatch(task)
        else:
            time.sleep(HEARTBEAT_S)


if __name__ == "__main__":
    sys.exit(main())
