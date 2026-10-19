# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

- Questions and ideas: use [Discussions](https://github.com/Remus3/Claude-Console/discussions).
- Bugs and crashes: open an issue from the templates. Never paste secrets, tokens or
  private paths.
- Security problems: see [SECURITY.md](SECURITY.md), never a public issue.
- A local change you made to your install: `claude-console contribute` bundles it as a
  scrubbed patch you can review before anything is sent.

## Pull requests

1. Fork, then branch from `main`.
2. `npm ci`, make the change, add or update a test in `tests/`.
3. `npm test` and `node tools/privacy-scan.js .` must pass. CI runs both on Windows.
4. Keep files ASCII with LF line endings; PowerShell scripts must parse in Windows
   PowerShell 5.1.
5. One topic per pull request. Pull requests are squash-merged, so the title becomes
   the commit message.

By contributing you agree that your work is licensed under the Apache License 2.0
(see [LICENSE](LICENSE)) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
