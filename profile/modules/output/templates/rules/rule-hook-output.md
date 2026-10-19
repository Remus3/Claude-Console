- HOOKS ARE SILENT BY DEFAULT. A hook exits 0 and prints nothing unless it has
  something to say; then one line of additionalContext of at most 160 characters,
  no ANSI colour, a status message of at most 40 characters, and at most 20 lines
  at SessionStart. A hook never blocks Stop.
