- VERIFICATION TIERS. Verify by the size of the change. Tier 0 (cosmetic: text, comments,
  formatting): compile or parse the touched files only. Tier 1 (one module): compile plus
  that module's tests. Tier 2 (schema, engine, shared contracts, or any merge): the whole
  suite, once, run by whoever merges, through the suite gate when one is installed.
  Builders never run the whole suite in parallel.
