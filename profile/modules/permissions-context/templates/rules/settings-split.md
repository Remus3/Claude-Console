- SETTINGS SPLIT. The tracked .claude/settings.json holds hooks, safe env values and deny
  rules only. Permission mode and allow lists live in .claude/settings.local.json, which
  is gitignored: a grant must never travel to every clone and collaborator.
