'use strict';
// CON-013 L4: the setup profile's machine adapters (installer/profile-env.js,
// profile-secrets.js, profile-route.js, profile-tasks.js, profile-appconfig.js and the
// PowerShell children in installer/ps/). Every OS effect goes through an injected
// runner; this file drives FAKES only. No test writes a real environment variable,
// secret, route file or scheduled task (floor: never run a machine-reconfiguring
// script on this box to test it). The .ps1 children are only parse-checked with
// Windows PowerShell 5.1.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');
const { FakeOS } = require('./fakeos');
const S = require('../server/scheduler');
const C = require('../installer/profile-oscommon');
const E = require('../installer/profile-env');
const SEC = require('../installer/profile-secrets');
const RT = require('../installer/profile-route');
const T = require('../installer/profile-tasks');
const A = require('../installer/profile-appconfig');

const NOW = () => Date.UTC(2026, 9, 18, 12, 0, 0);
const PS_DIR = path.join(__dirname, '..', 'installer', 'ps');

// ------------------------------------------------------------------ fake machine
// A fake HKCU\Environment + DPAPI. It understands exactly the env.ps1 / secret.ps1
// operations; "protected" bytes are XOR-hex so a plaintext value never appears in a
// written file. Every call is recorded with its argv, its env and (separately) its stdin.
const protect = (v) => 'FAKEDPAPI:' + Buffer.from(v, 'utf8').map((b) => b ^ 0x5a).toString('hex');
const unprotect = (t) => Buffer.from(String(t).trim().slice('FAKEDPAPI:'.length), 'hex').map((b) => b ^ 0x5a).toString('utf8');

class FakeMachine {
  constructor(vars) {
    this.vars = new Map(Object.entries(vars || {}).map(([k, v]) => [k, typeof v === 'string' ? { value: v, kind: 'String' } : v]));
    this.calls = [];
    this.inputs = [];
    this.broadcasts = 0;
    this.corruptSet = false;
    this.failOp = null;
    this.route = null; // {mode, fallback?, config_dir?}
    this.failRouteSet = false;
  }
  state(name) {
    const v = this.vars.get(name);
    return v ? { present: true, kind: v.kind, sha256: C.sha256(v.value), length: v.value.length } : { present: false };
  }
  runner() {
    return async (file, args, opts) => {
      const env = Object.assign({}, (opts && opts.env) || {});
      const input = opts && opts.input !== undefined ? String(opts.input) : '';
      this.calls.push({ file, args: args.slice(), env });
      this.inputs.push(input);
      const fi = args.indexOf('-File');
      const script = fi >= 0 ? path.basename(args[fi + 1]) : path.basename(args[0] || '');
      const out = (o, code) => ({ code: code || 0, stdout: JSON.stringify(o) + '\n', stderr: '' });
      if (script === 'env.ps1') {
        const op = env.CC_ENV_OP;
        const name = env.CC_ENV_NAME;
        if (this.failOp === op) return { code: 1, stdout: '', stderr: 'access denied' };
        if (op === 'read') return out(this.state(name));
        if (op === 'capture') {
          const s = this.state(name);
          if (s.present) fs.writeFileSync(env.CC_ENV_FILE, protect(this.vars.get(name).value));
          return out(s);
        }
        if (op === 'set' || op === 'set-secret' || op === 'restore') {
          const value = op === 'set' ? input : unprotect(fs.readFileSync(env.CC_ENV_FILE, 'utf8'));
          this.vars.set(name, { value: this.corruptSet && op === 'set' ? value + 'X' : value, kind: env.CC_ENV_KIND });
          this.broadcasts++;
          return out(this.state(name));
        }
        if (op === 'remove') { this.vars.delete(name); this.broadcasts++; return out(this.state(name)); }
        return out({ error: 'bad op' }, 2);
      }
      if (script === 'secret.ps1') {
        const op = env.CC_SECRET_OP;
        if (this.failOp === 'secret-' + op) return { code: 1, stdout: '', stderr: 'dpapi failed' };
        if (op === 'put') {
          fs.mkdirSync(path.dirname(env.CC_SECRET_FILE), { recursive: true });
          fs.writeFileSync(env.CC_SECRET_FILE, protect(input));
          return out({ ok: true, length: input.length, sha256: C.sha256(input) });
        }
        if (op === 'check') {
          if (!fs.existsSync(env.CC_SECRET_FILE)) return out({ ok: false });
          const v = unprotect(fs.readFileSync(env.CC_SECRET_FILE, 'utf8'));
          return out({ ok: true, length: v.length, sha256: C.sha256(v) });
        }
        return out({ error: 'bad op' }, 2);
      }
      if (/kit_headless\.py$/.test(args[0] || '')) {
        const rest = args.slice(1);
        if (rest[0] === 'route' && rest[1] === 'show') {
          if (!this.route) return out({ mode: null, valid: false, reason: 'headless route file missing', code: 'route-missing' }, 1);
          const d = { mode: this.route.mode, valid: true, reason: null };
          if (this.route.fallback) d.fallback = this.route.fallback;
          return out(d);
        }
        if (rest[0] === 'route' && rest[1] === 'set') {
          if (this.failRouteSet) return out({ error: 'headless route invalid: config_dir holds no account credentials file', code: 'route-invalid' }, 2);
          const r = { mode: rest[2] };
          const ci = rest.indexOf('--config-dir');
          if (ci >= 0) r.config_dir = rest[ci + 1];
          const fb = rest.indexOf('--fallback');
          if (fb >= 0) r.fallback = rest[fb + 1];
          this.route = r;
          const d = { mode: r.mode, valid: true, reason: null };
          if (r.fallback) d.fallback = r.fallback;
          return out(d);
        }
      }
      return { code: 9, stdout: '', stderr: 'unexpected call ' + script };
    };
  }
  ops(script) {
    return this.calls.filter((c) => c.args.some((a) => path.basename(a) === script)).map((c) => c.env.CC_ENV_OP || c.env.CC_SECRET_OP);
  }
  // Everything the adapters handed the OS EXCEPT stdin: argv and environment.
  visible() {
    return JSON.stringify(this.calls);
  }
}

function journalIn(dir) {
  const lines = [];
  return { fn: (e) => { lines.push(JSON.parse(JSON.stringify(e))); fs.appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify(e) + '\n'); }, lines };
}

function txDir() {
  const d = tmpdir('cc-l4-tx-');
  fs.mkdirSync(path.join(d, 'pre'), { recursive: true });
  return d;
}

const SECRET_VALUE = 'Zq9-fake-value-0123456789abcdef';

// ------------------------------------------------------------------ common

