# Agent 1: Lead (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
The only writer of the append-only task queue. It routes each new task by category: hard-gated categories wait for your approval, policy-gated ones go to the gatekeeper, the rest become ready for their owning agent.

## Writes
The task queue file, nothing else.

## Never
Code, tests, UI files, prompts. Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
In-process, on every new task.

## Model
None: deterministic routing.

## Order
1. Every task passes through it once.

## Output
Task state changes in the queue: waiting-approval, policy-gate, ready, dead-letter.
