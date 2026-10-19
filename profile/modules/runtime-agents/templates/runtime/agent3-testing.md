# Agent 3: Testing (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
Owns the agent test suite. It runs the suite deterministically and uses a model only to write new tests; it never edits non-test code.

## Writes
The test folders declared in this charter.

## Never
Any non-test file. Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
In-process for runs; ephemeral spawn to write tests.

## Model
A mid-tier model, only for writing tests.

## Order
3. After any agent that changed code.

## Output
Test files and test-run reports.
