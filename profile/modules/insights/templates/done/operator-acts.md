- For every item still waiting on you in the hand-off or the roadmap, append one
  line to `ops/insights/operator-acts.jsonl`:
  {"date": "<today>", "repo": "{repo_code}", "item": "<id>", "since": "<date the wait began>", "ask": "<one-line act>"}.
  Skip an item that already has a line dated today. ASCII only; no names, emails,
  account ids or directory names.
