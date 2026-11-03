'use strict';
// UX-1 STANDARD s4 R-items, second batch: R4 vendored tokens.css, R5 tool-name state
// (PreToolUse / PostToolUse hooks -> pane.tool), R6 line classes, R8 pane progress.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../public/app.js');
const { Pane } = require('../server/panes');
const { hookSettings } = require('../server/claudeenv');

const PUB = path.join(__dirname, '..', 'public');

test('R4: app.css takes status colours from the fleet tokens, index.html loads tokens.css first', () => {
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  for (const [k, v] of [['ok', 'status-ok'], ['busy', 'status-running'], ['warn', 'status-warn'], ['bad', 'status-bad'], ['idle', 'status-idle'], ['halted', 'status-halted'], ['muted', 'text-muted'], ['headless', 'chart-6']]) {
    assert.match(css, new RegExp('--' + k + ': var\\(--fk-' + v + '[,)]'), k);
  }
  assert.ok(!/--fk-surface:\s*#/.test(css), 'no private copy of fleet token values');
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(html.indexOf('/tokens.css') > 0 && html.indexOf('/tokens.css') < html.indexOf('/app.css'));
});

test('R13: system theme option and media-query light chrome', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<option value="system">system<\/option>/);
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\)/);
});

test('R12: one new-pane entry (no Shell buttons beside New)', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.ok(!/id="btn-shell"|id="rail-shell"/.test(html));
  assert.match(html, /id="btn-new"/);
  assert.match(html, /id="rail-new"/);
});

test('R5: hook settings add PreToolUse -> tool and PostToolUse -> tooldone', () => {
  const h = hookSettings('C:\\node.exe', 'C:\\hook.js');
  assert.match(h.hooks.PreToolUse[0].hooks[0].command, / tool$/);
  assert.match(h.hooks.PostToolUse[0].hooks[0].command, / tooldone$/);
});

function pane() {
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, { cfg: {} });
  p.state = 'waiting';
  return p;
}

test('R5: tool hooks set and clear pane.tool; Stop clears it; busySince is the turn start', () => {
  const p = pane();
  const seen = [];
  p.on('state', (i) => seen.push(i));
  p.hook('busy', null, null);
  const turn = p.busySince;
  p.hook('tool', null, null, 'Bash');
  assert.strictEqual(p.state, 'busy');
  assert.strictEqual(p.tool, 'Bash');
  assert.ok(p.toolSince >= turn);
  assert.strictEqual(p.busySince, turn);
  assert.strictEqual(p.info().tool, 'Bash');
  p.hook('tooldone', null, null, 'Bash');
  assert.strictEqual(p.tool, null);
  assert.strictEqual(p.state, 'busy');
  p.hook('tool', null, null, 'mcp__srv__do<x>');
  assert.strictEqual(p.tool, 'mcp__srv__dox', 'name sanitised');
  p.hook('waiting', null, null);
  assert.strictEqual(p.tool, null);
  assert.ok(seen.some((i) => i.tool === 'Bash'));
});

test('R5: a tool ending after a permission prompt returns the pane to busy', () => {
  const p = pane();
  p.hook('tool', null, null, 'Bash');
  p.hook('attention', 'Claude needs your permission to use Bash', null);
  assert.strictEqual(p.state, 'attention');
  p.hook('tooldone', null, null, 'Bash');
  assert.strictEqual(p.state, 'busy');
  assert.strictEqual(p.note, null);
});

test('R5: the manager accepts tool / tooldone with the pane secret only', () => {
  const { PaneManager } = require('../server/panes');
  if (!PaneManager) return;
  const m = new PaneManager({ cfg: {} });
  const p = pane();
  p.secret = 's3cret';
  m.panes.set(p.id, p);
  m.refreshDone = () => {};
  assert.strictEqual(m.hook(p.id, 'nope', 'tool', null, null, 'Bash'), false);
  assert.strictEqual(m.hook(p.id, 's3cret', 'tool', null, null, 'Bash'), true);
  assert.strictEqual(p.tool, 'Bash');
});

