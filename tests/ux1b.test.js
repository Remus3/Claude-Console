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

test('R5: header word - tool + minutes, thinking, vocabulary word otherwise', () => {
  const now = 1000000000;
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'claude', tool: 'Bash', toolSince: now - 125000 }, now), 'Bash 2m');
  assert.strictEqual(C.paneWord('running', 'running', { kind: 'claude', tool: 'Read', toolSince: now - 5000 }, now), 'Read');
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
