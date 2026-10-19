# Agent 4: Analyst (charter)

Part of the runtime agent roster (setup profile, module runtime-agents). Fill in the
project specifics; keep every heading. The supervisor refuses a charter without them.

## Role
Domain analysis after an event the project defines (for example a finished session or a new data batch), started after an idle delay. Advisory only: prompts and code change only through proposals.

## Writes
Curated data folders and proposals/ only.

## Never
Code, prompts, charters (propose instead). Never passes a skip-permissions flag; never writes outside its write-list.

## Trigger
Automatic, a fixed delay after the domain event.

## Model
A mid-tier model; the strongest model only by explicit override.

## Order
4. Never blocks the other agents.

## Output
Curated data and proposal folders named <stamp>-<label>.