test('R5: header word - working (never the tool name, CON-PANEL-NOTOOL) / thinking + minutes, vocabulary word otherwise', () => {
  const now = 1000000000;
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'claude', tool: 'Bash', busySince: now - 125000, toolSince: now - 5000 }, now), 'working 2m');
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'claude', tool: 'Read', toolSince: now - 5000 }, now), 'working');
  for (const t of ['Bash', 'Read', 'PowerShell', 'mcp__claude_ai_Claude_Docs__create']) assert.doesNotMatch(C.paneWord('running', 'running', { kind: 'claude', tool: t, toolSince: now - 600000 }, now), new RegExp(C.toolLabel(t)));
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'claude', tool: null, busySince: now - 80000 }, now), 'thinking 1m');
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'shell', busySince: now }, now), 'running');
  assert.strictEqual(C.paneWord('idle', 'idle', { kind: 'claude', tool: 'Bash' }, now), 'idle');
  assert.strictEqual(C.toolLabel('mcp__claude_ai_Claude_Docs__create'), 'create');
  assert.strictEqual(C.age(3 * 3600000), '3h');
  assert.strictEqual(C.age(59000), '');
});

test('R6: line classifier - tool call, sub-agent call, error result, else unmarked', () => {
  assert.strictEqual(C.classifyLine('\u23fa Bash(npm test)'), 'tool');
  assert.strictEqual(C.classifyLine('  \u25cf Read(C:\\Work\\x.js)'), 'tool');
  assert.strictEqual(C.classifyLine('\u23fa mcp__srv__tool(arg)'), 'tool');
  assert.strictEqual(C.classifyLine('\u23fa Agent(Explore the repo)'), 'agent');
  assert.strictEqual(C.classifyLine('\u23fa Task(build)'), 'agent');
  assert.strictEqual(C.classifyLine('  \u23bf  Error: ENOENT'), 'error');
  assert.strictEqual(C.classifyLine('  \u23bf  Exit code 2'), 'error');
  assert.strictEqual(C.classifyLine('  \u23bf  Read 40 lines'), null);
  assert.strictEqual(C.classifyLine('\u23fa Done (3 files). Next I will run tests.'), null);
  assert.strictEqual(C.classifyLine('plain text Bash(x)'), null);
  assert.strictEqual(C.classifyLine(''), null);
});

test('R8: top running progress item for the pane header', () => {
  const F = C.Flow;
  assert.strictEqual(F.top([]), null);
  assert.strictEqual(F.top([{ status: 'done', pct: 100 }]), null);
  const t = F.top([{ task: 'ux1b', status: 'running', pct: 45, eta_s: 300, step: 's', checklist: [{ id: 'B2', task: 'build', state: 'running', eta_s: 240 }, { id: 'B3', state: 'pending' }] }]);
  // CON-ETA-REMAIN: no "started" = '<pct>% ~<rem> Remain'
  assert.deepStrictEqual([t.text, t.cls], ['B2 45% ~4m Remain', 'on']);
  assert.strictEqual(F.top([{ task: 'x', status: 'running', pct: 10, eta_s: 30 }]).text, '10% ~0.5m Remain');
  assert.deepStrictEqual([F.top([{ task: 'x', status: 'running', stale: true }]).text, F.top([{ task: 'x', status: 'running', stale: true }]).cls], ['STALE', 'stale']);
});

test('CON-CONFIRM: no browser confirm()/prompt() calls left in app.js; askConfirm uses #dlg-group', () => {
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/(^|[^\w.])(window\.)?(confirm|prompt)\(/m.test(src), 'a native confirm()/prompt() call remains');
  for (const s of ["title: 'Close pane'", "title: 'Retired project'", "title: 'Quit Claude Console'"]) assert.ok(src.includes(s), s);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<dialog id="dlg-group"[\s\S]*id="gr-safe"[\s\S]*id="gr-go"/);
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.match(css, /#dlg-group\.mode-confirm \.gr-name-row/);
});

