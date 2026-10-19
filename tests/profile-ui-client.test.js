'use strict';
// CON-013 L5: the pure client helpers of the setup profile UI (public/profile.js,
// public/setup-paths.js, public/recovery.js) and the page-file rules: ASCII + LF, colours
// only from tokens, the type scale, every dialog and entry point present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PF = require('../public/profile.js').Profile;
const SP = require('../public/setup-paths.js').Setup;
const RV = require('../public/recovery.js').Recovery;

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

test('browser: module glyph + word + count, never colour alone', () => {
  assert.strictEqual(PF.moduleGlyph({ locked: true, on: 8, total: 8 }), '[+]');
  assert.strictEqual(PF.moduleCount({ locked: true, on: 8, total: 8 }), 'always on');
  assert.strictEqual(PF.moduleGlyph({ on: 0, total: 6 }), '[ ]');
  assert.strictEqual(PF.moduleGlyph({ on: 3, total: 6 }), '[~]', 'partly on: [~] (UX-N9), never the idle [-]');
  assert.strictEqual(PF.moduleGlyph({ on: 6, total: 6 }), '[+]');
  assert.strictEqual(PF.moduleCount({ on: 3, total: 6 }), '3/6');
  assert.strictEqual(PF.riskWord('high'), '! high risk');
  assert.strictEqual(PF.riskWord('medium'), 'medium');
  assert.strictEqual(PF.riskWord('low'), 'low');
  assert.strictEqual(PF.scopeWord({ windowsOnly: true, scope: 'template' }), 'Windows only, template');
  assert.strictEqual(PF.stateWord({ locked: true }), 'always on');
  assert.strictEqual(PF.stateWord({ state: 'off' }), 'off');
  assert.strictEqual(PF.listText(['a', 'b'], { a: { title: 'A' } }), 'A, b');
  assert.strictEqual(PF.listText([], {}), '-');
});

test('review: plan grouped per module in profile order; typed acks complete only when every phrase matches', () => {
  const modules = [{ id: 'b', title: 'B', order: 2, items: [{ id: 'b1' }] }, { id: 'a', title: 'A', order: 1, items: [{ id: 'a1' }, { id: 'a2' }] }];
  const g = PF.groupPlan({ rows: [{ item: 'b1', status: 'new' }, { item: 'a2', status: 'differs' }, { item: 'a1', status: 'new' }] }, modules);
  assert.deepStrictEqual(g.map((x) => x.module), ['a', 'b']);
  assert.deepStrictEqual(g[0].counts, { differs: 1, new: 1 });
  assert.strictEqual(PF.countsText({ new: 2, differs: 1, same: 0 }), '2 new, 1 differs');
  assert.strictEqual(PF.countsText({}), 'nothing to change');
  const hr = [{ id: 'x' }, { id: 'y' }];
  assert.strictEqual(PF.acksComplete(hr, { x: 'apply x' }), false);
  assert.strictEqual(PF.acksComplete(hr, { x: 'apply x', y: ' apply y ' }), true);
  assert.strictEqual(PF.acksComplete([], {}), true);
  assert.strictEqual(PF.verifyGlyph({ running: true }), '[>]');
  assert.strictEqual(PF.verifyGlyph({ ok: true }), '[+]');
  assert.strictEqual(PF.verifyGlyph({ ok: false }), '[x]');
  assert.strictEqual(PF.verifyWord({ skipped: true }), 'skipped');
});

test('adopt: glyph + word per status, defaults pre-check only missing + low risk + no break risk, file:line', () => {
  assert.strictEqual(PF.adoptGlyph('conforms') + ' ' + PF.adoptWord('conforms'), '[+] conforms');
  assert.strictEqual(PF.adoptGlyph('differs') + ' ' + PF.adoptWord('differs'), '[~] differs');
  assert.strictEqual(PF.adoptGlyph('missing') + ' ' + PF.adoptWord('missing'), '[ ] missing');
  assert.strictEqual(PF.adoptGlyph('conflicts') + ' ' + PF.adoptWord('conflicts'), '[x] conflicts');
  assert.strictEqual(PF.adoptGlyph('local-only') + ' ' + PF.adoptWord('local-only'), '[-] local');
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low' }), true);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', break_risk: 'path-read' }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { risk: 'low' }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'high' }), false);
  // The real L3x shapes: the engine's own default wins; report-only rows are no choice.
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', default: false }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { risk: 'low', default: true }), true);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', breakRisk: { class: 'crlf-required', reasons: [] } }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { reportOnly: true, default: true }), false);
  assert.strictEqual(PF.adoptGlyph('off') + ' ' + PF.adoptWord('off'), '[-] off');
  assert.strictEqual(PF.rangeText([[12, 14], [20, 20]]), '12-14, 20');
  assert.strictEqual(PF.fileLine({ files: [{ file: 'CLAUDE.md', orig: [[12, 14]], copy: [[12, 18]] }] }), 'CLAUDE.md:12-14 -> 12-18');
  assert.strictEqual(PF.fileLine({ files: [{ file: 'a.md', orig: [], copy: [[1, 3]] }, { file: 'docs/b.md', orig: [[4, 4]], copy: [] }] }), 'a.md -> 1-3; docs/b.md:4');
  assert.strictEqual(PF.fileLine({ file: 'NOTES.md', files: [] }), 'NOTES.md');
  assert.strictEqual(PF.breakText({ breakRisk: { class: 'path-read', reasons: ['read by app/render.js:14'] } }), 'path-read: read by app/render.js:14');
  assert.strictEqual(PF.checkSide({ code: 0, ok: true, ms: 1200, timedOut: false, counts: { passed: 10, failed: 0, skipped: 0 } }), 'exit 0, 10 pass / 0 fail, 1.2 s');
  assert.strictEqual(PF.checkSide({ code: null, timedOut: true, ms: 10000, counts: null }), 'timed out, 10 s');
  assert.strictEqual(PF.verdictGlyph('WORSE'), '[x]');
});

