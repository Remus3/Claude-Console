# Memory vault adapter (optional)

The setup profile item rec-vault-mcp describes how a local memory vault can mirror the
markdown memory and serve bounded recall over MCP. The profile never downloads or
installs a vault: you choose and install one yourself, then wire it here.

Contract the profile expects from a vault:

- Markdown stays the source of truth. The vault is an index that can be rebuilt from the
  memory folder, the ledger and the roadmap at any time.
- A session-start command prints one bounded recall block for the current task:
  at most about 3,500 characters and about 14 entries.
- A session-end command maintains the index (new and changed leaves).
- Recall answers return a key and a short summary per hit; the body is fetched by key.
- The MCP config lives in the local, gitignored MCP file of this repo, never in tracked
  settings, and no OAuth-gated server sits on a path an unattended run depends on.

Wiring (fill in for the vault you installed):

- session start command:
- session end command:
- MCP server name:
