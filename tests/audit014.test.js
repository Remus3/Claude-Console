'use strict';
// CON-AUDIT pass 2 (0.1.4 hardening): the safe fixes from the security review.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPaneEnv } = require('../server/claudeenv');
const S = require('../installer/safekill');

test('SEC-1a: the console API key variables never reach a pane; SEC-8: run panes get no hook channel', () => {
  const base = { PATH: 'x', CLAUDE_CONSOLE_ACCT1_API_KEY: 'k1', claude_console_acct2_api_key: 'k2', OTHER: 'y' };
  for (const kind of ['claude', 'shell', 'run']) {
    const env = buildPaneEnv(base, { kind, paneId: 'abcd1234', hookUrl: 'http://127.0.0.1:1/', hookSecret: 's' });
    assert.ok(!Object.keys(env).some((k) => /api_key/i.test(k)), kind + ' carries a key variable');
    assert.strictEqual(env.OTHER, 'y');
    assert.strictEqual(env.CONSOLE_PANE, 'abcd1234');
    if (kind === 'run') assert.ok(!('CONSOLE_HOOK_SECRET' in env) && !('CONSOLE_HOOK_URL' in env));
    else assert.strictEqual(env.CONSOLE_HOOK_SECRET, 's');
  }
});

const HAS_FLEET = fs.existsSync(path.join(__dirname, '..', 'server', 'trackers-fleet.js')); // stripped from the public build
test('SEC-3: the tracker label drops a secret flag AND its value, and token-like words', { skip: !HAS_FLEET }, () => {
  const F = require('../server/trackers-fleet');
  assert.strictEqual(F.cmdLabel(['npm', 'test', '--token', 'abc123']), 'npm test');
  assert.strictEqual(F.cmdLabel(['pytest', '--api-key=zzz', '-q']), 'pytest -q');
  assert.strictEqual(F.cmdLabel(['run', 'sk-ant-xyz', 'A'.repeat(30), 'ok']), 'run ok');
});

test('SEC-4: a log pane passes colour escapes and drops every other escape sequence', async () => {
  const { PaneManager } = require('../server/panes');
  const { tmpdir, writeFile } = require('./helpers');
  const root = tmpdir('cc-a14-');
  const file = path.join(root, 'x.log');
  writeFile(file, 'a\x1b[31mred\x1b[0m\x1b]0;fake title\x07\x1b[2Jb\n');
  const m = new PaneManager({}, {});
  clearInterval(m.timer);
  m.logPollMs = 20;
  m.homSpec = () => ({ kind: 'log', svc: 'x', logFile: file, cwd: root, title: 'log: x', file: null, args: [] });
  const p = m.create({ kind: 'log', svc: 'x', cwd: root });
  const out = p.replay();
  m.close(p.id);
  assert.ok(out.includes('\x1b[31mred\x1b[0m'), 'colour kept');
  assert.ok(!out.includes('\x1b]') && !out.includes('\x1b[2J'), 'OSC and screen clear dropped: ' + JSON.stringify(out));
});

test('SEC-5: a run pane in its graceful stop still blocks a second copy of the recipe', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'panes.js'), 'utf8');
  assert.match(src, /for \(const o of \[\.\.\.this\.panes\.values\(\), \.\.\.this\.stopping\]\)/);
  assert.match(src, /this\.stopping\.add\(p\);/);
});

test('SEC-6: with a spawn time but no process list nothing is killed; without one the root only', () => {
  const k1 = [];
  S.killTreeSync(100, 5000, { list: () => null, kill: (p) => { k1.push(p); return true; } });
  assert.deepStrictEqual(k1, []);
  const k2 = [];
  S.killTreeSync(100, 0, { list: () => null, kill: (p) => { k2.push(p); return true; } });
  assert.deepStrictEqual(k2, [100]);
});

test('SEC-7: pane create and restart are loopback-only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(src, /if \(p === '\/api\/panes' && m === 'POST'\) \{\n\s+if \(!isLoopback\(req\)\) return send\(res, 403/);
  assert.match(src, /if \(pm\[2\] === 'restart' && m === 'POST'\) \{\n\s+if \(!isLoopback\(req\)\) return send\(res, 403/);
});
