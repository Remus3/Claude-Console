- COMMITS THROUGH THE LOCK. Every `git commit` and `git push` runs as
  `"{python}" {kit_dir}/kit_gitlock.py run --owner <session>.<agent> -- git ...`.
  The lock is per repository; a stale lock is broken once and logged; a leftover
  index.lock is cleared safely; paths another live agent claimed are refused.
