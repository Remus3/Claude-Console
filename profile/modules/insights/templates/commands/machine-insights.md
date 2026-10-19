---
description: Grounded machine report - git across every repository, Temp and boot, scheduled tasks, disk, the Claude footprint. Never transcript inference.
---

# /machine-insights

Ground truth only: every number comes from a command run in this report, never
from reading transcripts or from memory.

1. Repositories: for each root in the host file (ops/machine_insights_host.json),
   git status, branch, last commit date, unpushed and uncommitted counts.
2. Temp and boot: Temp file and folder counts; the last rows of the boot record;
   the relation between the two.
3. Scheduled tasks: every task this setup registered, its last result and next run
   (results 267009, 267011 and 2147946720 are not failures).
4. Disk: free space per drive; the largest folders under the user profile.
5. Claude footprint: size and file count of each Claude config dir's projects and
   the transcript age histogram.
6. Findings come from rules over these numbers, each with its threshold and the
   measurement behind it. Write the report to {reports_dir}; chat gets one line.