test('wizard: Step x of y, y from what the path needs, update path, rail glyphs', () => {
  const inputs = { env: [{ name: 'PYTHONUTF8' }, { name: 'ANTHROPIC_API_KEY', secret: 'k' }], secrets: [{ name: 'k' }], variables: [{ name: 'repo_code' }, { name: 'headless_base_url' }], tasks: [{ name: 'T' }], account: { needed: true } };
  assert.deepStrictEqual(SP.stepsFor('preset', inputs), ['path', 'glance', 'env', 'keys', 'account', 'details', 'tasks', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor('custom', inputs), ['path', 'modules', 'env', 'keys', 'account', 'details', 'tasks', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor('preset', { env: [], secrets: [], variables: [], tasks: [], account: { needed: false } }), ['path', 'glance', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor(null, inputs, { update: true }), ['update', 'review', 'preview', 'apply']);
  const s = SP.stepsFor('preset', inputs);
  assert.strictEqual(SP.label(s, 0), 'Step 1 of 10 - How do you want to set up?');
  assert.strictEqual(SP.label(s, 7), 'Step 8 of 10 - Before you enable anything');
  assert.strictEqual(SP.label(s, 9), 'Step 10 of 10 - Apply and verify');
  assert.deepStrictEqual(SP.rail(['a', 'b', 'c'], 1), ['[+]', '[>]', '[ ]']);
  // UX-F2: every rail item has its step name and state in words for screen readers
  assert.deepStrictEqual(['path', 'glance', 'review'].map((x, i, a) => SP.railWord(a, 1, i)), ['How do you want to set up?, done', 'Modules at a glance, current', 'Before you enable anything, to do']);
  // UX-F1: the chosen path card mark is outside the state vocabulary
  assert.strictEqual(SP.cardMark(true), '(o) ');
  assert.strictEqual(SP.cardMark(false), '( ) ');
  for (const k of s) assert.ok(SP.TITLES[k], 'title for ' + k);
});

test('wizard: skipped inputs are named in the off line; task consent grouped on path A, per task on path B', () => {
  assert.strictEqual(SP.offLine({ item: 'hl-kill-switch', title: 'Kill switch', needs: ['headless_base_url', 'secret:anthropic-key'] }), '[ ] off - needs proxy URL, API key anthropic-key - Kill switch');
  assert.strictEqual(SP.skipKey('env', 'X'), 'env:X');
  assert.strictEqual(SP.skipKey('task', 'T'), 'task:T');
  assert.strictEqual(SP.skipKey('secret', 's'), 'secret:s');
  assert.strictEqual(SP.skipKey('var', 'repo_code'), 'repo_code');
  const tasks = [{ name: 'A' }, { name: 'B' }];
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, true, {}), []);
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, false, {}), ['task:A', 'task:B']);
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, null, {}), ['task:A', 'task:B'], 'no answer = no task');
  assert.deepStrictEqual(SP.taskSkips('custom', tasks, true, { A: true }), ['task:B'], 'path B: no select-all, each task its own yes');
  assert.strictEqual(SP.validValue({ pattern: '^http://127\\.0\\.0\\.1:[0-9]{2,5}/?$' }, 'http://127.0.0.1:8080'), true);
  assert.strictEqual(SP.validValue({ pattern: '^http://127\\.0\\.0\\.1:[0-9]{2,5}/?$' }, 'http://example.com'), false);
  assert.strictEqual(SP.validValue({}, ''), false);
  // UX-F20: a plain-English hint, never the regex
  for (const v of [{ name: 'repo_code', type: 'code', pattern: '^[A-Z][A-Z0-9]{1,5}$' }, { name: 'headless_base_url', type: 'url', pattern: '^http' }, { name: 'operator_ident', type: 'git-ident' }, { name: 'x', type: 'int' }, { name: 'y' }]) {
    const t = SP.hintFor(v);
    assert.match(t, /^(must|is not)/, v.name);
    assert.ok(!/[\^$]/.test(t), v.name + ' hint shows no regex: ' + t);
  }
  assert.strictEqual(SP.hintFor({ hint: 'must be a colour' }), 'must be a colour');
});