test('oscommon: Windows-only gate, masked display, psArgs never carry values, sha256', () => {
  assert.deepStrictEqual(C.windowsOnly('linux'), { status: 'skipped', reason: 'Windows only' });
  assert.strictEqual(C.windowsOnly('win32'), null);
  assert.strictEqual(C.mask({ present: false }), 'not set');
  assert.strictEqual(C.mask({ present: true, length: 12 }), 'set (12 chars)');
  const a = C.psArgs('env.ps1');
  assert.deepStrictEqual(a.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.strictEqual(path.basename(a[5]), 'env.ps1');
  assert.strictEqual(C.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('ps children: present, ASCII + LF only', () => {
  for (const f of ['env.ps1', 'secret.ps1', 'read-secret.ps1']) {
    const b = fs.readFileSync(path.join(PS_DIR, f));
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(b.toString('latin1')), f + ' is ASCII + LF');
  }
});

test('ps children parse under Windows PowerShell 5.1 (ParseFile only, nothing runs)', { skip: process.platform !== 'win32' }, () => {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const f of fs.readdirSync(PS_DIR).filter((x) => x.endsWith('.ps1'))) {
    const p = path.join(PS_DIR, f).replace(/'/g, "''");
    const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + p + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'parsed'";
    const res = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(res.status, 0, f + ': ' + res.stdout + res.stderr);
    assert.match(res.stdout, /parsed/);
  }
});

test('adapter source files are ASCII + LF', () => {
  for (const f of ['profile-oscommon.js', 'profile-env.js', 'profile-secrets.js', 'profile-route.js', 'profile-tasks.js', 'profile-appconfig.js']) {
    const b = fs.readFileSync(path.join(__dirname, '..', 'installer', f), 'latin1');
    assert.ok(/^[\x0a\x20-\x7e]*$/.test(b), f);
  }
});

// ------------------------------------------------------------------ env adapter

function envAdapter(m, extra) {
  const logs = [];
  const env = E.createEnvAdapter(Object.assign({ runner: m.runner(), platform: 'win32', log: (l) => logs.push(l) }, extra || {}));
  return { env, logs };
}

test('env: every catalogued variable has an explanation; unknown names fall back to the item', () => {
  for (const n of ['PYTHONUTF8', 'CLAUDE_CODE_NO_FLICKER', 'KIT_SUITE_SLOTS', 'CLAUDE_HEADLESS_BASE_URL']) {
    const x = E.explain(n);
    assert.ok(x && x.does && x.why, n);
  }
  assert.match(E.explain('CLAUDE_HEADLESS_BASE_URL').does, /kill switch/i);
  const y = E.explain('MY_VAR', { title: 'My thing', does: 'Does it.', why: 'Because.' });
  assert.deepStrictEqual([y.does, y.why], ['Does it.', 'Because.']);
  assert.strictEqual(E.explain('MY_VAR'), null);
});

test('env: describe shows name, scope, explanation, proposed value and a masked current value', async () => {
  const m = new FakeMachine({ PYTHONUTF8: '0' });
  const { env } = envAdapter(m);
  const d = await env.describe({ name: 'PYTHONUTF8', value: '1', scope: 'user' });
  assert.strictEqual(d.name, 'PYTHONUTF8');
  assert.strictEqual(d.scope, 'user');
  assert.ok(d.does && d.why);
  assert.strictEqual(d.proposed, '1');
  assert.strictEqual(d.current, 'set (1 chars)');
  assert.strictEqual(d.matches, false);
  const s = await env.describe({ name: 'MY_TOKEN', secret: 'api-key', scope: 'user' });
  assert.strictEqual(s.proposed, 'secret reference api-key');
  assert.strictEqual(s.current, 'not set');
});

test('env: plan is read-only and classifies new / same / differs', async () => {
  const m = new FakeMachine({ A_SAME: '1', A_DIFF: '0' });
  const { env } = envAdapter(m);
  assert.strictEqual((await env.plan({ name: 'A_NEW', value: '1' })).status, 'new');
  assert.strictEqual((await env.plan({ name: 'A_SAME', value: '1' })).status, 'same');
  assert.strictEqual((await env.plan({ name: 'A_DIFF', value: '1' })).status, 'differs');
  assert.deepStrictEqual([...new Set(m.ops('env.ps1'))], ['read']);
});

test('env: dry run by default and refusal without consent write nothing', async () => {
  const m = new FakeMachine({});
  const { env } = envAdapter(m);
  const tx = txDir();
  const dry = await env.apply({ name: 'PYTHONUTF8', value: '1' }, { txDir: tx });
  assert.strictEqual(dry.status, 'dry-run');
  assert.strictEqual(dry.plan.status, 'new');
  const no = await env.apply({ name: 'PYTHONUTF8', value: '1' }, { apply: true, txDir: tx });
  assert.strictEqual(no.status, 'refused');
  assert.match(no.reason, /consent/);
  assert.deepStrictEqual([...new Set(m.ops('env.ps1'))], ['read']);
  assert.strictEqual(m.vars.size, 0);
});

test('env: refuses bad names, empty values, key-shaped literals, non-user scope; skips off Windows', async () => {
  const m = new FakeMachine({});
  const { env } = envAdapter(m);
  const o = { apply: true, consent: true, txDir: txDir() };
  for (const c of [{ name: 'lower', value: '1' }, { name: 'A B', value: '1' }, { name: 'X', value: '' }, { name: 'X', value: 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwx' },
    { name: 'X', value: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789' }, { name: 'X', value: '1', scope: 'machine' }, { name: 'X', value: '1', secret: 'k' }, { name: 'X', value: 'a\nb' }]) {
    const r = await env.apply(c, o);
    assert.strictEqual(r.status, 'refused', JSON.stringify(c));
  }
  const off = envAdapter(m, { platform: 'linux' }).env;
  assert.deepStrictEqual(await off.apply({ name: 'X', value: '1' }, o), { status: 'skipped', reason: 'Windows only' });
  assert.ok(!m.ops('env.ps1').some((op) => op !== 'read'));
});

test('env: apply sets on consent, reads back, and the value never reaches argv, env, log, journal or result', async () => {
  const m = new FakeMachine({});
  const { env, logs } = envAdapter(m);
  const tx = txDir();
  const j = journalIn(tx);
  const value = 'value-only-on-stdin-77';
  const r = await env.apply({ name: 'MY_SETTING', value }, { apply: true, consent: ['MY_SETTING'], txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  assert.strictEqual(m.vars.get('MY_SETTING').value, value);
  assert.strictEqual(m.vars.get('MY_SETTING').kind, 'String');
  assert.ok(m.broadcasts >= 1, 'WM_SETTINGCHANGE broadcast');
  assert.ok(!m.visible().includes(value), 'value not in argv or env');
  const setIdx = m.calls.findIndex((c) => c.env.CC_ENV_OP === 'set');
  assert.strictEqual(m.inputs[setIdx], value, 'value travels on stdin');
  for (const [k, text] of [['log', JSON.stringify(logs)], ['journal', fs.readFileSync(path.join(tx, 'journal.jsonl'), 'utf8')], ['result', JSON.stringify(r)]]) {
    assert.ok(!text.includes(value), 'value in ' + k);
  }
  assert.strictEqual(j.lines.length, 1);
  assert.deepStrictEqual(j.lines[0].prior, { present: false });
  assert.strictEqual(j.lines[0].kind, 'env');
  assert.strictEqual(j.lines[0].name, 'MY_SETTING');
});

test('env: an existing value is captured (protected) before the write and revert restores value and kind exactly', async () => {
  const old = 'C:\\old\\%USERPROFILE%\\bin';
  const m = new FakeMachine({ MY_PATHISH: { value: old, kind: 'ExpandString' } });
  const { env } = envAdapter(m);
  const tx = txDir();
  const j = journalIn(tx);
  const r = await env.apply({ name: 'MY_PATHISH', value: 'new' }, { apply: true, consent: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied');
  const ops = m.ops('env.ps1');
  assert.ok(ops.indexOf('capture') >= 0 && ops.indexOf('capture') < ops.indexOf('set'), 'capture before set');
  const entry = j.lines[0];
  assert.strictEqual(entry.prior.present, true);
  assert.strictEqual(entry.prior.kind, 'ExpandString');
  assert.ok(!JSON.stringify(entry).includes(old), 'prior value not in the journal');
  const pre = path.join(tx, entry.prior.pre);
  assert.ok(fs.existsSync(pre));
  assert.ok(!fs.readFileSync(pre, 'utf8').includes('old'), 'pre-image is protected');
  const dry = await env.revert(entry, { txDir: tx });
  assert.strictEqual(dry.status, 'dry-run');
  assert.strictEqual(m.vars.get('MY_PATHISH').value, 'new');
  const back = await env.revert(entry, { apply: true, txDir: tx });
  assert.strictEqual(back.status, 'reverted', back.reason);
  assert.deepStrictEqual(m.vars.get('MY_PATHISH'), { value: old, kind: 'ExpandString' });
});

test('env: revert of a variable that was absent removes it and reads back absent', async () => {
  const m = new FakeMachine({});
  const { env } = envAdapter(m);
  const tx = txDir();
  const j = journalIn(tx);
  await env.apply({ name: 'NEW_ONE', value: '1' }, { apply: true, consent: true, txDir: tx, journal: j.fn });
  const r = await env.revert(j.lines[0], { apply: true, txDir: tx });
  assert.strictEqual(r.status, 'reverted');
  assert.strictEqual(m.vars.has('NEW_ONE'), false);
});

test('env: a read-back mismatch rolls back to the prior value and reports failed', async () => {
  const m = new FakeMachine({ ROLL: '0' });
  const { env } = envAdapter(m);
  m.corruptSet = true;
  const tx = txDir();
  const r = await env.apply({ name: 'ROLL', value: '1' }, { apply: true, consent: true, txDir: tx });
  m.corruptSet = false;
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /read-back/);
  assert.strictEqual(r.rolledBack, true);
  assert.ok(m.ops('env.ps1').includes('restore'));
  assert.deepStrictEqual(m.vars.get('ROLL'), { value: '0', kind: 'String' }, 'prior value restored');
});

test('env: the same value is a no-op; a failing capture means no write', async () => {
  const m = new FakeMachine({ SAME: '1', CAP: 'x' });
  const { env } = envAdapter(m);
  const r = await env.apply({ name: 'SAME', value: '1' }, { apply: true, consent: true, txDir: txDir() });
  assert.strictEqual(r.status, 'same');
  m.failOp = 'capture';
  const c = await env.apply({ name: 'CAP', value: 'y' }, { apply: true, consent: true, txDir: txDir() });
  assert.strictEqual(c.status, 'failed');
  assert.match(c.reason, /backup/);
  assert.strictEqual(m.vars.get('CAP').value, 'x');
  assert.ok(!m.ops('env.ps1').includes('set'));
});

test('env: a secret mirror needs its own opt-in and the value goes from the DPAPI file to the registry inside PowerShell', async () => {
  const m = new FakeMachine({});
  const dataDir = tmpdir('cc-l4-data-');
  const store = SEC.createSecretStore({ dataDir, runner: m.runner(), platform: 'win32', recycle: async () => true });
  await store.put('api-key', SECRET_VALUE, { apply: true, txDir: txDir() });
  const { env } = envAdapter(m, { secrets: store });
  const tx = txDir();
  const no = await env.apply({ name: 'MY_API_KEY', secret: 'api-key', scope: 'user' }, { apply: true, consent: true, txDir: tx });
  assert.strictEqual(no.status, 'refused');
  assert.match(no.reason, /mirror/);
  const ok = await env.apply({ name: 'MY_API_KEY', secret: 'api-key', scope: 'user' }, { apply: true, consent: true, mirror: true, txDir: tx });
  assert.strictEqual(ok.status, 'applied', ok.reason);
  assert.strictEqual(m.vars.get('MY_API_KEY').value, SECRET_VALUE);
  const i = m.calls.findIndex((c) => c.env.CC_ENV_OP === 'set-secret');
  assert.ok(i >= 0);
  assert.strictEqual(m.inputs[i], '', 'nothing on stdin: node never holds the secret');
  assert.match(ok.warning, /every process/);
  assert.ok(!JSON.stringify(ok).includes(SECRET_VALUE));
});

test('env: unset removes with a journal entry (the kill-switch act) and is revertable', async () => {
  const m = new FakeMachine({ GONE: 'v' });
  const { env } = envAdapter(m);
  const tx = txDir();
  const j = journalIn(tx);
  const r = await env.unset('GONE', { apply: true, consent: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied');
  assert.strictEqual(m.vars.has('GONE'), false);
  await env.revert(j.lines[0], { apply: true, txDir: tx });
  assert.strictEqual(m.vars.get('GONE').value, 'v');
});

// ------------------------------------------------------------------ secrets

function secretStore(m, extra) {
  const dataDir = tmpdir('cc-l4-data-');
  const recycled = [];
  const logs = [];
  const store = SEC.createSecretStore(Object.assign({ dataDir, runner: m.runner(), platform: 'win32', recycle: async (p) => { recycled.push(p); fs.rmSync(p, { force: true }); return true; }, log: (l) => logs.push(l), now: NOW }, extra || {}));
  return { store, dataDir, recycled, logs };
}

function treeText(dir) {
  let out = '';
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out += e.isDirectory() ? treeText(p) : fs.readFileSync(p, 'latin1');
  }
  return out;
}

test('secrets: put stores a DPAPI file per secret; value only on stdin, never in a file, log, journal, argv or result', async () => {
  const m = new FakeMachine({});
  const { store, dataDir, logs } = secretStore(m);
  const tx = txDir();
  const j = journalIn(tx);
  const r = await store.put('api-key', SECRET_VALUE, { apply: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  const file = path.join(dataDir, 'profile', 'secrets', 'api-key.dpapi');
  assert.strictEqual(store.file('api-key'), file);
  assert.ok(fs.existsSync(file));
  assert.ok(!m.visible().includes(SECRET_VALUE));
  const putIdx = m.calls.findIndex((c) => c.env.CC_SECRET_OP === 'put');
  assert.strictEqual(m.inputs[putIdx], SECRET_VALUE);
  for (const [k, text] of [['data dir', treeText(dataDir)], ['tx dir', treeText(tx)], ['log', JSON.stringify(logs)], ['result', JSON.stringify(r)]]) {
    assert.ok(!text.includes(SECRET_VALUE), 'value in ' + k);
  }
  assert.deepStrictEqual(store.status('api-key'), { name: 'api-key', present: true, display: 'set (' + SECRET_VALUE.length + ' chars)' });
  assert.deepStrictEqual(store.status('other'), { name: 'other', present: false, display: 'not set' });
  assert.deepStrictEqual(store.list().map((s) => s.name), ['api-key']);
  assert.ok(m.ops('secret.ps1').includes('check'), 'read back through a decrypt check');
});

test('secrets: the consumer gets a command reference, never the value', () => {
  const m = new FakeMachine({});
  const { store } = secretStore(m);
  const ref = store.reference('api-key');
  assert.deepStrictEqual(Object.keys(ref), ['command']);
  assert.ok(Array.isArray(ref.command));
  assert.match(ref.command[0], /powershell\.exe$/i);
  assert.ok(ref.command.includes('-File'));
  assert.strictEqual(path.basename(ref.command[ref.command.indexOf('-File') + 1]), 'read-secret.ps1');
  assert.strictEqual(ref.command[ref.command.indexOf('-Name') + 1], 'api-key');
  const alt = store.reference('api-key', { script: 'X:\\kit\\read_secret.ps1' });
  assert.strictEqual(alt.command[alt.command.indexOf('-File') + 1], 'X:\\kit\\read_secret.ps1');
  assert.throws(() => store.reference('Bad Name'), /secret name/);
});

test('secrets: dry run, bad names, empty or multi-line values and off-Windows write nothing', async () => {
  const m = new FakeMachine({});
  const { store, dataDir } = secretStore(m);
  assert.strictEqual((await store.put('api-key', SECRET_VALUE, { txDir: txDir() })).status, 'dry-run');
  for (const [n, v] of [['Bad', 'x'], ['../x', 'x'], ['ok', ''], ['ok', 'a\nb'], ['ok', 'a\u0000b']]) {
    assert.strictEqual((await store.put(n, v, { apply: true, txDir: txDir() })).status, 'refused', n);
  }
  const off = secretStore(m, { platform: 'darwin' }).store;
  assert.strictEqual((await off.put('api-key', 'x', { apply: true, txDir: txDir() })).status, 'skipped');
  assert.strictEqual(m.ops('secret.ps1').length, 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'profile', 'secrets', 'api-key.dpapi')));
});

test('secrets: overwrite keeps the prior DPAPI file in the tx pre-images; revert restores it; a new secret is recycled, never unlinked', async () => {
  const m = new FakeMachine({});
  const { store, recycled } = secretStore(m);
  const tx1 = txDir();
  const j1 = journalIn(tx1);
  await store.put('api-key', 'first-value-123456', { apply: true, txDir: tx1, journal: j1.fn });
  const firstBytes = fs.readFileSync(store.file('api-key'));
  const tx2 = txDir();
  const j2 = journalIn(tx2);
  await store.put('api-key', 'second-value-654321', { apply: true, txDir: tx2, journal: j2.fn });
  assert.strictEqual(j2.lines[0].prior.present, true);
  const r = await store.revert(j2.lines[0], { apply: true, txDir: tx2 });
  assert.strictEqual(r.status, 'reverted');
  assert.deepStrictEqual(fs.readFileSync(store.file('api-key')), firstBytes);
  const r1 = await store.revert(j1.lines[0], { apply: true, txDir: tx1 });
  assert.strictEqual(r1.status, 'reverted');
  assert.deepStrictEqual(recycled, [store.file('api-key')]);
  assert.strictEqual(store.status('api-key').present, false);
});

test('secrets: a failed DPAPI write or read-back leaves the prior state', async () => {
  const m = new FakeMachine({});
  const { store } = secretStore(m);
  m.failOp = 'secret-put';
  const r = await store.put('api-key', SECRET_VALUE, { apply: true, txDir: txDir() });
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(store.status('api-key').present, false);
  assert.ok(!JSON.stringify(r).includes(SECRET_VALUE));
});

test('secrets: remove sends the file to the Recycle Bin with a pre-image; revert brings it back', async () => {
  const m = new FakeMachine({});
  const { store, recycled } = secretStore(m);
  await store.put('api-key', SECRET_VALUE, { apply: true, txDir: txDir() });
  const bytes = fs.readFileSync(store.file('api-key'));
  const tx = txDir();
  const j = journalIn(tx);
  const r = await store.remove('api-key', { apply: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied');
  assert.deepStrictEqual(recycled, [store.file('api-key')]);
  await store.revert(j.lines[0], { apply: true, txDir: tx });
  assert.deepStrictEqual(fs.readFileSync(store.file('api-key')), bytes);
});

// ------------------------------------------------------------------ headless route

const ACCT_MAIN = path.join(tmpdir('cc-l4-acct-'), 'main');
const ACCT_B = path.join(tmpdir('cc-l4-acct-'), 'second');
fs.mkdirSync(ACCT_MAIN, { recursive: true });
fs.writeFileSync(path.join(ACCT_MAIN, '.credentials.json'), '{}');
fs.mkdirSync(ACCT_B, { recursive: true });
const URL = 'http://127.0.0.1:3456';

function route(m, extra) {
  const logs = [];
  const env = E.createEnvAdapter({ runner: m.runner(), platform: 'win32', log: (l) => logs.push(l) });
  const r = RT.createRouteAdapter(Object.assign({ runner: m.runner(), env, python: 'C:\\py\\python.exe', kitHeadless: 'C:\\repo\\ops\\kit\\kit_headless.py', accounts: () => [ACCT_MAIN, ACCT_B], platform: 'win32', log: (l) => logs.push(l) }, extra || {}));
  return { r, logs };
}

test('route: single account is the default; the kill-switch variable is required in single mode too', async () => {
  const m = new FakeMachine({});
  const { r } = route(m);
  const p = await r.plan({ configDir: ACCT_MAIN, baseUrl: URL });
  assert.strictEqual(p.ok, true, JSON.stringify(p.errors));
  assert.strictEqual(p.mode, 'single');
  const missing = await r.plan({ configDir: ACCT_MAIN });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.errors.join(' '), /kill switch/i);
  assert.match(RT.explainKillSwitch(), /delete/i);
});

test('route: refuses a non-loopback URL, a free-text or credential-less config dir, a config dir in split mode', async () => {
  const m = new FakeMachine({});
  const { r } = route(m);
  for (const bad of ['https://127.0.0.1:3456', 'http://10.' + '0.0.5:3456', 'http://127.0.0.1', 'http://user@127.0.0.1:3456', 'http://localhost.example.com:3456']) {
    assert.strictEqual((await r.plan({ configDir: ACCT_MAIN, baseUrl: bad })).ok, false, bad);
  }
  assert.strictEqual((await r.plan({ configDir: 'C:\\elsewhere', baseUrl: URL })).ok, false);
  const nocred = await r.plan({ configDir: ACCT_B, baseUrl: URL });
  assert.strictEqual(nocred.ok, false);
  assert.match(nocred.errors.join(' '), /log in/i);
  assert.strictEqual((await r.plan({ mode: 'split', configDir: ACCT_MAIN, baseUrl: URL })).ok, false);
  assert.strictEqual((await r.plan({ mode: 'split', baseUrl: URL })).ok, true);
  assert.strictEqual((await r.plan({ mode: 'other', baseUrl: URL })).ok, false);
});

test('route: an armed fallback needs the typed acknowledgement', async () => {
  const m = new FakeMachine({});
  const { r } = route(m);
  const no = await r.plan({ mode: 'split', baseUrl: URL, fallback: 'single', configDir: ACCT_MAIN });
  assert.strictEqual(no.ok, false);
  assert.match(no.errors.join(' '), /apply hl-fallback-armed/);
  const yes = await r.plan({ mode: 'split', baseUrl: URL, fallback: 'single', configDir: ACCT_MAIN, ack: 'apply hl-fallback-armed' });
  assert.strictEqual(yes.ok, true, JSON.stringify(yes.errors));
  assert.deepStrictEqual(yes.routeArgs, ['route', 'set', 'split', '--config-dir', ACCT_MAIN, '--fallback', 'single']);
  assert.strictEqual((await r.plan({ mode: 'split', baseUrl: URL, fallback: 'split', ack: 'apply hl-fallback-armed' })).ok, false);
});

test('route: dry run reads only; apply sets the kill switch, then the route through the kit CLI, and reads both back', async () => {
  const m = new FakeMachine({});
  const { r, logs } = route(m);
  const dry = await r.apply({ configDir: ACCT_MAIN, baseUrl: URL }, { txDir: txDir() });
  assert.strictEqual(dry.status, 'dry-run');
  assert.strictEqual(m.route, null);
  assert.strictEqual(m.vars.size, 0);
  const tx = txDir();
  const j = journalIn(tx);
  const res = await r.apply({ configDir: ACCT_MAIN, baseUrl: URL }, { apply: true, consent: true, txDir: tx, journal: j.fn });
  assert.strictEqual(res.status, 'applied', res.reason);
  assert.strictEqual(m.vars.get('CLAUDE_HEADLESS_BASE_URL').value, URL);
  assert.deepStrictEqual(m.route, { mode: 'single', config_dir: ACCT_MAIN });
  const kitCalls = m.calls.filter((c) => /kit_headless\.py$/.test(c.args[0] || ''));
  assert.ok(kitCalls.every((c) => c.file === 'C:\\py\\python.exe'));
  assert.ok(!m.visible().includes(URL), 'the URL travels on stdin only');
  assert.ok(!JSON.stringify(logs).includes(ACCT_MAIN), 'the config dir is never logged');
  assert.deepStrictEqual(j.lines.map((e) => e.kind), ['env', 'route']);
  assert.deepStrictEqual(j.lines[1].prior, { valid: false, mode: null, fallback: null });
  assert.ok(!JSON.stringify(j.lines).includes(ACCT_MAIN));
});

test('route: a refused route set rolls the kill-switch variable back', async () => {
  const m = new FakeMachine({});
  const { r } = route(m);
  m.failRouteSet = true;
  const res = await r.apply({ configDir: ACCT_MAIN, baseUrl: URL }, { apply: true, consent: true, txDir: txDir() });
  assert.strictEqual(res.status, 'failed');
  assert.match(res.reason, /route-invalid|credentials/);
  assert.strictEqual(m.vars.has('CLAUDE_HEADLESS_BASE_URL'), false);
});

test('route: revert sets the prior mode back; a prior single route needs its account from the list', async () => {
  const m = new FakeMachine({});
  m.route = { mode: 'split' };
  const { r } = route(m);
  const tx = txDir();
  const j = journalIn(tx);
  await r.apply({ configDir: ACCT_MAIN, baseUrl: URL }, { apply: true, consent: true, txDir: tx, journal: j.fn });
  const re = await r.revert(j.lines[1], { apply: true });
  assert.strictEqual(re.status, 'reverted', re.reason);
  assert.strictEqual(m.route.mode, 'split');
  const m2 = new FakeMachine({});
  m2.route = { mode: 'single', config_dir: ACCT_MAIN };
  const r2 = route(m2).r;
  const j2 = journalIn(txDir());
  await r2.apply({ mode: 'split', baseUrl: URL }, { apply: true, consent: true, txDir: txDir(), journal: j2.fn });
  const need = await r2.revert(j2.lines[1], { apply: true });
  assert.strictEqual(need.status, 'refused');
  assert.match(need.reason, /account/);
  const ok = await r2.revert(j2.lines[1], { apply: true, configDir: ACCT_MAIN });
  assert.strictEqual(ok.status, 'reverted');
  assert.strictEqual(m2.route.mode, 'single');
});

test('route: kill switch status / off / on through the env adapter, journalled', async () => {
  const m = new FakeMachine({ CLAUDE_HEADLESS_BASE_URL: URL });
  const { r } = route(m);
  assert.deepStrictEqual(await r.killSwitch.status(), { name: 'CLAUDE_HEADLESS_BASE_URL', armed: true, display: 'set (' + URL.length + ' chars)' });
  const tx = txDir();
  const j = journalIn(tx);
  const off = await r.killSwitch.off({ apply: true, consent: true, txDir: tx, journal: j.fn });
  assert.strictEqual(off.status, 'applied');
  assert.strictEqual((await r.killSwitch.status()).armed, false);
  const on = await r.killSwitch.on(URL, { apply: true, consent: true, txDir: tx });
  assert.strictEqual(on.status, 'applied');
  assert.strictEqual((await r.killSwitch.on('http://10.' + '1.1.1:80', { apply: true, consent: true, txDir: tx })).status, 'refused');
});

test('route: second account setup never logs in; it returns the pane command for the user and a readiness check', () => {
  const m = new FakeMachine({});
  const { r } = route(m);
  const s = r.secondAccount(ACCT_B);
  assert.strictEqual(s.ready, false);
  assert.strictEqual(s.login.exe, 'claude');
  assert.deepStrictEqual(s.login.env, { CLAUDE_CONFIG_DIR: ACCT_B });
  assert.match(s.note, /log in/i);
  assert.strictEqual(r.secondAccount(ACCT_MAIN).ready, true);
  assert.throws(() => r.secondAccount('relative\\dir'), /absolute/);
  assert.strictEqual(m.calls.length, 0);
});

test('route: off Windows the adapter is skipped', async () => {
  const m = new FakeMachine({});
  const { r } = route(m, { platform: 'linux' });
  assert.strictEqual((await r.apply({ configDir: ACCT_MAIN, baseUrl: URL }, { apply: true, consent: true, txDir: txDir() })).status, 'skipped');
});

// ------------------------------------------------------------------ scheduled tasks

const EXE = process.execPath;
const TASK_XML = (exe, args, enabled) => '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n'
  + '  <RegistrationInfo><Author>Claude Console profile</Author><Description>Temp hygiene</Description></RegistrationInfo>\n'
  + '  <Triggers>\n    <CalendarTrigger><Repetition><Interval>PT4H</Interval></Repetition><StartBoundary>2026-01-01T04:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>\n  </Triggers>\n'
  + '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>\n'
  + '  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><Enabled>' + (enabled === false ? 'false' : 'true') + '</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT30M</ExecutionTimeLimit></Settings>\n'
  + '  <Actions Context="Author">\n    <Exec><Command>' + exe + '</Command><Arguments>' + args + '</Arguments></Exec>\n  </Actions>\n</Task>\n';
const TASK = { name: 'ClaudeProfile-TempHygiene', xml: TASK_XML(EXE, '-File hygiene.ps1'), deletes: 'scratch files older than 7 days, unlinked; nothing else' };

function tasks(fake, extra) {
  const dir = tmpdir('cc-l4-sched-');
  const sched = new S.Scheduler({ runner: fake.runner(), dataDir: path.join(dir, 'data'), runDir: path.join(dir, 'run'), projects: () => [], now: NOW });
  return { t: T.createTaskAdapter(Object.assign({ scheduler: sched, platform: 'win32' }, extra || {})), sched, dir };
}

test('tasks: the consent card names the task, trigger, what it runs, what it may delete, runtime cap and hidden', () => {
  const { t } = tasks(new FakeOS([]));
  const c = t.card(TASK);
  assert.strictEqual(c.name, 'ClaudeProfile-TempHygiene');
  assert.match(c.trigger, /daily/);
  assert.match(c.trigger, /every 240 min/);
  assert.match(c.runs, /hygiene\.ps1/);
  assert.strictEqual(c.deletes, TASK.deletes);
  assert.strictEqual(c.limitMinutes, 30);
  assert.strictEqual(c.hidden, true);
  assert.strictEqual(c.consent, 'unticked');
});

test('tasks: refuses a name outside ClaudeProfile-, elevated run level, a foreign folder, missing deletes text', () => {
  const { t } = tasks(new FakeOS([]));
  assert.throws(() => t.card(Object.assign({}, TASK, { name: 'Sample-X' })), /ClaudeProfile-/);
  assert.throws(() => t.card(Object.assign({}, TASK, { xml: TASK.xml.replace('LeastPrivilege', 'HighestAvailable') })), /least privilege/);
  assert.throws(() => t.card(Object.assign({}, TASK, { path: '\\Other\\' })), /folder/);
  assert.throws(() => t.card(Object.assign({}, TASK, { deletes: '' })), /delete/);
});

test('tasks: per-task consent only (no select-all), dry run by default, no scheduler writes without both', async () => {
  const fake = new FakeOS([]);
  const { t } = tasks(fake);
  assert.strictEqual((await t.apply(TASK, { txDir: txDir() })).status, 'dry-run');
  for (const consent of [true, '*', { '*': true }, { 'ClaudeProfile-Other': true }, ['ClaudeProfile-TempHygiene']]) {
    const r = await t.apply(TASK, { apply: true, consent, txDir: txDir() });
    assert.strictEqual(r.status, 'refused', JSON.stringify(consent));
  }
  assert.strictEqual(fake.writes().length, 0);
});

test('tasks: a new task is registered from its XML, read back, journalled as absent; revert removes it (backup first)', async () => {
  const fake = new FakeOS([]);
  const { t } = tasks(fake);
  const tx = txDir();
  const j = journalIn(tx);
  const r = await t.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  assert.ok(fake.tasks.has('\\ClaudeProfile-TempHygiene'));
  assert.deepStrictEqual(j.lines[0].prior, { present: false });
  assert.strictEqual(j.lines[0].kind, 'task');
  assert.strictEqual((await t.plan(TASK)).status, 'same');
  const before = fake.calls.length;
  const rv = await t.revert(j.lines[0], { apply: true, txDir: tx });
  assert.strictEqual(rv.status, 'reverted', rv.reason);
  assert.strictEqual(fake.tasks.has('\\ClaudeProfile-TempHygiene'), false);
  const later = fake.calls.slice(before);
  const exp = later.findIndex((c) => c[0] === 'powershell.exe' && c[1].includes(S.PS_EXPORT));
  const del = later.findIndex((c) => c[0] === 'schtasks.exe' && c[1][0] === '/Delete');
  assert.ok(exp >= 0 && exp < del, 'export backup before delete');
});

test('tasks: an existing task is exported to XML before it is replaced; revert restores the backup', async () => {
  const fake = new FakeOS([]);
  const { t } = tasks(fake);
  await t.apply(Object.assign({}, TASK, { xml: TASK_XML(EXE, '-File old.ps1') }), { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: txDir() });
  assert.strictEqual((await t.plan(TASK)).status, 'differs');
  const tx = txDir();
  const j = journalIn(tx);
  fake.calls.length = 0;
  const r = await t.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  const seq = fake.calls.map((c) => c[0] + ' ' + (c[1].includes('/F') ? '/F' : c[1][0]));
  const exp = fake.calls.findIndex((c) => c[0] === 'powershell.exe' && c[1].includes(S.PS_EXPORT));
  const cre = seq.indexOf('schtasks.exe /F');
  assert.ok(exp >= 0 && exp < cre, 'backup before write: ' + seq.join(', '));
  assert.strictEqual(j.lines[0].prior.present, true);
  assert.ok(fs.existsSync(path.join(tx, j.lines[0].prior.pre)));
  assert.match(fake.tasks.get('\\ClaudeProfile-TempHygiene').actions[0].args, /hygiene\.ps1/);
  await t.revert(j.lines[0], { apply: true, txDir: tx });
  assert.match(fake.tasks.get('\\ClaudeProfile-TempHygiene').actions[0].args, /old\.ps1/);
});

test('tasks: a read-back mismatch removes what was registered and reports failed', async () => {
  const fake = new FakeOS([]);
  fake.corruptCreate = true;
  const { t } = tasks(fake);
  const r = await t.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: txDir() });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /read-back/);
  assert.strictEqual(fake.tasks.has('\\ClaudeProfile-TempHygiene'), false);
});

test('tasks: setEnabled(false) (stop everything) backs up then disables a profile task only; revert re-enables', async () => {
  const fake = new FakeOS([{ name: 'Someone-Else', path: '\\', actions: [{ exe: EXE, args: '', workdir: '' }] }]);
  const { t } = tasks(fake);
  await t.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: txDir() });
  const tx = txDir();
  const j = journalIn(tx);
  fake.calls.length = 0;
  const r = await t.setEnabled('ClaudeProfile-TempHygiene', false, { apply: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  assert.strictEqual(fake.tasks.get('\\ClaudeProfile-TempHygiene').state, 'Disabled');
  assert.ok(fake.calls.some((c) => c[1].includes(S.PS_EXPORT)), 'XML backup taken');
  await assert.rejects(() => t.setEnabled('Someone-Else', false, { apply: true, txDir: tx }), /ClaudeProfile-/);
  await t.revert(j.lines[0], { apply: true, txDir: tx });
  assert.strictEqual(fake.tasks.get('\\ClaudeProfile-TempHygiene').state, 'Ready');
});

test('tasks: off Windows skipped; no scheduler runner means unavailable, not a crash', async () => {
  const { t } = tasks(new FakeOS([]), { platform: 'linux' });
  assert.strictEqual((await t.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: txDir() })).status, 'skipped');
  const t2 = T.createTaskAdapter({ scheduler: new S.Scheduler({ dataDir: tmpdir('cc-l4-'), now: NOW }), platform: 'win32' });
  const r = await t2.apply(TASK, { apply: true, consent: { 'ClaudeProfile-TempHygiene': true }, txDir: txDir() });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /not available/);
});

// ------------------------------------------------------------------ app-config

function appcfg(extra) {
  const running = new Set();
  const a = A.createAppConfigAdapter(Object.assign({ platform: 'win32', isRunning: async (p) => running.has(p.toLowerCase()), now: NOW }, extra || {}));
  return { a, running };
}

function cfgFile(name, text) {
  const d = tmpdir('cc-l4-app-');
  const p = path.join(d, name);
  fs.writeFileSync(p, text);
  return p;
}

const JSON_CFG = '{\n  "video": {\n    "width": 1920,\n    "vsync": true,\n    "preset": "high"\n  },\n  "list": [1, 2]\n}\n';
const INI_CFG = '[Video]\r\nWidth=1920\r\nVSync = 1\r\n; comment\r\n[Audio]\r\nVolume=80\r\n';
const XML_CFG = '<?xml version="1.0"?>\n<Config>\n  <Video Width="1920" VSync="true"/>\n  <Setting name="Quality" value="High"/>\n  <Setting name="Shadows" value="Medium"/>\n  <Fps>60</Fps>\n</Config>\n';
const VDF_CFG = '"UserLocalConfigStore"\n{\n\t"Software"\n\t{\n\t\t"Valve"\n\t\t{\n\t\t\t"Steam"\n\t\t\t{\n\t\t\t\t"BigPicture"\t\t"0"\n\t\t\t\t"FPS"\t\t"60"\n\t\t\t}\n\t\t}\n\t}\n}\n';

test('app-config: reads keys from json / ini / xml / vdf', async () => {
  const { a } = appcfg();
  assert.deepStrictEqual(A.readKeys(cfgFile('a.json', JSON_CFG), ['video.width', 'video.vsync', 'video.preset', 'nope']), {
    'video.width': { found: true, value: 1920, type: 'number' }, 'video.vsync': { found: true, value: true, type: 'boolean' },
    'video.preset': { found: true, value: 'high', type: 'string' }, nope: { found: false } });
  assert.deepStrictEqual(A.readKeys(cfgFile('a.ini', INI_CFG), ['Video.Width', 'Video.VSync', 'Audio.Volume'])['Video.VSync'], { found: true, value: '1', type: 'number' });
  const x = A.readKeys(cfgFile('a.xml', XML_CFG), ['Video@Width', 'Setting[name=Quality]@value', 'Fps', 'Setting@value']);
  assert.strictEqual(x['Video@Width'].value, '1920');
  assert.strictEqual(x['Setting[name=Quality]@value'].value, 'High');
  assert.strictEqual(x.Fps.value, '60');
  assert.strictEqual(x['Setting@value'].found, false, 'an ambiguous selector is not a key');
  assert.match(x['Setting@value'].error, /ambiguous/);
  assert.strictEqual(A.readKeys(cfgFile('a.vdf', VDF_CFG), ['UserLocalConfigStore/Software/Valve/Steam/FPS'])['UserLocalConfigStore/Software/Valve/Steam/FPS'].value, '60');
  assert.ok(a);
});

test('app-config: plan refuses a new key, a changed type, an unknown format and a running owner process', async () => {
  const { a, running } = appcfg();
  const f = cfgFile('a.json', JSON_CFG);
  const newKey = await a.plan({ file: f, process: 'game.exe', set: { 'video.hdr': true } });
  assert.strictEqual(newKey.ok, false);
  assert.match(newKey.errors.join(' '), /existing keys only/);
  const type = await a.plan({ file: f, process: 'game.exe', set: { 'video.width': 'wide' } });
  assert.strictEqual(type.ok, false);
  assert.match(type.errors.join(' '), /type/);
  assert.strictEqual((await a.plan({ file: f, process: 'game.exe', set: { list: [1] } })).ok, false);
  assert.strictEqual((await a.plan({ file: cfgFile('a.yaml', 'x: 1\n'), process: 'game.exe', set: { x: 2 } })).ok, false);
  assert.strictEqual((await a.plan({ file: f, set: { 'video.width': 2560 } })).ok, false, 'owner process is required');
  running.add('game.exe');
  const run = await a.plan({ file: f, process: 'game.exe', set: { 'video.width': 2560 } });
  assert.strictEqual(run.ok, false);
  assert.match(run.errors.join(' '), /running/);
});

test('app-config: dry run writes nothing; apply backs up beside the file and into the tx, edits only the keys, reads back', async () => {
  const { a } = appcfg();
  const f = cfgFile('a.json', JSON_CFG);
  const c = { file: f, process: 'game.exe', set: { 'video.width': 2560, 'video.preset': 'ultra' } };
  const dry = await a.apply(c, { txDir: txDir() });
  assert.strictEqual(dry.status, 'dry-run');
  assert.deepStrictEqual(dry.plan.changes.map((x) => [x.key, x.from, x.to]), [['video.width', 1920, 2560], ['video.preset', 'high', 'ultra']]);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), JSON_CFG);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f)), ['a.json']);
  const tx = txDir();
  const j = journalIn(tx);
  const r = await a.apply(c, { apply: true, txDir: tx, journal: j.fn });
  assert.strictEqual(r.status, 'applied', r.reason);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), JSON_CFG.replace('1920', '2560').replace('"high"', '"ultra"'));
  assert.strictEqual(fs.readFileSync(f + '.bak-2026-10-18', 'utf8'), JSON_CFG);
  assert.strictEqual(fs.readFileSync(path.join(tx, j.lines[0].pre), 'utf8'), JSON_CFG);
  assert.match(r.note, /confirm/i);
  const again = await a.apply(c, { apply: true, txDir: txDir() });
  assert.strictEqual(again.status, 'same');
  const r2 = await a.apply({ file: f, process: 'game.exe', set: { 'video.width': 3840 } }, { apply: true, txDir: txDir() });
  assert.strictEqual(r2.status, 'applied');
  assert.ok(fs.existsSync(f + '.bak-2026-10-18-2'), 'a same-day backup is never overwritten');
  assert.strictEqual(fs.readFileSync(f + '.bak-2026-10-18', 'utf8'), JSON_CFG);
});

