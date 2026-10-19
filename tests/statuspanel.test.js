'use strict';
// CON-UX-STATUSPANEL (S49 intake, screenshot 4): the expanded status card shows one
// "Next:" line (first sentence of the hand-off's next action, ellipsis, full block on
// hover / click) instead of the clipped monospace excerpt, and no "Inbox newest:"
// filename line; the kv inbox count becomes "inbox M new" (since the tree's last /done,
// else 24 h) with the newest note's kind + subject on hover.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../server/status');
const C = require('../public/app.js').Card;
const { makeFixture, writeFile } = require('./helpers');

const PUB = path.join(__dirname, '..', 'public');

test('noteLabel: kind + subject from a channel note filename', () => {
  assert.deepStrictEqual(S.noteLabel('2026-10-18-1215-from-HOME-ORDER-to-ALL-SIX-GH-HYGIENE-readme-ONE-ANSWER.md'), { kind: 'ORDER', subject: 'GH-HYGIENE-readme-ONE-ANSWER' });
  assert.deepStrictEqual(S.noteLabel('2026-10-18-1307-from-SF-ANSWER-to-HOME-KIT-v19-NOT-ADOPTED.md'), { kind: 'ANSWER', subject: 'KIT-v19-NOT-ADOPTED' });
  assert.deepStrictEqual(S.noteLabel('2026-10-18-0900-from-SB-RULING-REQUEST-to-HOME-lane-cap.md'), { kind: 'RULING-REQUEST', subject: 'lane-cap' });
  assert.deepStrictEqual(S.noteLabel('README.txt'), { kind: '', subject: 'README' });
  assert.ok(S.noteLabel('2026-10-18-1215-from-HOME-ORDER-to-ALL-' + 'X'.repeat(200) + '.md').subject.length <= 60);
});

test('readInbox: fresh count since the last /done, else 24 h; newest note label', async () => {
  const fx = makeFixture();
  const { discoverProjects } = require('../server/discovery');
  const p = (await discoverProjects(fx.overrides)).find((x) => x.name === 'Alpha');
  const now = Date.now();
  const r24 = S.readInbox(p, 'inbox', { now });
  assert.deepStrictEqual([r24.fresh, r24.freshBasis], [2, '24h']);
  assert.deepStrictEqual(r24.newestNote, { kind: '', subject: '2026-01-01-0000-from-X-old-name' });
  // a /done 30 minutes ago: only the note from 1 minute ago is new
  const rd = S.readInbox(p, 'inbox', { now, since: now - 30 * 60 * 1000 });
  assert.deepStrictEqual([rd.fresh, rd.freshBasis], [1, 'done']);
  // data the card no longer shows stays in the snapshot
  assert.strictEqual(rd.total, 3);
  assert.strictEqual(rd.newest.length, 3);
});

test('readDoneAt: the last /done time even when the marker no longer validates', () => {
  const fx = makeFixture();
  const dir = path.join(fx.scan, 'Alpha');
  assert.strictEqual(S.readDoneAt({ dir }), null);
  writeFile(path.join(dir, 'ops', 'loop', 'control', 'session_done.json'), JSON.stringify({ schema: 1, status: 'done', at: '2026-10-18T10:00:00Z', commit: 'x' }));
  assert.strictEqual(S.readDoneAt({ dir }), Date.parse('2026-10-18T10:00:00Z'));
});

test('nextLine: first sentence of the next-action block, heading dropped, no head fallback', () => {
  assert.strictEqual(C.nextLine(['THE SINGLE NEXT ACTION', '  Ship the widget.', '  Then test it.']), 'Ship the widget.');
  assert.strictEqual(C.nextLine(['Next action: do X', '  detail']), 'do X detail');
  assert.strictEqual(C.nextLine(['Next action:', 'decide the 2 unmerged PUBREPO worktrees (Session 119 new', '/ open items below). DELETE NOTHING first.']), 'decide the 2 unmerged PUBREPO worktrees (Session 119 new / open items below).');
  assert.strictEqual(C.nextLine(['THE SINGLE NEXT ACTION', 'see v1.2 notes, e.g. the kit']), 'see v1.2 notes, e.g. the kit');
  assert.deepStrictEqual(C.nextBlock(['THE SINGLE NEXT ACTION', '  Ship the widget.', '  Then test it.']), ['Ship the widget.', 'Then test it.']);
  assert.deepStrictEqual(C.nextBlock(['Next action: do X', '  detail']), ['do X', 'detail']);
  assert.strictEqual(C.nextLine(['THE SINGLE NEXT ACTION', '='.repeat(80), 'V19.1: merge it. Then rerun.']), 'V19.1: merge it.', 'rule lines dropped');
  assert.strictEqual(C.nextLine(null), '');
  assert.strictEqual(C.nextLine([]), '');
});

test('inboxLine: "inbox M new", newest kind + subject on hover; nothing when none are new', () => {
  const r = C.inboxLine({ total: 549, last24h: 7, fresh: 3, freshBasis: 'done', newestNote: { kind: 'ORDER', subject: 'GH-HYGIENE' } });
  assert.strictEqual(r.text, 'inbox 3 new');
  assert.match(r.title, /3 new since the last \/done/);
  assert.match(r.title, /newest: ORDER GH-HYGIENE/);
  assert.match(r.title, /549 notes in the inbox/);
  assert.match(C.inboxLine({ total: 9, fresh: 2, freshBasis: '24h', newestNote: { kind: '', subject: 'x' } }).title, /2 new in the last 24 h/);
  assert.strictEqual(C.inboxLine({ total: 9, fresh: 0, freshBasis: 'done' }), null);
  assert.strictEqual(C.inboxLine(null), null);
  for (const s of [r.text, r.title]) assert.ok(!/\.md|from-/.test(s), 'no raw filename');
});

test('card: no excerpt box, no "Inbox newest" line; Next line ellipsis styling', () => {
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.ok(!/Inbox newest/.test(js));
  assert.ok(!/el\('div', 'ho'/.test(js));
  assert.match(js, /'Next: '/);
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.ok(!/\.card \.ho\b/.test(css));
  assert.match(css, /\.card \.next \{[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.card \.next\.open \{[^}]*white-space: pre-wrap/);
});