test('glyph table: state vocabulary only where a state is meant (UX-F13..F16, N9, N10)', () => {
  assert.strictEqual(PF.rowGlyph('differs'), '[~]', 'differs is neutral, not STALE [!]');
  assert.strictEqual(PF.rowGlyph('same'), '   ', 'same rows carry no glyph');
  assert.strictEqual(PF.rowGlyph('new'), '[+]');
  assert.strictEqual(PF.rowGlyph('conflict'), '[x]');
  const src = read('profile.js') + read('setup-paths.js') + read('recovery.js');
  assert.ok(!/'\[!\] /.test(src), 'no [!] (STALE) glyph in the L5 screens');
  assert.ok(!/\[>\] Update to|\[>\] Merge/.test(src), 'no running glyph on the update card title');
  assert.strictEqual(PF.opWord('removeOriginal'), 'Removing the original');
  assert.strictEqual(PF.opLine('promote', 'remove-original done'), 'Removing the original - done');
  assert.strictEqual(PF.opLine('check', ''), 'Running the function check - done');
});

test('recovery: size and action lines', () => {
  assert.strictEqual(RV.sizeText(512), '512 bytes');
  assert.strictEqual(RV.sizeText(2048), '2 KB');
  assert.match(RV.actionLine({ ok: true, action: 'issue', truncated: true }), /save the report to a file and attach it/);
  assert.match(RV.actionLine({ ok: true, action: 'save', file: 'x.txt' }), /saved to x\.txt/);
  assert.match(RV.actionLine({ ok: false, reason: 'no' }), /^\[x\] no/);
});

test('page files: ASCII + LF only', () => {
  for (const f of ['profile.js', 'setup-paths.js', 'recovery.js', 'profile.css', 'index.html', 'app.js']) {
    const b = fs.readFileSync(path.join(PUB, f));
    assert.ok(!b.includes(13), f + ' has a CR byte');
    const bad = b.findIndex((x) => x > 0x7e || (x < 0x20 && x !== 0x0a && x !== 0x09));
    assert.strictEqual(bad, -1, f + ' has a non-ASCII byte at ' + bad);
  }
});

test('profile.css: colours only from tokens / chrome variables, sizes only from the type scale', () => {
  const css = read('profile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepStrictEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [], []);
  assert.deepStrictEqual(css.split('\n').filter((l) => /font-size:\s*[\d.]+(px|pt|em|rem)/.test(l)), []);
  assert.match(css, /var\(--fk-status-bad\)/);
  assert.match(css, /var\(--fs-secondary\)/);
});

test('index.html: dialogs, header overflow entries, settings section and scripts', () => {
  const html = read('index.html');
  for (const id of ['dlg-profile', 'wz-page', 'dlg-adopt', 'dlg-machine', 'dlg-crash', 'dlg-stop', 'dlg-help', 'btn-more', 'top-menu', 'set-profile', 'prof-line', 'btn-prof-browse', 'btn-prof-setup', 'btn-crash', 'wz-back', 'wz-switch', 'wz-next', 'wz-cancel', 'cr-issue', 'cr-claude', 'cr-save', 'st-go', 'gh-go']) assert.match(html, new RegExp('id="' + id + '"'), id);
  for (const act of ['profile', 'setup', 'adopt', 'machine', 'crash', 'help', 'stop']) assert.match(html, new RegExp('data-act="' + act + '"'), act);
  const scripts = [...html.matchAll(/<script src="\/([a-z-]+\.js)"/g)].map((m) => m[1]).filter((s) => !/^(xterm|addon)/.test(s));
  assert.deepStrictEqual(scripts.slice(-4), ['app.js', 'profile.js', 'setup-paths.js', 'recovery.js']);
  assert.match(html, /<link rel="stylesheet" href="\/profile\.css">/);
});

test('index.html: no duplicate ids (UX-B2: the help dialog once reused the hp-* ids of another panel)', () => {
  const html = read('index.html');
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  assert.deepStrictEqual([...seen].filter(([, n]) => n > 1).map(([id]) => id), []);
  // and no id is built in the L5 scripts that the page already has
  for (const f of ['profile.js', 'setup-paths.js', 'recovery.js']) {
    for (const m of read(f).matchAll(/h\('[a-z0-9]+(?:\.[A-Za-z0-9_-]+)*#([A-Za-z0-9_-]+)/g)) assert.ok(!seen.has(m[1]), f + ' builds #' + m[1] + ' which index.html already has');
  }
  assert.match(html, /id="btn-more"[^>]*aria-label="More"/, 'the ... button has a name (UX-F10)');
});

test('wizard: a full-page view with Skip for now, never a modal dialog (VERIFY ruling on UX-F23)', () => {
  const html = read('index.html');
  assert.match(html, /<section id="wz-page" class="wz-page"[^>]*hidden>/);
  assert.ok(!/<dialog[^>]*id="(dlg-wizard|wz-page)"/.test(html), 'not a <dialog>');
  assert.match(html, /<button type="button" id="wz-cancel">Skip for now<\/button>/);
  const js = read('setup-paths.js');
  assert.ok(!/showModal/.test(js), 'the wizard never calls showModal');
  assert.match(read('profile.css'), /\.wz-page \{ position: fixed; inset: 0;/);
});
