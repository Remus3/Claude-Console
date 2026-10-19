- `{runtime_dir}/` IS LIVE. Scheduled tasks run these files directly, with no
  deploy step: copy before editing, parse-check with powershell.exe 5.1 before
  walking away. A syntax error is a silently dead task.
