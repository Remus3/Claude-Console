# Docs readability audit agent (CON-DOCS-OPTIN)

A defined, repeatable review of the console's user docs for a human reader. Run it
after any change to `README.md` or `docs/*.md`, and as the docs part
of CON-AUDIT. It reviews text only: it never starts the console, never opens the
live server on :7800 and never takes screenshots.

## How to run it

Start one sub-agent (sonnet is enough, effort low or medium) with the prompt below.
It reads the files, writes nothing, and returns a findings table. The caller applies
the fixes it accepts and records the verdict in the commit message.

## Prompt

```
You are a UI/UX readability reviewer for Claude Console's user documentation.
Read docs/capabilities.md (the user guide) and the feature list in README.md. To check facts,
you may read public/index.html (the visible labels) and public/app.js
- labels in the docs must match what the screen says. Do not start any program,
do not open http://127.0.0.1:7800, do not edit any file.

Review against the checklist below. For each failed item give: file, section
heading, the exact sentence, the checklist id, and a rewrite. Report at most 25
findings, most harmful first, then one line per checklist id with pass / fail.
Finish with a verdict: READABLE, READABLE WITH FIXES, or NOT READABLE.
```

## Checklist

Each item is pass / fail for the whole guide.

| Id | Check |
|---|---|
| R1 COVERAGE | Every button, Settings section and top-bar element in `public/index.html` is described in `capabilities.md`, under the label the screen shows. |
| R2 DEFAULT | Every feature states one of: On by default, Off by default (opt-in), Always on. |
| R3 OPT-IN | Every opt-in feature says where to turn it on and why you would, in the form "Turn on X to ..." or "Tick X to ...". |
| R4 EXAMPLE | Every feature with a choice or a setting has a short concrete example (what you do, what you then see). |
| R5 PLAIN | Plain words for a non-developer: no internal ids (CON-*, R5, G3), no file paths or API routes unless the reader types them; jargon explained on first use. |
| R6 SHORT | Sentences mostly under 25 words; paragraphs under 6 lines; one idea per bullet. |
| R7 LABELS | Button and setting names are bold or quoted exactly as on screen (case and punctuation included). |
| R8 SAFE | Every action that deletes, stops, restarts or writes outside the console says what it touches, that it asks first, and how to undo it (Recycle Bin, backup, rollback). |
| R9 TRUE | No statement contradicts the code (defaults, limits, numbers such as 50 MB, 14 days, 12 chips, 0-12 rows). |
| R10 PRIVATE | No personal names, emails, account ids, tokens or machine user names. |
| R11 ASCII | ASCII only, LF line ends. |
| R12 FIND | Headings are tasks or feature names a reader would scan for; sections are in screen order (left, middle, right, top, bottom, Settings). |

## Last run

2026-10-18, first draft of `capabilities.md`: READABLE WITH FIXES (R9 TRUE, R10
PRIVATE, R11 ASCII passed). Applied in the same commit: Look and feel and
Accounts sections with defaults (R1, R2), a default line and an example in every
section (R2, R4), opt-in reasons (R3), paths and jargon replaced or explained
(R5), long paragraphs split (R6), exact labels (R7), undo / backup wording for
Quit, Repair and the per-project extra controls (R8), sections in screen order (R12).
