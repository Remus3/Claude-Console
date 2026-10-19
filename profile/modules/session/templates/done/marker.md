## The done marker - the last act

After the commit and the read-back, immediately before the chat line:

    "{python}" {kit_dir}/kit_done.py mark --session <n> --status done --bg <N>

(N = background tasks and agents still running.) If a step failed, still write
it with `--status failed --reason "<the step>"`, then print the failure line.
Nothing may be committed or edited after it: a later commit or hand-off edit
clears DONE by design.