test('app-config: ini (CRLF kept), xml and vdf edits change only the value bytes', async () => {
  const { a } = appcfg();
  const fi = cfgFile('a.ini', INI_CFG);
  assert.strictEqual((await a.apply({ file: fi, process: 'g.exe', set: { 'Video.VSync': '0', 'Audio.Volume': '50' } }, { apply: true, txDir: txDir() })).status, 'applied');
  assert.strictEqual(fs.readFileSync(fi, 'latin1'), INI_CFG.replace('VSync = 1', 'VSync = 0').replace('Volume=80', 'Volume=50'));
  const fx = cfgFile('a.xml', XML_CFG);
  assert.strictEqual((await a.apply({ file: fx, process: 'g.exe', set: { 'Setting[name=Shadows]@value': 'Low', Fps: '144' } }, { apply: true, txDir: txDir() })).status, 'applied');
  assert.strictEqual(fs.readFileSync(fx, 'utf8'), XML_CFG.replace('"Shadows" value="Medium"', '"Shadows" value="Low"').replace('<Fps>60</Fps>', '<Fps>144</Fps>'));
  const fv = cfgFile('a.vdf', VDF_CFG);
  assert.strictEqual((await a.apply({ file: fv, process: 'steam.exe', set: { 'UserLocalConfigStore/Software/Valve/Steam/FPS': '120' } }, { apply: true, txDir: txDir() })).status, 'applied');
  assert.strictEqual(fs.readFileSync(fv, 'utf8'), VDF_CFG.replace('"FPS"\t\t"60"', '"FPS"\t\t"120"'));
});

