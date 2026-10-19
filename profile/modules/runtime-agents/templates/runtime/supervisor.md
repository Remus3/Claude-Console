# Runtime supervisor (charter)

The supervisor is the one owner of runtime state for an app whose agents keep working
while no Claude session is open (setup profile, item rta-supervisor).

- Heartbeat: a lock file refreshed every 5 seconds; a second supervisor refuses to start.
- Reconcile: every 5 minutes, tasks running for more than 30 minutes are marked stale and
  retried once or dead-lettered.
- Gate limbo: tasks waiting on a gate for more than 7 days are reaped to dead-letter.
- Dispatch: ready tasks go to their numbered agent (charters in runtime/agents/), each
  run through runtime/spawn.py with its charter, budget and timeout.
- Writes: runtime state only. Code changes come from agents, inside their write-lists.
- Start it with a logon task or by hand; the profile does not register one for you.