// CON-PANEL-WRAP (operator 2026-10-25: "content is always cut off in panels"): the
// progress rows, the header progress slot and the card ETA wrap; none clips or ellipsises.
test('R2-18: a checklist row whose own state is done draws as done, not as an empty box', () => {
  const F = require('../public/app.js').Flow;
  const f = F.create(1000);
  F.update(f, [{ file: 'a.json', task: 'a', status: 'running', pct: 10, eta_s: 60, step: 's', updated: 1001, stale: false, checklist: [{ id: 'L1', task: 'warm', state: 'done' }, { id: 'L2', task: 'load', state: 'running' }, { id: 'L3', task: 'next', state: 'pending' }] }]);
  assert.deepStrictEqual(f.rows.map((r) => r.state), ['done', 'running', 'pending']);
});

test('R2-10 ruling: expand carets are v and ^, outside the state glyphs; the idle glyph stays', () => {
  const fs = require('fs');
  const pub = require('path').join(__dirname, '..', 'public');
  const js = fs.readFileSync(require('path').join(pub, 'app.js'), 'utf8');
  assert.ok(!/tool-toggle', [^)]*\? '-' : '\+'/.test(js), 'no +/- tool toggle');
  assert.strictEqual((js.match(/tool-toggle', \w+(\.\w+)? \? 'v' : '\^'/g) || []).length, 3, 'project, group, sub-category');
  assert.match(js, /trk-caret'\)\.textContent = trkOpen \? 'v' : '\^'/);
  assert.match(js, /card-name', \(open \? 'v ' : '\^ '\) \+ p\.name/, 'status card caret');
  assert.match(js, /idle: '-'/, 'idle glyph unchanged');
  assert.match(js, /Claude\\'s input box is hidden\. Click to show it\./);
});

test('R2-5 ruling: the title keeps 12ch; under 400 px the progress slot and blank badge collapse', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /\.pane-head \.ptitle \{[^}]*min-width: 12ch;[^}]*flex: 1 1 auto;/);
  assert.match(css, /\.pane\.pane-narrow \.pane-head \.pprog, \.pane\.pane-narrow \.pane-head \.badge\.slot\.blank \{ display: none; \}/);
  assert.match(css, /\.badge\.slot \{ width: 12ch;/, 'the slot itself stays');
});

test('pane header: from 400 to 599 px the running text has its own line; above that it keeps 16ch beside the slots', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /toggle\('pane-narrow', w < 400\);\s+this\.root\.classList\.toggle\('pane-mid', w >= 400 && w < 600\);/);
  assert.match(css, /\.pane\.pane-mid \.pane-head \{ flex-wrap: wrap;/);
  assert.match(css, /\.pane\.pane-mid \.pane-head \.pprog\.on, \.pane\.pane-mid \.pane-head \.pprog\.stale \{ order: 1; flex: 1 0 100%; \}/);
  assert.match(css, /\.pane-head \.pprog\.on \{[^}]*min-width: 16ch;/);
});

test('CON-PANEL-WRAP: progress rows, header progress slot and card ETA wrap, never clip', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'app.css'), 'utf8');
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (sel) => { const m = new RegExp('(?:^|\\n)' + esc(sel) + ' \\{([^}]*)\\}').exec(css); assert.ok(m, sel); return m[1]; };
  for (const sel of ['.frow', '.frow > span', '.frow.clk .fc2', '.pane-head .pprog', '.card .kv .kv-eta']) {
    const body = rule(sel);
    assert.doesNotMatch(body, /text-overflow|white-space: nowrap|overflow: hidden|max-width/, sel);
  }
  assert.doesNotMatch(rule('.frow'), /(^|;)\s*height:/, '.frow has no fixed height');
  assert.match(rule('.frow'), /min-height:/);
  assert.match(rule('.frow > span'), /overflow-wrap: anywhere/);
});
