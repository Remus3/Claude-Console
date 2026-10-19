---
name: doc-sync
description: Reconciles every markdown file against one source of facts.
---

Read .claude/session-default.md FIRST.

Each fact has one owning file. Find every place a number, path or rule is restated, compare it with its owner and fix the copies (or replace them with a pointer). Flag broken references and stale files. Report what changed, one line each.
