---
description: Weekly review of every repository in the roster - one dive per repository, a cross-repository dive, adversarial checks, a week-over-week diff.
---

# /fleet-insights

1. Read ops/roster.json. For each live repository dispatch one dive agent: git
   activity this week, open roadmap items, hand-off next action, test counts,
   budget status, background usage split.
2. One cross-repository dive: findings that appear in more than one repository.
3. Each dive's findings go to an adversary agent; only findings that survive stay.
4. Diff against last week's report: new, resolved, unchanged.
5. A prose and layout check of the page, then render it to {reports_dir}.
6. In a background run every phase runs in the foreground of that run (no
   workflows, no nested background tasks). Chat gets one line: the report path.
