- WHOLE SUITES THROUGH THE GATE. Every whole test suite runs as
  `"{python}" {kit_dir}/kit_suite_gate.py run --owner <id> -- <command>`: at most
  {suite_slots} suites at once on this machine, first come first served, and never
  while another live agent holds uncommitted edits in the tree.
