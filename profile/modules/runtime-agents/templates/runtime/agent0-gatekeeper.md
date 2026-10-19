# Agent 0: Gatekeeper (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
Deterministic policy gate for tasks the lead routes to it. It checks each task against a fixed list of criteria (allowed operation, target inside the allow list, size limits, required fields, no frozen file, no duplicate) and answers accept or reject with the criterion number. It is a policy check, not a security boundary.

## Writes
Decision records in the task queue only (through the lead).

## Never
Code, prompts, charters, the queue file itself. Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
In-process, for every task in a policy-gated category.

## Model
None: deterministic code, no model call.

## Order
0. Runs before any agent that changes files.

## Output
Accept or reject with the criterion number; criteria that mean 'never' dead-letter the task, criteria that may pass later retry it once.
