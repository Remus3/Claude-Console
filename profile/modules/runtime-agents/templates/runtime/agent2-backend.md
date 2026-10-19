# Agent 2: Backend (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
Owns the server side of the project: ingest, storage schema, APIs. Frozen files change only through a proposal.

## Writes
The backend folders declared in the write-list of this charter.

## Never
Tests owned by the testing agent, UI files, frozen files (propose instead). Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
Ephemeral spawn when the lead marks one of its tasks ready.

## Model
A mid-tier model.

## Order
2. After the gatekeeper and lead.

## Output
Code changes inside its write-list, or a proposal folder for frozen files.
