# Setup profile reference

This page lists every module of the setup profile 1.0.0, in order, generated from the
module manifests that ship with the console (`profile/modules/<id>/module.json`). For
each module: what it does, why it exists, its default, how it pairs with other modules,
and when you might turn it on later. Each module ends with a table of its items.

Before you enable a module, read its items here or with `claude-console profile view
<id>`, and read the `.md` files it adds to your project: they are the rules Claude will
follow. Nothing is written until you apply, and every apply can be reverted. Item
columns: **Default** is the state the module turns the item to; **Risk** is `low`,
`medium` or `high` (high-risk items ask for a typed confirmation); **Where** says
`Windows only` when the item needs Windows.

## Presets

| Preset | Modules |
|---|---|
| `recommended` | `floors`, `core-rules`, `session`, `output`, `attribution`, `tdd-agents`, `docs-memory`, `console`, `ci-gates`, `recall`, `lessons`, `permissions-context` |
| `minimal` | `floors`, `core-rules`, `session`, `attribution`, `lessons` |
| `full` | all modules |
| `remus3` | the author's current settings, item by item: what the author's own setup runs, plus every item the author ships on by default (`profile/presets/remus3.json`; each item records its rule) |

## Modules at a glance

| # | Module | Default | Items on by default |
|---|---|---|---|
| 1 | [Safety floors](#1-floors) | always on | 9 of 9 |
| 2 | [Core rules](#2-core-rules) | on | 14 of 24 |
| 3 | [Session shape](#3-session) | on | 11 of 11 |
| 4 | [Quiet output](#4-output) | on | 10 of 13 |
| 5 | [Sub-agent first](#5-subagent-first) | off | 6 of 6 |
| 6 | [Race guards](#6-race-guards) | off | 4 of 4 |
| 7 | [Commit attribution](#7-attribution) | on | 3 of 4 |
| 8 | [Test-first and the agent roster](#8-tdd-agents) | on | 19 of 26 |
| 9 | [Docs, memory and size budgets](#9-docs-memory) | on | 14 of 22 |
| 10 | [Several repositories](#10-fleet) | off | 9 of 11 |
| 11 | [Background runs on a second account](#11-headless) | off | 0 of 13 |
| 12 | [Scheduled machine maintenance](#12-maintenance) | off | 1 of 11 |
| 13 | [Insights and the atlas](#13-insights) | off | 0 of 8 |
| 14 | [Status board](#14-board) | off | 0 of 2 |
| 15 | [Console integration](#15-console) | on | 4 of 4 |
| 16 | [Test tiers and git/CI gates](#16-ci-gates) | on | 8 of 17 |
| 17 | [Memory recall (recall-before-build; vault off)](#17-recall) | on | 2 of 7 |
| 18 | [Repeat-failure lessons library](#18-lessons) | on | 48 of 62 |
| 19 | [Permissions, MCP and context economy](#19-permissions-context) | on | 6 of 9 |
| 20 | [Sidecar areas outside the repo and their cleanup](#20-sidecar) | off | 2 of 10 |
| 21 | [Runtime agent roster (supervisor + numbered agents)](#21-runtime-agents) | off | 0 of 12 |
| 22 | [Local machine profile and advisors (LOCAL ONLY)](#22-machine-profile) | off | 1 of 15 |

## 1 floors

**Safety floors.** Rules that stay on whatever else you choose: your identity in commits, safe deletes, secrets kept out of files.

- Why: Each floor exists because its absence once cost the author something that could not be recovered. They are shown and explained here, but they cannot be switched off.
- Default: always on (locked); 9 of 9 items on when the module is on.
- Pairings: usually on with `subagent-first`, `attribution`.
- Enable later because: It is always on and cannot be turned off: it is what keeps every other module reversible.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `floor-no-ai-attribution` Commits carry your identity only | Adds the rule that no commit or pull request carries an AI or bot co-author, sign-off or author. | on | medium | any |
| `floor-no-fallback` Headless runs fail closed | Adds the rule that a background run with a missing or unreachable route is refused rather than rerouted. | on | low | any |
| `floor-subagent-first-main-session` Never stop running work to check on it | Adds the rule that status checks read progress files and never stop, restart or edit a running agent. | on | low | any |
| `floor-recycle-bin` Irreplaceable deletes go to the Recycle Bin | Adds the rule that anything which cannot be regenerated is recycled or moved aside, never unlinked. | on | low | any |
| `floor-no-untested-reconfig` Reconfiguring scripts are never trial-run on this machine | Adds the rule that scripts which change system settings are reviewed and parse-checked here, and executed only on their target or in a sandbox. | on | low | any |
| `floor-secrets-never-echoed` Secrets are references, never values | Adds the rule that configuration points at where a secret lives, and that errors name the reference only. | on | low | any |
| `floor-os-settings-backup` OS changes: backup, one change, read back | Adds the discipline for system and security settings: save the current state, change one thing, read it back, roll back on a regression. | on | low | any |
| `kit-fleet-secrets` Secret-reference helper | Copies kit_secrets.py, which resolves a secret from an environment variable, file or command and never prints the value, together with the kit's LICENSE and NOTICE. | on | low | any |
| `floor-no-telemetry` No telemetry | Adds the rule that nothing reports usage, prompts, files or errors anywhere, and that crash reports stay local until you send one. | on | low | any |

## 2 core-rules

**Core rules.** The CLAUDE.md skeleton and the working rules every session follows: act on recommendations, keep chat quiet, commit coherently, ASCII and LF.

- Why: Claude reads CLAUDE.md at the start of every session, so its rules shape every turn. A fixed, short layout keeps that start-up cost low and lets a test pin the shared part.
- Default: on; 14 of 24 items on when the module is on.
- Pairings: needs items of `attribution`; usually on with `output`, `subagent-first`, `tdd-agents`, `docs-memory`.
- Enable later because: Leave single rules off if they clash with how you already work, for example quiet chat when you like long explanations; turn them on once you want Claude to follow them in every session.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `rule-act-dont-ask` Act on the recommendation; adjudicate a real block | Adds the rule that Claude takes its recommended option, and sends a genuinely blocked decision to a separate adjudicator agent whose call is recorded. | on | low | any |
| `rule-quiet-chat` Results-only chat | Adds the rule that chat carries numbers, paths, verdicts and your to-dos, while findings go into files. | on | low | any |
| `rule-commit-batched` Commit every unit of work | Adds the rule that each finished unit is committed coherently, never in another repository, and that side findings are fixed or filed. | on | low | any |
| `rule-push-policy` Local-only repository | Adds the rule that this repository never pushes, and a pre-push check that refuses every push. | off | low | any |
| `rule-encoding-ascii-lf` ASCII and LF in every authored file | Adds the rule that authored files are 7-bit ASCII with LF endings and that PowerShell is parse-checked with version 5.1. | on | low | any |
| `rule-measure-before-threshold` Thresholds come from measurements | Adds the rule that limits and cutoffs are chosen from a measured distribution and that report findings come from rule code. | on | low | any |
| `rule-eta-timers` Estimated times on every action | Adds the rule that each tool call states an estimate, overruns are reported at 1.5x and stopped at 3x. | on | low | any |
| `rule-claude-md-layout` Fixed CLAUDE.md layout | Writes the top of CLAUDE.md: a one-line purpose, the pointer to the rules archive and the heading of the shared rules block; your own sections follow untouched. | on | low | any |
| `conv-claude-md-history` Rules archive with the reasons | Creates the rules archive, where the full text of each condensed rule and the incident behind it are kept verbatim. | on | low | any |
| `conv-machine-facts` Machine facts section | Adds a short CLAUDE.md section for measured facts about your machine, each with its date and how to re-measure it. | on | low | any |
| `set-env-utf8` UTF-8 for Python child processes | Sets PYTHONUTF8=1 and PYTHONIOENCODING=utf-8 in your Claude settings so every Python tool reads and writes UTF-8. | on | low | any |
| `set-powershell-tool` PowerShell tool on Windows | Sets CLAUDE_CODE_USE_POWERSHELL_TOOL=1 so Claude can run native PowerShell beside the Bash tool. | on | low | Windows only |
| `set-tool-search` Deferred tool loading | Sets ENABLE_TOOL_SEARCH=true so tool definitions load when needed instead of all at start-up. | on | low | any |
| `set-effort-level` Default reasoning effort | Sets effortLevel in your Claude settings to the value you choose in the wizard. | off | low | any |
| `set-bypass-permissions` Run tools without permission prompts | Sets permissions.defaultMode to bypassPermissions so tools run without asking first. | off | high | any |
| `set-workflows` Workflow tool | Sets enableWorkflows to true so multi-step workflow scripts can run. | off | low | any |
| `set-agent-push` Phone notification when agents finish | Sets agentPushNotifEnabled to true so a finished agent sends a push notification. | off | low | any |
| `conv-gitattributes-lf` Line endings pinned in .gitattributes | Creates a .gitattributes that stores text with LF endings and marks images and archives as binary. | on | low | any |
| `set-skip-danger-prompt` No start-up warning for prompt-free mode | Sets skipDangerousModePermissionPrompt so Claude does not ask again at every start once you chose to run tools without prompts. | off | high | any |
| `set-allow-maintenance` Allow the maintenance commands | Adds the task kill and scheduled-task commands to the permission allow list, so sessions that do ask for permission can still run maintenance. | off | medium | any |
| `set-workflow-warning` No workflow usage warning | Sets skipWorkflowUsageWarning so starting a workflow does not stop at a usage warning first. | off | low | any |
| `set-model-effort` Per-model reasoning effort | Sets modelSettings so the largest model runs at medium effort while the default effort stays as you set it. | off | low | any |
| `set-model-switch` Switch models on a flag | Sets switchModelsOnFlag so Claude moves to another model when the current one is flagged instead of stopping. | off | low | any |
| `set-auto-updates` Automatic Claude updates | Sets autoUpdates to true so Claude Code keeps itself up to date. | on | low | any |

## 3 session

**Session shape.** One hand-off file carries every session into the next, a numbered checklist shows the plan, and /done closes the session verifiably.

- Why: Chat does not survive /clear. Continuity therefore lives in one tracked file, and a session counts as finished only when a marker proves the commit and the hand-off match.
- Default: on; 11 of 11 items on when the module is on.
- Pairings: usually on with `output`.
- Enable later because: Turn it on as soon as you work on one project across several sessions: without a hand-off file the next session starts from nothing.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `conv-handoff-file` Hand-off file at the repo root | Creates {handoff_name} and the rule that every session reads it first and /done rewrites it, carrying forward every open item. | on | low | any |
| `conv-dnr-reversal` Settled items name what would reverse them | Adds the rule that every do-not-re-litigate entry states its reversal condition and is re-checked when it depends on someone else. | on | low | any |
| `conv-session-counter` SESSION counter in the hand-off | Adds the rule that the hand-off starts with SESSION: n and that /done writes n+1. | on | low | any |
| `conv-session-checklist` Numbered session checklist | Adds the rule that each session prints its task list at the start, reprints the remainder after every four completions, and runs /done when the list is empty. | on | low | any |
| `kit-fleet-checklist` Checklist helper | Copies kit_checklist.py, which prints the checklist in the fixed format and writes the remaining tasks into a background run's progress file. | on | low | any |
| `cmd-done` /done end-of-session command | Installs a /done command that runs pre-flight, checks, the hand-off rewrite, one commit and the done marker; other modules add their own steps inside it. | on | low | any |
| `kit-fleet-done` Verified done marker | Copies kit_done.py and adds the marker step to /done: it records HEAD, the hand-off hash and the session number, and refuses a hand-off over the size budget. | on | low | any |
| `hook-stop-done-title` DONE in the terminal title | Adds a Stop hook that, once the marker is valid and nothing runs in the background, titles the tab '{repo_code} DONE' and sends one notification. | on | low | any |
| `hook-sessionstart-checklist` Session number at start-up | Adds a SessionStart hook that reads SESSION: n from the hand-off and tells Claude which checklist number to print. | on | low | any |
| `conv-session-start` Fixed start-up order | Adds the start-up order: read the hand-off, switch to quiet output, print the checklist, run the enabled start-up checks, then work. | on | low | any |
| `conv-session-end` Unprompted /done, then your /clear | Adds the rule that /done runs by itself when work runs out or context gets heavy, and that only you type /clear. | on | low | any |

## 4 output

**Quiet output.** Compressed chat, a calm terminal and a fixed-slot status line: nothing moves unless something needs your attention.

- Why: Verbose chat costs tokens twice, once to write and once to read, and buries the result. A display without motion makes any change stand out.
- Default: on; 10 of 13 items on when the module is on.
- Pairings: usually on with `core-rules`, `subagent-first`, `attribution`.
- Enable later because: Turn items off if you prefer Claude's default, more talkative style; turn the status line on once several sessions run at once and you want them readable at a glance.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `out-caveman-ultra` /caveman chat dialect | Installs the /caveman command: replies without preamble or narration, only numbers, paths, verdicts and errors; written files keep full prose. | on | low | any |
| `hook-sessionstart-caveman` Caveman declared at start-up | Adds a SessionStart hook that declares the caveman dialect, so no one has to type /caveman. | on | low | any |
| `out-verbose-mode` Normal explanatory chat | Leaves Claude's default chat style in place: explanations and reasoning in the reply. | off | low | any |
| `set-output-style-concise` Concise output style | Sets the account output style to Concise. | on | low | any |
| `set-calm-display` Calm terminal display | Sets the display keys: a fixed spinner word, no tips, reduced motion, automatic theme, no turn duration, no away summary, no prompt suggestions, focus view. | on | low | any |
| `set-env-display` No flicker, no survey | Sets CLAUDE_CODE_NO_FLICKER=1 and CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1 in your Claude settings. | on | low | any |
| `set-statusline` Fixed-slot status line | Copies kit_statusline.js and points the repository's local settings at it: state, branch, context and quota in fixed positions, plus one row per running workflow; colour only on problems. | on | low | any |
| `set-subagent-statusline` Agent rows in the same grammar | Copies kit_subagent_status.js and sets it as the agent panel's status line, so each agent row reads like the main status line when it has a progress file. | on | low | any |
| `console-statusline-basic` The console's simple status line | Keeps the simpler line the console ships: account, model, repository, context and quota. | off | low | any |
| `kit-tokens` Shared state vocabulary and colours | Copies tokens.json and tokens.css: the light and dark colours and the state words, glyphs and rows every surface uses. | on | low | any |
| `kit-cli-display` Display keys at account level | Keeps every display key in your account settings and none in a repository, so a project cannot override the calm display by accident. | on | low | any |
| `rule-hook-output` Silent hooks | Adds the hook output rules: exit 0 and stay silent by default; when there is something to say, one short line, no colour codes, never blocking Stop. | on | low | any |
| `set-statusline-user` Status lines for every repository | Copies the fixed-slot status line and the agent row script into your Claude config folder and points your account settings at them, so they show in every repository. | off | low | any |

## 5 subagent-first

**Sub-agent first.** The main session only dispatches and reports; the work runs in background agents that write progress files.

- Why: A main thread full of tool rows hides the one decision you need to make. Moving the work into sub-agents keeps the session readable and lets several jobs run at once.
- Default: off; 6 of 6 items on when the module is on.
- Pairings: needs items of `floors`; usually on with `output`.
- Enable later because: Off by default because it changes how the main session works. Turn it on once long tasks keep your main session busy and you want it free to talk to you while helpers do the work.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `rule-subagent-first` Main session only dispatches | Adds the banner rule that every file and shell tool runs inside a sub-agent, and the /done step that dispatches the ritual to one agent. | on | low | any |
| `hook-pretooluse-subagent-first` Main-thread tool guard | Copies kit_subagent_first.py and adds a PreToolUse hook that denies file and shell tools in the main thread with a one-line reason. | on | low | any |
| `rule-background-status` Status from background counters | Adds the rule that work runs as background agents and commands, so the session shows compact running counts instead of a long foreground turn. | on | low | any |
| `conv-progress-files` Progress file per long task | Adds the rule that work over five minutes writes a small JSON progress file after each step: percent, step, estimate, status and time. | on | low | any |
| `conv-progress-prune` Old progress files to the Recycle Bin | Installs a small tool that lists finished progress files older than seven days and, with --apply, sends them to the Recycle Bin. | on | low | any |
| `set-max-subagents` Higher concurrent sub-agent cap | Sets CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS in your Claude settings to the number you choose (10 unless you change it). | on | medium | any |

## 6 race-guards

**Race guards.** File claims, a commit lock, machine-wide test-suite slots and a guard that keeps tests away from live state.

- Why: When several agents work in one repository at once, conventions like disjoint file lists are not enough; these guards are enforced by hooks and helpers, not by prompts.
- Default: off; 4 of 4 items on when the module is on.
- Pairings: needs items of `tdd-agents`; no usual partners outside the module.
- Enable later because: Off by default because a single session never races itself. Turn it on once two or more Claude sessions edit, commit or test in the same project at the same time.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `kit-fleet-claims` Per-file claims between agents | Copies kit_claims.py and adds hooks that claim each file an agent edits, deny another live agent's edit of it, and release the claims when the agent stops. | on | low | any |
| `kit-fleet-gitlock` Commit and push lock | Copies kit_gitlock.py and the rule that every commit and push runs through it, plus the matching /done commit step. | on | low | any |
| `kit-fleet-suite-gate` Machine-wide test-suite slots | Copies kit_suite_gate.py, sets KIT_SUITE_SLOTS to your slot count (2 unless you change it), and adds the rule and /done step that run whole suites through it. | on | low | any |
| `kit-fleet-test-guard` Tests isolated from live state | Copies kit_test_guard.py and adds the lines to tests/conftest.py that install it: a run that changes live control, inbox or outbox files fails. | on | low | any |

## 7 attribution

**Commit attribution.** Git hooks and account keys that keep AI and bot identities out of your commit history.

- Why: This is the mechanism behind the attribution floor: the floor states the rule, these items enforce it at the harness, at commit time and before any push.
- Default: on; 3 of 4 items on when the module is on.
- Pairings: needs items of `floors`, `ci-gates`; no usual partners outside the module.
- Enable later because: Turn it on before your first commit if you want every commit to carry only your own name; it is cheap to keep.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `hook-git-commit-msg` commit-msg hook strips AI trailers | Records your identity in local git config, copies kit_identity.py and adds a commit-msg check (run by the git hook dispatchers of the ci-gates module) that removes forbidden attribution lines. | on | low | any |
| `hook-git-pre-push-identity` pre-push hook refuses foreign identities | Adds a pre-push check that refuses a push whose new commits carry a non-owner author, committer or attribution trailer. | on | low | any |
| `set-attribution-empty` No attribution footer from Claude | Sets the account keys attribution.commit and attribution.pr to empty and includeCoAuthoredBy to false. | on | low | any |
| `kit-fleet-rewrite` History rewrite helper | Copies kit_rewrite.py, which plans, bundles and then rewrites foreign identities out of history, only when you run it with the plan's confirmation id. | off | high | any |

## 8 tdd-agents

**Test-first and the agent roster.** Test-first work, an orchestrated session shape and a roster of planner, builder, verifier, adversary and adjudicator agents with the commands that drive them.

- Why: Fixes without a reproduction kept coming back, and work graded by its own author passed defects nobody could see. Separate roles with a failing test first keep both from happening.
- Default: on; 19 of 26 items on when the module is on.
- Pairings: needs items of `headless`; usually on with `race-guards`, `docs-memory`, `recall`.
- Enable later because: Its off items (truth gate, model routing, lane paths, loop roles) only pay off once several builder agents report in one round, background spend matters, or parallel lanes run.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `conv-tdd-first` Failing test first | Adds the rule: spec, then a test that fails for the right reason, then the smallest change, then the verification its tier needs. | on | low | any |
| `conv-session-shape` Orchestrated, self-checking session shape | Adds the rule that one merger holds the plan, disjoint slices run in parallel worktrees, and every finding gets a refuting pass. | on | low | any |
| `agent-planner` Planner agent | Installs a planner agent that writes the spec and a slice plan with disjoint write-lists before any code. | on | low | any |
| `agent-builder` Builder agent | Installs a builder agent that implements exactly one slice in its own worktree, test first, inside its write-list. | on | low | any |
| `agent-verifier` Verifier agent | Installs a verifier agent that re-runs the tests from a clean checkout and checks every cited file and claim. | on | low | any |
| `agent-adversary` Adversary agent | Installs an adversary agent that tries to refute one finding through one lens and says REFUTED when unsure. | on | low | any |
| `agent-adjudicator` Adjudicator agent | Installs an adjudicator agent that decides between candidates against stated criteria and records the call. | on | low | any |
| `agent-researcher` Researcher agent | Installs a researcher agent that searches for prior art and checks each source's licence, without copying code in. | on | low | any |
| `agent-ui-auditor` UI auditor agent | Installs a UI auditor agent that reviews changed screens for structure, typography, hit targets, characters and hierarchy. | on | low | any |
| `agent-doc-sync` Doc-sync agent | Installs a doc-sync agent that compares every restated fact in the markdown files with its one owning file. | on | low | any |
| `cmd-orchestrated-run` /orchestrated-run | Installs a command that runs recall, plan, parallel builders, the verifier gate and the merge as one entry point. | on | low | any |
| `cmd-root-cause-fix` /root-cause-fix | Installs a command for bugs: reproduction test first, every sibling occurrence of the cause, the minimal fix, and a backfill of data the bug already damaged. | on | low | any |
| `cmd-diagnose` /diagnose | Installs a five-step debugging command: reproduce, minimise, hypothesise, fix one thing, verify. | on | low | any |
| `plugin-superpowers` superpowers plugin | Turns on the superpowers plugin from the official marketplace in your Claude settings: skills for test-driven work, planning, worktrees, verification and review. | off | low | any |
| `plugin-playwright` Playwright plugin | Turns on the Playwright plugin in your Claude settings; it drives a browser for interface checks and end-to-end tests. | off | low | any |
| `plugin-chrome-devtools` Chrome DevTools plugin | Turns on the Chrome DevTools plugin in your Claude settings, for accessibility, performance and network audits. | off | low | any |
| `conv-worktree-branches` Same-day work on worktree branches | Adds the rule that versions and multi-step builds live on a worktree branch and reach main only by a fast-forward once verified. | on | low | any |
| `ag-session-default-file` Shared rule file for every agent | Creates .claude/session-default.md with the shape, hard rules, progress contract and verdict lines, which every agent definition reads first. | on | low | any |
| `ag-agent-file-cap` Size cap per agent file | Adds the rule that each agent definition stays under the agent file budget, which the budget checker enforces. | on | low | any |
| `ag-phase0-recall` Recall before the spec | Adds phase 0: before planning, read the hand-off, history, roadmap, rulings and memory; a CLOSED or REFUTED hit stops the work. | on | low | any |
| `ag-risk-scaled-lenses` Review depth scaled by risk | Adds the rule that diffs touching core logic get the full adversary lens set, plumbing gets one lens, and refute rounds are capped before the adjudicator decides. | on | low | any |
| `ag-recusal` No agent grades its own work | Adds the rule that the producer of a slice, spec or candidate is never its verifier, adversary or adjudicator. | on | low | any |
| `ag-truth-gate` Claims check for multi-builder rounds | Installs claims_check.py: the verifier lists the files, absences and counts a report claims, and the tool re-measures each one and refuses on the first that does not hold. | off | low | any |
| `ag-model-routing` Model and effort chosen by run kind | Adds the routing rule: planning on the strongest model, fixes on a mid-size one, verification and inbox replies on a mid-size model at low effort. | off | low | any |
| `ag-lane-path-ownership` Each lane owns its paths | Creates .claude/lanes.json, a registry of the paths each background lane may write, with shared directories listed explicitly. | off | low | any |
| `ag-loop-roles` Director, auditor and executor roles | Adds the loop rule that the director and auditor run read-only in plan mode, only the executor changes files, and cycles are capped. | off | high | any |

## 9 docs-memory

**Docs, memory and size budgets.** Size budgets with a checker, a memory layout, an open-only roadmap, briefs, rulings and the hand-off archive, plus commands that keep them in sync.

- Why: Context is the budget every session spends first. A file past its budget is paid for on every turn, and deleting detail destroys what the budget is meant to protect, so detail is relocated instead.
- Default: on; 14 of 22 items on when the module is on.
- Pairings: needs items of `core-rules`, `session`, `output`, `headless`; usually on with `tdd-agents`, `ci-gates`.
- Enable later because: Its off items are for later: a ledger once closed records get cited, a plans folder for specs that span sessions, wake-up notes only as an explicit choice instead of the hand-off.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `conv-doc-size-budget` Size budgets: relocate, never delete | Adds the budget rule and .claude/doc-budgets.json with your budgets: CLAUDE.md and auto-loaded files, the memory index and leaves, the roadmap, the hand-off and agent files. | on | low | any |
| `tool-doc-budget` Budget checker | Installs doc_budget.py, which prints every budgeted file against its budget and exits non-zero only on a hard limit. | on | low | any |
| `conv-memory-layout` Memory index with one fact per leaf | Adds the memory rule and starts the project memory with an index and one example leaf in the Claude config dir. | on | low | any |
| `conv-roadmap-open-only` Roadmap of open work only | Creates ROADMAP.md and the rule that it lists open items only, each with an acceptance check. | on | low | any |
| `conv-docs-briefs` Docs as standing briefs | Adds the rule that the docs folder holds one dated brief per workstream, and a README that says so. | on | low | any |
| `conv-rulings-dir` Rulings folder | Creates the rulings folder with its record format: decision, alternatives, why, and what would reverse it. | on | low | any |
| `conv-handoff-archive` Hand-off archive | Creates the hand-off archive folder and the /done step that moves closed hand-off blocks into it before the size cap is reached. | on | low | any |
| `cmd-sync-docs` /sync-docs | Installs a command that reconciles every markdown file against its owning source, fixes drift and flags broken references and stale files. | on | low | any |
| `cmd-weekly-hygiene` /weekly-hygiene | Installs a weekly command: relocate-only trims of files near their budget, a memory staleness scan and a look at recent session start-ups. | on | low | any |
| `hook-facts-inject` Facts file injected at start-up | Creates .claude/facts.md and a SessionStart hook that prints it (at most 20 lines) so sessions start with verified state. | off | low | any |
| `hook-edit-guards` ASCII and LF check after each edit | Adds a PostToolUse hook that checks the file just edited or written and reports the first line with a CR or a non-ASCII byte. | off | low | any |
| `hook-precommit-gate` Gate on commit tool calls | Adds a PreToolUse hook that runs the budget checker before a git commit tool call and denies the call on a hard failure. | off | low | any |
| `hook-claimed-green-gate` Flag green claims without a test run | Adds a Stop hook that notices a reply claiming the tests pass when no test command ran in that turn, and says so in one line. | off | low | any |
| `md-handoff-cap` Hand-off size cap at /done | Adds the rule that the done marker refuses a hand-off over its budget and warns at 90 percent. | on | low | any |
| `md-handoff-lint` Hand-off lint | Installs handoff_lint.py and its /done step: at least 2,000 bytes, one SESSION line on line 1, at most one fenced block, ASCII, no secret-shaped strings or home paths. | on | low | any |
| `md-handoff-prefix-grammar` Hand-off bullet prefixes | Adds the rule that a bullet's prefix decides where it goes: a note, another repository, an act for you, or lane work. | off | low | any |
| `md-budget-enforcement-points` Where budgets are enforced | Adds the rule naming the three enforcement points (pre-commit, hosted CI, the /done pre-flight) and the /done step that runs the checker. | on | low | any |
| `md-doc-topology` Docs map: one owner per fact | Adds a table to CLAUDE.md naming the file that owns each kind of fact and what must never go in it. | on | low | any |
| `md-ledger` Ledger for closed work | Creates an append-only ledger folder with an index and one file per session, and the rule that closed records go there. | off | low | any |
| `md-wakeup-notes` Rolling notes of the last sessions | Creates a short narrative file of the last two or three sessions; older blocks move to a history file. | off | low | any |
| `md-plans-dir` Numbered plans with reviews | Creates a plans folder: one numbered plan per batch of work, its reviews beside it and an index with each plan's status. | off | low | any |
| `md-claude-md-rules-only` CLAUDE.md keeps rules only | Records that CLAUDE.md holds rules and pointers while the long form lives in the rules archive; it adds nothing of its own. | on | low | any |

## 10 fleet

**Several repositories.** A roster of your repositories, a note channel between them, one supervisor repository that speaks for you, and a shared kit kept in sync.

- Why: With several repositories on one machine, a finding in one is often a problem in all of them. A channel and a supervisor let you fix it once, without pasting the same instruction into every session.
- Default: off; 9 of 11 items on when the module is on.
- Pairings: needs items of `floors`, `core-rules`; no usual partners outside the module.
- Enable later because: Off by default because it assumes several projects that talk to each other. Turn it on once you run three or more related projects and want one of them to supervise the others.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `fleet-roster` Roster of your repositories | Creates ops/roster.json: one entry per repository with its code, name, root (entered in the wizard), colour, and whether it is retired. | on | low | any |
| `fleet-channel` Note channel between repositories | Adds the channel rule (outbox first, byte-copy delivery, re-hashed destinations, an N/M count) and an outbox README. | on | low | any |
| `fleet-stand-in` Supervisor notes count as your instruction | Adds the rule that a hash-verified note from the supervisor repository is your instruction, bounded by the floors. | on | medium | any |
| `kit-fleet-inbox` Cheap inbox triage | Copies kit_inbox.py and adds the inbox cost rules: free classification first, mechanical acknowledgements, a daily outbound cap and a hop limit. | on | low | any |
| `kit-vendoring` Kit files are pinned copies | Adds the rule that kit files are byte copies pinned by their manifest, and copies the manifest that pins them. | on | low | any |
| `kit-common-block` Managed shared rules block | Adds the rule that the shared rules in CLAUDE.md are rendered from the enabled modules and changed only through the profile, which reports a hand edit. | on | low | any |
| `tool-kit` Drift check every session | Adds the start-up step that runs the profile status check for every repository in the roster. | on | low | any |
| `kit-train` At most one kit version a week | Adds the rule: one new profile version per seven days, built on a worktree branch, the next only after all repositories adopted the last; fixes exempt. | on | low | any |
| `kit-fleet-watch` Watcher helper | Copies kit_watch.py: a watcher primitive that takes a baseline first, advances only after delivery, runs once at a time and reports going stale once. | on | low | any |
| `os-self-apply-grant` Agent applies OS settings itself | Adds the grant that firewall, network adapter, service and UAC changes are made by the agent instead of being handed to you to paste. | off | high | any |
| `sched-kit-rollout` Nightly note delivery and drift record | Registers a nightly task (04:00, 55-minute limit) that delivers queued notes to every repository and records each one's profile drift; it applies nothing. | off | high | Windows only |

## 11 headless

**Background runs on a second account.** A separate account for background work, a fail-closed route to it, the spawn helper, lanes, a driver lane and an inbox responder.

- Why: Background runs can spend a whole subscription overnight. Routing them through one guarded helper on their own account keeps that spend visible, bounded and away from the account you type into.
- Default: off; 0 of 13 items on when the module is on.
- Pairings: needs items of `floors`, `fleet`; usually on with `sidecar`.
- Enable later because: Off by default because it needs a second Claude account and a route you set up yourself. Turn it on once you want Claude to work unattended, for example at night, without spending your main account.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `hl-second-account` Second account for background runs | Adds the rule that background runs use their own Claude config dir and subscription; the wizard's account step flags a missing dir and opens a pane where you log in yourself. | off | high | any |
| `hl-proxy` Loopback route contract | Adds the split-mode contract: background runs reach the second account through a proxy you run on a loopback address, checked before every run. | off | high | any |
| `hl-env-base-url` Kill-switch user variable | Sets the user environment variable CLAUDE_HEADLESS_BASE_URL to your pinned proxy address; deleting it stops every next background run on the machine. | off | high | Windows only |
| `hl-route-file` Route file: split or single | Adds the rule that a route file chooses split or single mode and is read fresh before every run; the wizard's headless step writes it. | off | high | any |
| `kit-fleet-headless` The only background spawn path | Copies kit_headless.py and the rule that nothing else starts a background claude: route check, a daily run cap, lean flags, model choice, usage line and status file. | off | high | any |
| `conv-usage-log` Usage line per background run | Adds the rule that each background run appends one usage line with its kind, label and route. | off | low | any |
| `kit-fleet-lanes` Lanes with their own worktrees | Copies kit_lanes.py: per-repository lane locks, one git worktree per lane and a machine-wide governor that shares three lanes fairly. | off | high | any |
| `hl-driver-lane` Driver lane template | Installs driver_lane.py, which re-fires one unit of work per cycle through the spawn helper with a progress file, a halt file and a cycle cap. | off | high | any |
| `hl-inbox-responder` Inbox responder every 15 minutes | Installs inbox_responder.py and a task that runs it every 15 minutes: free classification, ledger lines for acknowledgements, one run for ORDER, FIX and RULING notes. | off | high | Windows only |
| `hl-halt-files` Halt files pause loops | Adds the halt-file rule and the /done step that pauses the responder for the whole ritual. | off | low | any |
| `cmd-headless-family` Background run contract | Installs /headless-run: the fixed prompt contract for one long background unit, with a merger, worktree agents, a verifier and its own /done fold. | off | high | any |
| `hl-fallback-armed` Armed fallback after a weekly limit | Adds the armed-fallback rule: only when you arm it, a confirmed 7-day limit on one account moves the next runs to the other, one hop, logged. | off | high | any |
| `hl-account-quiet` Quiet keys for the background account | Sets feedbackDrafts to quiet and turns off auto mode during planning in your Claude settings. | off | low | any |

## 12 maintenance

**Scheduled machine maintenance.** Scheduled Temp clean-up, transcript retention, a boot-time record and an off-machine backup, all started hidden.

- Why: Machines slow down from the things nobody watches: Temp file counts, transcripts that pile up, backups that never happen. Small scheduled jobs keep each one bounded and measured.
- Default: off; 1 of 11 items on when the module is on.
- Pairings: needs items of `core-rules`; no usual partners outside the module.
- Enable later because: Off by default because it registers scheduled tasks on your machine. Turn it on once Temp folders, old transcripts or missing backups start to cost you time; each task asks for its own consent.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `sched-temp-hygiene` Temp clean-up every 4 hours | Installs Temp-Hygiene.ps1 and a hidden task every 4 hours that removes stale scratch folders from Temp; locked folders are refused, the live session folder is never touched. | off | high | Windows only |
| `sched-claude-retention` Weekly transcript retention | Installs Clean-ClaudeTranscripts.ps1 and a weekly task (Sunday 04:30) that sends transcripts past the measured retention to the Recycle Bin. | off | high | Windows only |
| `sched-boot-record` Boot time record | Installs Record-BootTime.ps1 and a task at boot plus 3 minutes that appends this boot's logon timings and Temp counts to a CSV. | off | high | Windows only |
| `sched-offsite-backup` Daily off-machine git backup | Installs offsite_backup.py and a daily task (05:00) that sends an incremental git bundle to your backup machine over ssh and verifies the copy. | off | high | Windows only |
| `tool-wol` Wake-on-LAN sender | Installs wol.py, which wakes the backup machine with a magic packet and waits for ssh to answer. | off | medium | any |
| `tool-health-check` Console health check | Uses the console's Health button: fixed-id checks for Temp, disk, boot, tasks, drift, worktrees, git objects and progress files. | off | medium | any |
| `sched-health-check` Scheduled health check | Runs the console's delete-free health checks on a schedule and leaves a result file and one status line. | off | high | Windows only |
| `tool-temp-census` Temp census | Installs temp_census.py, a read-only count of Temp files and sizes per name prefix. | off | low | any |
| `rt-run-hidden` Hidden task launcher | Installs Run-Hidden.vbs, which starts a PowerShell script from a scheduled task without a console window and passes its exit code back. | off | low | Windows only |
| `conv-task-codes` Task result codes that are not failures | Adds the fact that scheduled-task results 267009, 267011 and 2147946720 mean running, never run and already running. | on | low | any |
| `conv-runtime-live` Runtime scripts are live | Adds the rule that scripts run by scheduled tasks are live: copy before editing and parse-check before walking away. | off | low | any |

## 13 insights

**Insights and the atlas.** A grounded machine report, a weekly report across your repositories, and an offline atlas of their state.

- Why: A report built from commands run today cannot re-pitch work that already shipped; one built from memory or old transcripts can.
- Default: off; 0 of 8 items on when the module is on.
- Pairings: needs items of `session`, `fleet`, `headless`; no usual partners outside the module.
- Enable later because: Off by default because the reports are only useful with several projects and some history. Turn it on once you want a weekly view of what your sessions did.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `cmd-machine-insights` /machine-insights | Installs a command for a grounded machine report: git across every repository, Temp and boot, scheduled tasks, disk and the Claude footprint, from commands run now. | off | low | any |
| `tool-machine-insights` Machine report host file | Creates an example host file listing your repository roots, report folder and backup alias, to be copied and filled in locally. | off | low | any |
| `cmd-fleet-insights` /fleet-insights weekly report | Installs a weekly review command: a dive per repository, a cross-repository dive, an adversary per finding and a diff against last week. | off | low | any |
| `sched-fleet-insights` Weekly report task | Installs weekly_report.py and a Friday 17:00 task that runs /fleet-insights once in the background, skips weeks that already have a report and fails a run that leaves no page. | off | high | Windows only |
| `tool-atlas` Offline atlas | Installs atlas.py, which reads every repository in the roster read-only and writes one self-contained HTML page with branch, last commit, dirty count and next action. | off | low | any |
| `sched-atlas-refresh` Atlas refresh when idle | Registers a task that refreshes the atlas after about 10 minutes of idle and stops when you come back; it skips when nothing changed. | off | high | Windows only |
| `tool-pubrepo-census` Public-repository census | Installs pubrepo_census.py, a read-only scan of tracked files, commit subjects and tags for home paths, email addresses and token shapes. | off | low | any |
| `conv-operator-acts` Log of acts waiting on you | Adds the /done step that appends one line per item still waiting on you, so the weekly report can list them. | off | low | any |

## 14 board

**Status board.** A claude.ai status board per repository, rendered from the checklist and progress files at fixed moments.

- Why: A board you can open on a phone shows every repository's plan and progress at the cost of two tool calls per push.
- Default: off; 0 of 2 items on when the module is on.
- Pairings: needs items of `session`; no usual partners outside the module.
- Enable later because: Off by default because it needs a page on claude.ai that you create. Turn it on once you want to follow a session's checklist from your phone.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `kit-fleet-board` Status board renderer | Copies kit_board.py, which renders the board deterministically from the checklist and progress files and prints the two tool calls that publish it; the board link is yours, entered in the wizard. | off | low | any |
| `conv-board-push-points` Board pushed only at fixed moments | Adds the rule that the board is pushed at session start, after each checklist reprint and at /done, and the /done step for the final push. | off | low | any |

## 15 console

**Console integration.** How the console works with this profile: pane hooks, the /done chip, the DONE band and the scheduler view.

- Why: The console already provides these; listing them here shows how they connect to the rest of the profile and lets you see each one's reason in the same place.
- Default: on; 4 of 4 items on when the module is on.
- Pairings: needs items of `session`; no usual partners outside the module.
- Enable later because: Turn it on when you use this console every day: it links Claude panes to the console's status rows and the DONE mark.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `console-pane-hooks` Turn-state hooks for console panes | Passes the console's turn-state hooks to each pane as an additive settings file, so nothing is installed globally. | on | low | any |
| `console-done-chip` /done chip in the composer | Offers a /done chip in each pane's composer that runs the repository's own /done, or the console's plain one when there is none. | on | low | any |
| `console-done-band` DONE band from the verified marker | Shows a DONE band on a pane only when the done marker validates against the pane, HEAD, the hand-off hash and the last prompt time. | on | low | any |
| `console-scheduler` Scheduler view with backup and read-back | Lists, adds, changes and removes Windows scheduled tasks with an XML backup first and a read-back after; every profile task goes through it. | on | medium | Windows only |

## 16 ci-gates

**Test tiers and git/CI gates.** Verification tiers, strict test config, one dispatcher per git hook with content, message and leak checks, and optional hosted CI templates.

- Why: Gates that read the staged bytes and the pushed range catch what would otherwise reach history; one dispatcher per hook keeps modules from fighting over hook files, and the armed check proves the hooks really fire.
- Default: on; 8 of 17 items on when the module is on.
- Pairings: needs items of `attribution`; usually on with `floors`, `core-rules`, `output`, `race-guards`, `tdd-agents`, `docs-memory`.
- Enable later because: Its off items are for later: a pre-push suite once the remote is shared, test selection once the suite takes minutes, hosted CI workflows once a GitHub remote exists.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `ci-verification-tiers` Verification tiers by change size | Adds a rule that sets how much to verify by the size of a change: compile only for cosmetic edits, the module's tests for one module, and the whole suite once, by the merger, for shared code. | on | low | any |
| `ci-pytest-strict` Strict test runner config | Creates a pytest.ini that makes unknown markers and config keys errors, lists every skip, makes expected failures strict, keeps discovery in tests/ and keeps temp dirs only for failed runs. | on | low | any |
| `ci-test-selection` Impact-based test selection for push and CI | Adds a selector that prints FULL, NONE or a list of tests from the files changed since a base ref, using rules in a small text file, and escalates to the full suite on config changes or unmatched paths. | off | low | any |
| `ci-hook-pre-commit-content` git pre-commit content gate | Adds a pre-commit check that reads the staged bytes and refuses non-ASCII or CR bytes in added lines, secret-shaped strings, Python that does not compile, JSON that does not parse, and files over their size budget (warning at 90 percent). | on | low | any |
| `ci-hook-commit-msg-format` commit-msg format checks | Adds a commit-msg check: a non-empty subject of at most 72 characters, ASCII only, no control bytes, and no placeholder subject such as wip or update. | on | low | any |
| `ci-hook-pre-push-suite` pre-push test gate over the pushed range | Adds a pre-push check that runs the configured suite command (through the suite gate when set), refuses a run with zero tests, and refuses when HEAD moved while the suite ran. | off | low | any |
| `ci-hook-pre-push-leak` pre-push leak scan (credentials, names, paths) | Adds a pre-push check that scans every commit in the pushed range for secret-shaped strings, home-folder paths and your own private needles, kept in a local file under .git/info that is never tracked. | on | low | any |
| `ci-hook-pre-merge-commit` pre-merge-commit runs the pre-commit gate | Adds a pre-merge-commit check that runs the same pre-commit checks for merge commits. | on | low | any |
| `ci-hooks-install-check` Hook installer + SessionStart armed check | Installs one dispatcher per git hook in the tracked .githooks folder, points core.hooksPath at it, and adds a check that warns once at session start when hooks are not armed; with --check it proves the pre-commit gate refuses a planted byte. | on | low | any |
| `ci-posttooluse-edit-guard` PostToolUse edit guard (compile, ASCII, LF) | Adds a PostToolUse hook that checks each file Claude edits or writes: ASCII only, LF only, Python compiles, JSON parses; silent when clean, one line back to Claude when not. | on | low | any |
| `ci-workflow-main` Hosted CI workflow template | Creates a GitHub Actions workflow that runs on every push, pull request and nightly: ASCII sweep, hooks-armed proof, attribution-trailer sweep and the suite, with a read-only token, full history and step timeouts below the job timeout. | off | medium | any |
| `ci-workflow-docs-complement` Docs-only push complement workflow | Creates a second workflow that runs only the tests that read docs, for repos whose main workflow ignores documentation paths. | off | low | any |
| `ci-workflow-no-paths-ignore` Main workflow runs on every push (no paths-ignore) | Adds a rule that the main workflow keeps no paths-ignore, so docs-only pushes run the whole workflow. | off | low | any |
| `ci-workflow-codeql` CodeQL weekly scan | Creates a code-scanning workflow that runs weekly and on pushes to the default branch. | off | low | any |
| `ci-local-ci-script` Local CI script defines green | Creates ci/local-ci.sh, which runs a fixed roster of gates (ASCII sweep, compile sweep, hooks armed, the suite) and prints how many are green; a gate that checked nothing fails. | off | low | any |
| `ci-verdict-cache` Gate verdict cache keyed by inputs | Adds a small cache that records a gate PASS under a hash of the commit range and the gate files, so the same range pushed to several remotes runs the gates once. | off | low | any |
| `ci-verify-env` Toolchain pin check | Adds tools/verify_env.py and a toolchain.txt that lists the expected interpreter, test runner and tool versions; the check runs before a suite and fails on a mismatch. | off | low | any |

## 17 recall

**Memory recall (recall-before-build; vault off).** Look before you build: search memory and settled records first, and keep the memory folder valid and reachable.

- Why: Memory only helps when it is searched before work starts and when every leaf can be found; the heavier vault tooling stays off until memory is large enough to need it.
- Default: on; 2 of 7 items on when the module is on.
- Pairings: needs items of `docs-memory`; usually on with `tdd-agents`.
- Enable later because: Its off items (a local vault, domain indexes, slug repair) need a large memory or a moved repository; most users never need them.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `rec-recall-before-build` Recall before building; a CLOSED hit stops the work | Adds a rule: before any non-trivial item, search memory, the ledger and the settled list for the task in your own words; a settled or closed hit stops the work. | on | low | any |
| `rec-domain-indexes` Split memory index into domain sub-indexes | Adds a rule that MEMORY.md points to one index file per domain, new leaves go into their domain index, and an index is split once it passes 16 KB. | off | low | any |
| `rec-memory-validate` Memory frontmatter and reachability validator | Adds tools/memory_validate.py and a rule to run it: every memory leaf has name, description and type, every leaf is reachable from the index, and the index and leaves stay within budget. | on | low | any |
| `rec-vault-mcp` Local memory vault (MCP server) mirror | Adds a contract file describing how a local vault you install yourself can mirror the markdown memory and inject one bounded recall block per session over MCP. | off | medium | any |
| `rec-recall-compact` Compact recall wrapper (key + summary, top 8) | Adds a rule that vault recall returns only category, key and a short summary per hit, eight hits by default, with the body fetched by key. | off | low | any |
| `rec-vault-sync-coverage` Vault sync + coverage gate (embedded == active) | Adds a rule that the vault mirror is idempotent and that a coverage gate requires every active row to be embedded before the vault counts as healthy. | off | low | any |
| `rec-project-slug` Project slug resolver (worktrees and moved repos) | Adds tools/project_slug.py, which prints the Claude project folder for the main checkout from any worktree and lists folders that look like stale copies after a move. | off | low | any |

## 18 lessons

**Repeat-failure lessons library.** Sixty-two short never-again rules, each with its reason and the incident class it prevents, kept in one lessons file with a single pointer line in CLAUDE.md.

- Why: Each rule was paid for by a real failure that happened more than once; one line of reading is cheaper than another round of the same incident. CLAUDE.md gets one pointer, so its size budget is untouched.
- Default: on; 48 of 62 items on when the module is on.
- Pairings: usually on with `floors`, `core-rules`, `session`, `race-guards`, `tdd-agents`, `docs-memory`, `headless`, `maintenance`, `ci-gates`, `recall`, `permissions-context`, `sidecar`, `machine-profile`.
- Enable later because: Its off lessons belong to specific situations (an app type, hosted CI, background runs, a stricter gate); turn each on together with the module it serves.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `lsn-ascii-only` ASCII only in scripts, configs and docs | Keep scripts, configs and docs ASCII only. | on | low | any |
| `lsn-write-bytes` Write bytes explicitly when bytes matter | Write files as bytes, or with an explicit newline setting, whenever sizes or hashes matter. | on | low | any |
| `lsn-commit-msg-file` Commit messages from a file in a private scratch folder | Write a commit message to a file in your own scratch folder and commit with -F. | on | low | any |
| `lsn-hook-proven` A hook is trusted only after it is seen to refuse | Trust a hook only after you have seen it refuse a planted bad input. | on | low | any |
| `lsn-git-hook-authoritative` The git hook is the authoritative gate; the Claude hook is defence in depth | Make the git hook the authoritative gate and treat the Claude tool hook as defence in depth. | on | low | any |
| `lsn-prepush-range` pre-push grades the pushed range, read once from stdin | In pre-push, grade every commit in the pushed range and read standard input exactly once. | on | low | any |
| `lsn-mutation-prove` Prove each gate arm reds on a planted defect | Prove every arm of a gate turns red on a planted defect before relying on it. | on | low | any |
| `lsn-empty-is-fail` An empty enumeration must fail, not pass | Treat an empty enumeration as a failure, never as a pass. | on | low | any |
| `lsn-skip-not-pass` A skipped suite is not a passing suite | Count a skipped suite or module as not run, and show skips in every report. | on | low | any |
| `lsn-full-history-ci` CI checks out full history | Check out the full git history in every CI job. | off | low | any |
| `lsn-docs-push-guarded` Docs-only pushes still run doc-reading tests | Make a docs-only push still run every test that reads docs. | off | low | any |
| `lsn-step-timeout` CI step timeout below job timeout | Set every CI step timeout below the job timeout. | off | low | any |
| `lsn-verify-fresh` Re-run claims fresh; never carry a sub-agent's count forward | Re-run a claimed result yourself before repeating it, and never carry a sub-agent's counts forward. | on | low | any |
| `lsn-claimed-green-gate` Stop gate refuses 'tests pass' with no run behind it | Refuse a 'tests pass' claim at the end of a session when no test run backs it. | off | low | any |
| `lsn-atomic-writes` Atomic writes: temp file then replace | Write shared files atomically: write a temp file in the same folder, then replace the target. | on | low | any |
| `lsn-compile-before-restart` Compile before restarting a windowless daemon | Compile or parse a background script before you restart it without a window. | on | low | Windows only |
| `lsn-kill-by-pid` Kill by PID tree, never by image name | Stop processes by their recorded PID tree, never by image name. | on | low | Windows only |
| `lsn-no-window-flag` No-window flag on every console child | Start every console child process with the no-window creation flag. | on | low | Windows only |
| `lsn-tmp-retention` Test temp retention 'failed', count 1; never a basetemp in the scratchpad | Keep test temp folders only for failed runs, one run deep, and never point the test temp root into the session scratchpad. | on | low | any |
| `lsn-private-scratch` Private scratch subfolder and unique helper names per agent | Give each agent its own scratch subfolder and unique helper file names. | on | low | any |
| `lsn-scratch-not-durable` The scratchpad does not survive /clear | Keep evidence you need later in the repo or a sidecar area, never only in the session scratchpad. | on | low | any |
| `lsn-explicit-interpreter` Launch by an explicit interpreter, never bare python3/py | Launch scripts with an explicit interpreter path, never a bare python3 or py. | on | low | Windows only |
| `lsn-cmd-shims` Spawn .cmd shims by full name from CreateProcess | From CreateProcess, start command shims by their full name, such as npm.cmd. | on | low | Windows only |
| `lsn-no-machine-paths` No home paths, host names, private names or account ids in tracked files | Keep home paths, host names, private names and account ids out of every tracked file. | on | low | any |
| `lsn-secret-fixtures` Pin secrets by hash and plant fake fixtures; never echo env values | Pin secrets by hash, test with planted fake values, and never echo an environment value. | on | low | any |
| `lsn-scan-beyond-repo` Secret scans cover scratch and shared areas too | Run secret scans over scratch and shared areas too, not only over the repo. | off | low | any |
| `lsn-no-amend-no-tags` Never amend, never push --tags; rewrites are gated | Never amend a commit or push --tags; a history rewrite goes through a gated tool. | on | low | any |
| `lsn-index-lock` Clear a stale index.lock only through the lock tool | Clear a stale index.lock only through the commit lock tool, after checking that no git process runs. | on | low | any |
| `lsn-no-cd-chain-destructive` Never chain cd with a destructive git command | Never chain cd with a destructive git command; name the repo with git -C instead. | on | low | any |
| `lsn-worktree-gaps` Worktrees lack ignored files and unpushed commits | Remember that a worktree lacks ignored files and commits not on its base; copy them or use a full copy. | on | low | any |
| `lsn-no-prune-on-mtime` Never prune on age alone; check for a consumer | Never delete on age alone; check for a consumer first. | on | low | any |
| `lsn-prove-recycle-bin` Prove the Recycle Bin will take it before a large delete | Before a large delete, prove that the Recycle Bin will take it. | on | low | any |
| `lsn-no-walk-links` Never walk or delete through junctions or mount points | Stop at junctions, symlinks and mount points when you walk or delete a tree. | on | low | any |
| `lsn-cap-fixture-size` Cap fixture and harness sizes; watch free disk | Cap fixture and harness sizes, and check free disk before large writes. | on | low | any |
| `lsn-memory-aware-suites` Run concurrent suites by measured memory; OOM output is void | Run concurrent suites only as far as measured free memory allows, and treat output from a run killed for memory as void. | on | low | any |
| `lsn-exit-code-from-file` Read exit codes from a file or with pipefail | Read a command's exit status from a file or with pipefail, never through a pipe into tail or head. | on | low | any |
| `lsn-keep-summary-line` Never silence the runner's summary line | Never silence the test runner's summary line. | on | low | any |
| `lsn-append-fields` Append new dataclass fields at the end with a default | Append a new field at the end of a data class, with a default. | off | low | any |
| `lsn-backfill` A data fix includes the backfill of rows already corrupted | Ship a data fix together with the backfill of the rows it already corrupted. | on | low | any |
| `lsn-fix-the-class` Grep for the fix's shape; fix the class, not the instance | After a fix, search for the same shape elsewhere and fix the class, not the instance. | on | low | any |
| `lsn-refute-cap` Cap refute rounds, then adjudicate | Cap review and refute rounds, then hand the question to an adjudicator. | on | low | any |
| `lsn-responder-marks-read` A responder marks every note handled; disable a task whose fires all halt | Make an automated responder mark every note handled, and disable a task whose runs all halt. | off | low | any |
| `lsn-task-liveness` Check a scheduled task really fires; trigger windows expire | Check that a scheduled task really fires, and note when its trigger window expires. | on | low | any |
| `lsn-hermetic-tests` Tests never read user config or live state | Keep tests hermetic: never read user config, home-folder files or live state. | on | low | any |
| `lsn-testpaths-isolation` Restrict test discovery to the repo's own test dirs | Restrict test discovery to the repo's own test folders. | on | low | any |
| `lsn-readonly-responder` Read-only automated runs get no shell at all | Give a read-only automated run no shell tool at all. | off | low | any |
| `lsn-strip-auth-env` Strip provider auth variables from spawned children | Strip provider auth variables from the environment of every spawned child. | off | low | any |
| `lsn-everything-rotates` Every log and accreting file has a retention | Give every log and every file that only grows a retention or a size cap. | on | low | any |
| `lsn-stale-bytecode` Suspect stale bytecode; use a separate pycache prefix | Suspect stale bytecode when a change has no effect, and keep the cache under a separate prefix. | off | low | any |
| `lsn-anchored-hooks` Anchor hook commands to the project dir | Anchor every hook command to the project folder. | on | low | any |
| `lsn-one-source-per-number` State each threshold once; reference it elsewhere | State each threshold in one place and reference it everywhere else. | on | low | any |
| `lsn-cite-headings` Cite headings and ids, not line numbers or unpublished commits | Cite headings and ids, never line numbers or unpublished commit hashes. | on | low | any |
| `lsn-tos-floor` Never touch a running game or app process | Never touch a running game or app process, its memory or its input; edit only its offline config files. | off | low | any |
| `lsn-idle-control` Run an idle control before attributing a timing change | Run an idle control before you attribute a timing change to your edit. | off | low | any |
| `lsn-kill-tree` Stopping a task kills the wrapper, not its child; stop the tree | Stop a task's whole process tree, not just its wrapper. | on | low | Windows only |
| `lsn-generated-output-gated` Generated reports pass the same content gates | Run generated reports and files through the same content gates as hand-written ones. | on | low | any |
| `lsn-repoint-after-move` After moving a repo, re-point hooksPath, shortcuts, memory slug and tasks | After moving a repo, re-point the hooks path, shortcuts, the memory project folder and scheduled tasks. | on | low | any |
| `lsn-short-paths` Keep generated paths short | Keep generated file and folder names short and shallow. | off | low | Windows only |
| `lsn-no-saturation` Never saturate the machine: harness <= cores, at most two suite builders | Never saturate the machine: keep load harnesses at or below the core count and run at most two whole suites at once. | on | low | any |
| `lsn-product-floor` Product before process: track the share of product commits | Track the share of commits that change the product, and keep it above a floor you set. | off | low | any |
| `lsn-deferral-dated` A deferral without a date is not a deferral | Give every deferral a date or a trigger, or record it as dropped. | on | low | any |
| `lsn-reversal-clause` Every settled or do-not-redo entry names what reverses it | Give every settled or do-not-redo entry a clause naming what would reverse it. | on | low | any |

## 19 permissions-context

**Permissions, MCP and context economy.** Grants stay local, a deny floor protects history, hooks are anchored, MCP stays local, and sessions close with /done instead of compacting.

- Why: Settings decide what Claude may do without asking and what every session pays in context; these defaults remove prompts for safe commands while refusing the few that destroy work, even under bypass.
- Default: on; 6 of 9 items on when the module is on.
- Pairings: needs items of `core-rules`, `session`, `headless`; usually on with `lessons`.
- Enable later because: Its off items are for later: a tool floor for background runs, a text-first guard with desktop-automation tools, and a stricter chat cap.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `cfg-settings-split` Tracked settings hold hooks/env; permissions stay local | Adds a rule that the tracked project settings hold hooks, safe env values and deny rules only, and gitignores the local settings file that holds permission mode and allow lists. | on | low | any |
| `cfg-allowlist-narrow` Narrow allow list instead of bypass | Adds a local allow list for read-only and verification commands (git status, log and diff, the test runners, CI status); everything else still asks first. | on | low | any |
| `cfg-deny-floor` Deny list for history-destroying commands | Adds deny rules to the tracked project settings for commit --amend, push --force and --tags, reset --hard and rm -rf of the repo root or its .git folder; deny rules hold even when bypass permissions is on. | on | low | any |
| `cfg-headless-tool-floor` Headless permission floor per run kind | Adds a file that gives each kind of unattended run its own floor: code runs accept edits with a fixed tool list, responders get read-only tools, planners run in plan mode; no kind ever gets a skip-permissions flag. | off | medium | any |
| `cfg-mcp-local` MCP config local and gitignored; no OAuth server on a critical path | Gitignores the project MCP config and adds a rule: re-wire steps live in the README, no OAuth-gated server sits on a path unattended runs depend on, and headless runs use a strict MCP config. | on | low | any |
| `cfg-compaction-by-done` Close the session at ~70% context instead of auto-compaction | Adds a rule: at about 70 percent context, run /done and /clear instead of letting the session compact itself; a transcript over 10 MB is a warning, over 20 MB urgent. | on | low | any |
| `cfg-hook-anchored` Hook commands anchored to the project dir | Adds a rule that every hook command starts from an absolute anchor such as the project-folder variable, never a path relative to the current folder. | on | low | any |
| `cfg-text-first-guard` Text-first guard for screen-scrape tools | Adds a PreToolUse hook that denies the first screenshot, screen-scrape or clipboard tool call of a session with a reminder to read the same content as text first; a second call goes through. | off | low | any |
| `cfg-chat-token-cap` Chat answer token cap | Adds a rule that a chat answer stays under about 500 tokens, with detail written to a file the answer names. | off | low | any |

## 20 sidecar

**Sidecar areas outside the repo and their cleanup.** One known home outside the repo for worktrees, scratch, test temp, walk-throughs and archives, with checked moves and measured retention.

- Why: Heavy output inside a repo or in system Temp bloats backups, slows logons and hides secrets; most single-repo users never need it, so the areas stay off until they do, while the outside-writes register and the runtime reaper stay on.
- Default: off; 2 of 10 items on when the module is on.
- Pairings: needs items of `floors`; usually on with `lessons`.
- Enable later because: Off by default because most single projects never need a second folder. Turn it on once worktrees, evidence files or bundles start to bloat the project or Temp.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `sc-sidecar-root` Sidecar root with fixed areas per repo | Sets one sidecar root for this repo outside the repo folder, with five fixed areas (Worktree, Scratch, Temp, Walk, Archive), records it in local git config and adds a rule and a small tool that prints the paths. | off | low | any |
| `sc-worktree-area` Worktree area: lanes and adopt copies | Puts lane and adopt worktrees in the sidecar Worktree area and adds a removal check: merged into its base, clean, not locked, ignored files listed, unmerged commits saved under a ref before removal. | off | low | any |
| `sc-scratch-area` Scratch area for heavy evidence and copies | Adds a rule that measurement output, adversary copies, bundles and harness output go to the sidecar Scratch area, one folder per run. | off | low | any |
| `sc-temp-area` Per-repo temp root for test runs | Adds a rule that test temp goes to a per-checkout folder in the sidecar Temp area, never the session scratchpad and never a temp root shared by two runs. | off | low | any |
| `sc-walk-area` Walk area for sandbox and walk-through harnesses | Adds a rule that sandbox configs, mapped folders and walk-through results live in the sidecar Walk area, one folder per run. | off | low | any |
| `sc-archive-area` Archive area: verified bundles and zips | Adds a rule that pre-rewrite git bundles, retired copies and adopt originals go to the sidecar Archive area with their sha256 recorded and the bundle verified. | off | low | any |
| `sc-move-protocol` Move protocol: copy, compare, recycle, HOLD on consumer | Adds tools/sidecar_move.py: it holds when a tracked file still names the source, copies without following links, compares count, bytes and sha256, proves the Recycle Bin can take the source, then recycles it. | off | low | any |
| `sc-cleanup-policy` Retention per sidecar area | Adds tools/sidecar_reap.py: a dry run by default, an age histogram per area, and recycling of per-run folders older than a retention measured from that histogram; Archive is never cleaned automatically. | off | medium | any |
| `sc-outside-repo-register` Register of everything written outside the repo | Creates a register file that lists every path the repo writes outside its own folder, why and how it is cleaned, and a rule to update it in the same change that adds a path. | on | low | any |
| `sc-runtime-ignored-reaped` In-repo runtime dir gitignored and reaped | Gitignores a .runtime folder and log files and adds tools/reap_runtime.py, which removes regenerable runtime files past a measured age and keeps the folder under a 100 MB cap. | on | low | any |

## 21 runtime-agents

**Runtime agent roster (supervisor + numbered agents).** A supervisor and eight numbered agent charters (gatekeeper, lead, backend, testing, analyst, UI, auditor, context) with a single-writer queue and a bounded spawn, as templates.

- Why: When a project is itself an agent system that runs unattended, each agent needs one charter and one write area, one owner of state, and bounded runs; most users never need this, so all of it stays off.
- Default: off; 0 of 12 items on when the module is on.
- Pairings: needs items of `headless`; no usual partners outside the module.
- Enable later because: Off by default and too much for most users. Turn it on only when the project is itself an agent system that must run unattended; it needs the headless module.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `rta-supervisor` Runtime agent supervisor (orchestrator daemon) | Adds a supervisor charter and skeleton: one process that owns runtime state, refreshes a heartbeat lock, reconciles stale tasks every 5 minutes and dispatches ready tasks to numbered agents. | off | high | any |
| `rta-agent0-gatekeeper` Runtime agent 0: gatekeeper | Adds the charter for agent 0, a deterministic policy gate that accepts or rejects routed tasks against fixed criteria, with no model call; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | medium | any |
| `rta-agent1-lead` Runtime agent 1: lead | Adds the charter for agent 1, the only writer of the task queue, routing each task to approval, the gatekeeper or ready; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | medium | any |
| `rta-agent2-backend` Runtime agent 2: backend | Adds the charter for agent 2, the backend owner, changing only its declared folders and proposing changes to frozen files; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-agent3-testing` Runtime agent 3: testing | Adds the charter for agent 3, the test owner, running the suite deterministically and using a model only to write tests; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-agent4-analyst` Runtime agent 4: analyst | Adds the charter for agent 4, an advisory analyst started after a domain event, writing curated data and proposals only; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-agent5-ui` Runtime agent 5: UI | Adds the charter for agent 5, the UI owner, changing only the declared UI folders; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-agent6-auditor` Runtime agent 6: auditor | Adds the charter for agent 6, a weekly auditor writing ASCII reports and proposals with the strongest model; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-agent7-context` Runtime agent 7: context | Adds the charter for agent 7, an intake agent that turns plain-language requests into task filings and never dispatches; the charter fixes role, write-list, what it never touches, trigger, model, order and output. | off | high | any |
| `rta-ephemeral-spawn` Ephemeral agent spawn with charter, budget and timeout | Adds runtime/spawn.py, which runs one agent task through the profile's headless spawn helper with its charter, an explicit tool list, no session persistence, a timeout, and provider auth variables stripped. | off | high | any |
| `rta-task-queue` Single-writer append-only task queue with category gates | Adds runtime/task_queue.py: an append-only queue written by the lead alone under a lock, with hard-gate, policy-gate and ready categories, retry once then dead-letter, and rotation past a size cap. | off | low | any |
| `rta-propose-only` Unattended agents propose, never apply, on protected files | Adds a rule and a proposals folder: unattended agents change frozen files and prompts only by writing a proposal that you apply yourself. | off | low | any |

## 22 machine-profile

**Local machine profile and advisors (LOCAL ONLY).** A local-only spec of this machine and its installed apps, and advisors that turn it into proposals you acknowledge one by one; the engine code does the work, these items switch it on.

- Why: Measured hardware makes tuning and thresholds right for this machine, but it means reading the whole machine, so the module is off until you ask; nothing leaves the machine, and every proposal is backed up and revertable.
- Default: off; 1 of 15 items on when the module is on.
- Pairings: needs items of `floors`, `maintenance`; no usual partners outside the module.
- Enable later because: Off by default because it reads the whole machine (locally only). Turn it on when you want advice on tuning, for example a game's settings or test slots from your RAM.

| Item | What it does | Default | Risk | Where |
|---|---|---|---|---|
| `mach-spec-ingest` First-run local machine spec ingest | Reads this machine's spec once: model, CPU cores and threads, RAM size and configured versus rated speed, GPUs, disks and free space, displays, OS build and power plan; saved only in the console data folder. | off | low | Windows only |
| `mach-installed-inventory` Installed apps and games inventory | Lists installed apps and games read-only from the uninstall registry keys, Steam library folders and known config locations, with each app's install folder and config files. | off | low | Windows only |
| `mach-app-config-edit` App/game config edit: existing keys only, backup, read back | Edits an app or game config file only through the engine: existing keys only, never a new key or a changed type, refused while the app runs, a dated backup beside the file, every key read back, and a revert on any mismatch. | off | high | Windows only |
| `mach-tos-floor` Game and app ToS floor | Never touches a running game process, its memory or its input; only the offline config files the game itself writes from its own options menu are ever edited, and only while it is closed. | on | low | any |
| `mach-adv-machine` Advisor: machine | Proposes machine settings from measurements: Temp file count against logon time, free disk, boot trend, RAM configured versus rated speed and the power plan, as maintenance settings with measured thresholds. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-adv-games` Advisor: games | Proposes per-game settings from the GPU, CPU and display (upscaler mode, frame generation, latency mode), applied through the config edit item with the game closed. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | high | Windows only |
| `mach-adv-apps` Advisor: apps | Proposes app changes that affect the console: startup entries, driver profile backups, browser and editor settings, each with its backup path. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | high | Windows only |
| `mach-adv-repo-rules` Advisor: repo rules | Proposes suite slots and test workers from RAM and cores, parallel test settings and load-harness limits. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-adv-tasks` Advisor: scheduled tasks | Proposes a logon-delay ladder without collisions, checks that each task really fires (a Ready state can be stale) and lists trigger expiry dates. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-adv-commands` Advisor: commands | Proposes which profile commands fit this machine, for example headless lanes only with enough RAM and sandbox tests only where Windows Sandbox is enabled. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-adv-cleanliness` Advisor: cleanliness | Proposes retentions for Temp, sidecar areas, stale worktrees, runtime folders and Claude transcript size, each from a measured age histogram. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-adv-design` Advisor: professional design | Proposes console density, font size and motion settings from the display resolution, scaling, refresh rate and the reduced-motion preference. Every proposal is an ordinary profile change: shown, acknowledged per item, backed up, applied in a transaction, read back and revertable. | off | medium | Windows only |
| `mach-findings-rules` Health findings as rules (generic subset) | Adds the generic health findings as rules: a Temp count alarm, a cutoff that never fires, tasks with a missing executable (after expanding variables, stripping quotes and resolving bare names on PATH), low disk, a stale backup and orphan headless browsers. | off | low | Windows only |
| `mach-quiet-bench` Quiet-window benchmark | Runs benchmarks only in a quiet window: CPU median at most 20 percent and peak at most 25 percent, at night, with background loops paused. | off | medium | Windows only |
| `mach-gpu-lock` Machine-wide GPU/slot lock | Serialises GPU or other heavy jobs across repos with one named machine-wide lock and a slot bucket. | off | low | Windows only |

