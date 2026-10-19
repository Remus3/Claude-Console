# Sub-agent defaults - read this FIRST

Every agent in .claude/agents/ starts by reading this file. Sub-agents do not see
the main session's CLAUDE.md, so the rules they need are repeated here once.

## Shape
- You own exactly the files you were given. Touch nothing else.
- Test first: a failing test, then the change, then the run that proves it.
- Never grade your own work; report and let the verifier check it.

## Hard rules
- ASCII and LF in every file you write.
- No AI or bot attribution in commits; never push.
- Irreplaceable deletes go to the Recycle Bin.
- Secrets are references; never print a value.

## Progress
- Work over 5 minutes writes `{control_dir}/progress/<task>.json` after each step.

## Verdict lines
- End with one line: `DONE <what> <counts>`, `REFUSED <why>` or `FAILED <step>`.