test('app-config: a read-back mismatch restores the pre-image; revert restores bytes and refuses a file changed since', async () => {
  const f = cfgFile('a.json', JSON_CFG);
  const bad = appcfg({ writeFile: (p, buf) => fs.writeFileSync(p, Buffer.from(buf.toString('utf8').replace('2560', '2561'))) }).a;
  const r = await bad.apply({ file: f, process: 'g.exe', set: { 'video.width': 2560 } }, { apply: true, txDir: txDir() });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.reason, /read-back/);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), JSON_CFG);
  const { a } = appcfg();
  const tx = txDir();
  const j = journalIn(tx);
  await a.apply({ file: f, process: 'g.exe', set: { 'video.width': 2560 } }, { apply: true, txDir: tx, journal: j.fn });
  assert.ok(!JSON.stringify(j.lines).includes('2560'), 'journal keeps key names and hashes, not values');
  assert.strictEqual((await a.revert(j.lines[0], { txDir: tx })).status, 'dry-run');
  fs.appendFileSync(f, ' ');
  const refused = await a.revert(j.lines[0], { apply: true, txDir: tx });
  assert.strictEqual(refused.status, 'refused');
  assert.match(refused.reason, /changed since/);
  const forced = await a.revert(j.lines[0], { apply: true, txDir: tx, force: true });
  assert.strictEqual(forced.status, 'reverted');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), JSON_CFG);
});

