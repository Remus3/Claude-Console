'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildPaneEnv, hookSettings, resolveClaude } = require('../server/claudeenv');
const { PaneManager } = require('../server/panes');
const { tmpdir } = require('./helpers');

test('pane env strips the parent claude session vars and sets the account dir', () => {
  const base = { PATH: 'x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', claude_config_dir: 'old', CLAUDE_CODE_MESSAGING_TOKEN: 't', KEEP: 'y' };
  const env = buildPaneEnv(base, { kind: 'claude', account: { configDir: 'C:\\acct2' }, paneId: 'p1', hookUrl: 'http://127.0.0.1:1/', hookSecret: 's' });
  assert.strictEqual(env.CLAUDECODE, undefined);
  assert.strictEqual(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.strictEqual(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.strictEqual(env.claude_config_dir, undefined, 'case-insensitive removal');
  assert.strictEqual(env.CLAUDE_CONFIG_DIR, 'C:\\acct2');
  assert.strictEqual(env.KEEP, 'y');
  assert.strictEqual(env.CONSOLE_PANE, 'p1');
});

test('account 1 (no configDir) runs with CLAUDE_CONFIG_DIR unset; shells never get it', () => {
  const base = { CLAUDE_CONFIG_DIR: 'C:\\acct2' };
  assert.strictEqual(buildPaneEnv(base, { kind: 'claude', account: { configDir: null } }).CLAUDE_CONFIG_DIR, undefined);
  assert.strictEqual(buildPaneEnv(base, { kind: 'shell' }).CLAUDE_CONFIG_DIR, undefined);
});

test('hook settings call node hook.js with forward-slash quoted paths', () => {
  const h = hookSettings('C:\\Program Files\\nodejs\\node.exe', 'C:\\App\\server\\hook.js');
  const cmd = h.hooks.Stop[0].hooks[0].command;
  assert.strictEqual(cmd, '"C:/Program Files/nodejs/node.exe" "C:/App/server/hook.js" waiting');
  assert.deepStrictEqual(Object.keys(h.hooks).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
});

test('resolveClaude honours a configured path and never returns the WindowsApps stub', () => {
  const d = tmpdir();
  const fake = path.join(d, 'claude.exe');
  fs.writeFileSync(fake, '');
  assert.strictEqual(resolveClaude({ claudePath: fake }, { PATH: '' }), fake);
  const r = resolveClaude({}, { PATH: 'C:\\Users\\x\\AppData\\Local\\Microsoft\\WindowsApps', APPDATA: d });
  assert.ok(r === null || !/WindowsApps/i.test(r));
});

test('claude pane spec: session id, --settings hooks file, default account', () => {
  const d = tmpdir();
  const cfg = {
    runDir: d, accounts: { acct1: { configDir: null }, acct2: { configDir: 'C:\\a2' } }, defaultAccount: 'acct2',
    claudeArgs: [], useHooks: true, shells: {}, idleSeconds: 1,
  };
  const m = new PaneManager(cfg, { claudePath: 'C:\\claude.exe' });
  m.hookUrl = 'http://127.0.0.1:7800/';
  const s = m.buildSpec({ kind: 'claude', cwd: d, name: 'Main' });
  assert.strictEqual(s.account, 'acct2');
  assert.strictEqual(s.file, 'C:\\claude.exe');
  const i = s.args.indexOf('--session-id');
  assert.ok(i >= 0 && /^[0-9a-f-]{36}$/.test(s.args[i + 1]));
  assert.strictEqual(s.sessionId, s.args[i + 1]);
  assert.ok(fs.existsSync(s.args[s.args.indexOf('--settings') + 1]));
  assert.deepStrictEqual(s.args.slice(0, 2), ['--name', 'Main']);
  const r = m.buildSpec({ kind: 'claude', cwd: d, account: 'acct1', resume: '11111111-2222-3333-4444-555555555555' });
  assert.strictEqual(r.account, 'acct1');
  assert.ok(r.args.includes('--resume') && !r.args.includes('--session-id'));
  assert.throws(() => new PaneManager(cfg, {}).buildSpec({ kind: 'claude', cwd: d }), /Claude Code CLI not found/);
  m.closeAll(10);
});

test('closeAll waits for a pane closed EARLIER that has not reported exit yet (CON-E2E-FLAKY)', async () => {
  const m = new PaneManager({ runDir: tmpdir(), accounts: {}, shells: {}, idleSeconds: 1 }, {});
  let fire = null;
  let killed = 0;
  const pane = new (require('events').EventEmitter)();
  pane.state = 'busy';
  pane.proc = { onExit: (cb) => { fire = cb; }, kill: () => { killed++; } };
  pane.kill = () => pane.proc.kill();
  m.panes.set('p1', pane);
  m.close('p1');
  assert.strictEqual(killed, 1);
  assert.strictEqual(m.dying.size, 1);
  let finished = false;
  const all = m.closeAll(5000).then(() => { finished = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(finished, false, 'closeAll must not return while the killed process is still tearing down');
  fire({ exitCode: 0 });
  await all;
  assert.strictEqual(m.dying.size, 0);
});
