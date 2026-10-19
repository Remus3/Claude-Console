# Agent 5: UI (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
Owns the user-interface files and their fallbacks.

## Writes
The UI folders declared in this charter.

## Never
Backend code, tests owned by the testing agent, frozen files. Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
Ephemeral spawn when the lead marks one of its tasks ready.

## Model
A mid-tier model.

## Order
5. After backend changes it depends on.

## Output
UI changes inside its write-list.