test('app-config: a UTF-8 BOM and UTF-16LE file keep their encoding', async () => {
  const { a } = appcfg();
  const bom = cfgFile('b.ini', '');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[A]\nX=1\n')]));
  await a.apply({ file: bom, process: 'g.exe', set: { 'A.X': '2' } }, { apply: true, txDir: txDir() });
  assert.deepStrictEqual(fs.readFileSync(bom), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[A]\nX=2\n')]));
  const u16 = cfgFile('c.xml', '');
  fs.writeFileSync(u16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<C><Fps>60</Fps></C>', 'utf16le')]));
  await a.apply({ file: u16, process: 'g.exe', set: { Fps: '90' } }, { apply: true, txDir: txDir() });
  assert.deepStrictEqual(fs.readFileSync(u16), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<C><Fps>90</Fps></C>', 'utf16le')]));
});

test('app-config: off Windows skipped', async () => {
  const { a } = appcfg({ platform: 'linux' });
  assert.strictEqual((await a.apply({ file: cfgFile('a.json', JSON_CFG), process: 'g.exe', set: { 'video.width': 1 } }, { apply: true, txDir: txDir() })).status, 'skipped');
});

// 013-VERIFY sandbox F2: <IdleTrigger /> (self-closing) was no trigger, so the remus3
// apply rolled back at sched-atlas-refresh. Every shipped task XML has its trigger.
test('tasks: every shipped profile task XML parses with a trigger (self-closing ones too)', () => {
  const dir = path.join(__dirname, '..', 'profile', 'modules');
  let n = 0;
  for (const m of fs.readdirSync(dir)) {
    const td = path.join(dir, m, 'templates', 'tasks');
    if (!fs.existsSync(td)) continue;
    for (const f of fs.readdirSync(td).filter((x) => x.endsWith('.xml'))) {
      const sum = T.summarize(fs.readFileSync(path.join(td, f), 'utf8'));
      assert.ok(sum.triggers.length >= 1, m + '/' + f + ' has no trigger');
      n++;
    }
  }
  assert.ok(n >= 8);
  assert.deepStrictEqual(T.summarize('<Task><Triggers><IdleTrigger /></Triggers></Task>').triggers.map((t) => t.kind), ['idle']);
});
