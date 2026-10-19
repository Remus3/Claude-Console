- After the commit: start the backup task (`schtasks /run /tn ClaudeProfile-OffsiteBackup`;
  it skips itself when a run succeeded under 4 hours ago). Record
  `"{python}" .claude/tools/offsite_backup.py status` in the hand-off first.
