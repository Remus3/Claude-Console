---
description: Reconcile every markdown file against its one owning source; fix drift, flag broken references and stale files.
---

# /sync-docs

1. List every markdown file in the repository.
2. For each restated fact (a number, path, threshold or rule) find its owning
   file. Fix the copy, or replace it with a pointer to the owner.
3. Flag every reference that names a missing file, and every file nothing links to.
4. Keep the README's own contract: what it is, install, use, update, uninstall,
   each fact in one section.
5. Report one line per file changed and one line per flag.
