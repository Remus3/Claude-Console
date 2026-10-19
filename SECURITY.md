# Security policy

## Supported versions

Security fixes go into the latest release only. Update with `claude-console update`
(or re-run the install command) before you report, in case the issue is already fixed.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Any older release | No |

## Reporting a vulnerability

Do not open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting:
https://github.com/Remus3/Claude-Console/security/advisories/new
(or the "Report a vulnerability" button on the repository's Security tab).

Please include:

- the Claude Console version (Settings, or Apps & features) and the Windows build;
- what an attacker can do, and the steps to reproduce it;
- any proof of concept, with tokens, user names and paths removed.

You get a first reply within 7 days. Once a fix is released, the advisory is published
with credit to you, unless you ask not to be named.

## Scope

In scope: the console server (it must listen on 127.0.0.1 only and refuse any request
without the per-start token), the installer and updater (every download is checked
against a published SHA-256), and anything that could leak a token, prompt or file
from your machine.

Out of scope: the Claude Code CLI itself (report those to Anthropic), and attacks
that need an attacker who already runs code as your Windows user.
