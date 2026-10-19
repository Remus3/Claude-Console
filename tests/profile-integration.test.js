'use strict';
// INTEGRATE-1 (CON-013): the L3 engine (profile-plan + profile-tx) driving the REAL L4
// env / secret / task adapters and the L9 app-config adapter through their engine
// surfaces (createAdapter). Only the OS edge is faked: env.ps1, secret.ps1 and
// schtasks.exe are answered by in-memory runners, DPAPI is a reversible fake, and the
// app config is a temp file. Never the real registry, scheduler or a real app file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { tmpdir } = require('./helpers');
const P = require('../installer/profile');
const PL = require('../installer/profile-plan');
const TX = require('../installer/profile-tx');
const ENV = require('../installer/profile-env');
const SEC = require('../installer/profile-secrets');
const TASKS = require('../installer/profile-tasks');
const AC = require('../installer/profile-appconfig');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ENV_VALUE = 'integ-7781';
const SECRET_VALUE = 'tok-value-integ-5530';

// ------------------------------------------------------------------ the faked OS edge

const protect = (s) => 'FAKEDPAPI:' + Buffer.from(s, 'utf8').toString('base64');
const unprotect = (t) => {
  const s = String(t).trim();
  if (s === 'EMPTY') return '';
  if (!s.startsWith('FAKEDPAPI:')) throw new Error('not a protected string');
  return Buffer.from(s.slice(10), 'base64').toString('utf8');
};

// HKCU\Environment as env.ps1 sees it: name -> {value, kind}.
function fakeRegistry(initial) {
  const reg = new Map(Object.entries(initial || {}));
  const calls = [];
  const state = (n) => (reg.has(n) ? { present: true, kind: reg.get(n).kind, sha256: sha(Buffer.from(reg.get(n).value, 'utf8')), length: reg.get(n).value.length } : { present: false });
  const runner = (file, args, opts) => {
    assert.ok(/powershell\.exe$/i.test(file) && args.join(' ').includes('env.ps1'), 'env.ps1 through powershell');
    const e = opts.env;
    calls.push({ op: e.CC_ENV_OP, name: e.CC_ENV_NAME, argv: args.join(' '), env: JSON.stringify(e) });
    const n = e.CC_ENV_NAME;
    const out = (o) => ({ code: 0, stdout: JSON.stringify(o) + '\n', stderr: '' });
    switch (e.CC_ENV_OP) {
      case 'read': return out(state(n));
      case 'capture': if (reg.has(n)) fs.writeFileSync(e.CC_ENV_FILE, protect(reg.get(n).value)); return out(state(n));
      case 'set': reg.set(n, { value: String(opts.input), kind: e.CC_ENV_KIND }); return out(state(n));
      case 'set-secret': case 'restore': reg.set(n, { value: unprotect(fs.readFileSync(e.CC_ENV_FILE, 'utf8')), kind: e.CC_ENV_KIND }); return out(state(n));
      case 'remove': reg.delete(n); return out(state(n));
      default: return { code: 2, stdout: '{"error":"bad op"}\n', stderr: '' };
    }
  };
  return { reg, calls, runner };
}

// secret.ps1 (async runner, the L4 secret store's own contract).
function fakeSecretRunner() {
  return async (file, args, opts) => {
    const e = opts.env;
    const f = e.CC_SECRET_FILE;
    if (e.CC_SECRET_OP === 'put') {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, protect(String(opts.input)));
    } else if (!fs.existsSync(f)) return { code: 0, stdout: '{"ok":false}\n', stderr: '' };
    const v = unprotect(fs.readFileSync(f, 'utf8'));
    return { code: 0, stdout: JSON.stringify({ ok: true, length: v.length, sha256: sha(Buffer.from(v, 'utf8')) }) + '\n', stderr: '' };
  };
}

// schtasks.exe: \name -> {xml, enabled}.
function fakeScheduler() {
  const tasks = new Map();
  const calls = [];
  const withEnabled = (xml, on) => xml.replace(/<Enabled>(true|false)<\/Enabled>/, '<Enabled>' + on + '</Enabled>');
  const runner = (file, args) => {
    assert.ok(/schtasks\.exe$/i.test(file));
    calls.push(args.join(' '));
    const tn = args[args.indexOf('/TN') + 1];
    if (args[0] === '/Query' && args.includes('/XML')) return tasks.has(tn) ? { code: 0, stdout: tasks.get(tn), stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    if (args[0] === '/Query') return { code: 0, stdout: [...tasks.keys()].map((k) => '"' + k + '","N/A","Ready"').join('\r\n'), stderr: '' };
    if (args[0] === '/Create') {
      if (tasks.has(tn) && !args.includes('/F')) return { code: 1, stdout: '', stderr: 'ERROR: exists' };
      const b = fs.readFileSync(args[args.indexOf('/XML') + 1]);
      assert.deepStrictEqual([...b.slice(0, 2)], [0xff, 0xfe], 'task XML handed over as UTF-16LE + BOM');
      tasks.set(tn, b.slice(2).toString('utf16le'));
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (args[0] === '/Delete') { const had = tasks.delete(tn); return had ? { code: 0, stdout: 'SUCCESS', stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: not found' }; }
    if (args[0] === '/Change') {
      if (!tasks.has(tn)) return { code: 1, stdout: '', stderr: 'ERROR: not found' };
      tasks.set(tn, withEnabled(tasks.get(tn), args.includes('/ENABLE')));
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { tasks, calls, runner };
}

const TASK_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <Triggers><CalendarTrigger><StartBoundary>2026-10-18T04:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>',
  '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
  '  <Settings><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>',
  '  <Actions Context="Author"><Exec><Command>{python}</Command><Arguments>tools/report.py</Arguments></Exec></Actions>',
  '</Task>',
  '',
].join('\n');

const INI = '[Video]\r\nMSAA 1\r\nMSAAQuality 0\r\n';

// ------------------------------------------------------------------ fixture profile

function integProfile(cfgFile) {
  const root = tmpdir('cc-integ-');
  const dir = path.join(root, 'profile');
  fs.cpSync(MIN, dir, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  pj.modules.push('integ');
  pj.presets.recommended = ['floors', 'session', 'integ'];
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const item = (id, order, contributes) => ({ id, order, title: id, does: 'Integration item ' + id + '.', why: 'Proves the real adapter.', risk: 'high', default: 'on', platform: ['win32'], depends_on: [], pairs_with: [], conflicts_with: [], contributes });
  const mod = {
    schema: 1, id: 'integ', order: 3, title: 'Integration', summary: 'Real adapters.', why: 'INTEGRATE-1.', default: 'on',
    items: [
      item('env-plain', 301, [{ kind: 'env', name: 'KIT_SUITE_SLOTS', value: ENV_VALUE }]),
      item('env-secret', 302, [{ kind: 'env', name: 'CC_INTEG_TOKEN', secret: 'integ-token' }]),
      item('task-real', 303, [{ kind: 'task', name: 'ClaudeProfile-Integ', template: 'templates/task.xml' }]),
      item('app-cfg', 304, [{ kind: 'app-config', target: { file: cfgFile, key: 'Video.MSAA' }, to: '4', format: 'ini', processes: ['Game.exe'] }]),
    ],
  };
  w(path.join(dir, 'modules', 'integ', 'module.json'), JSON.stringify(mod, null, 2) + '\n');
  w(path.join(dir, 'modules', 'integ', 'templates', 'task.xml'), TASK_XML);
  return { root, dir };
}

function setup() {
  const base = tmpdir('cc-integ-os-');
  const cfgFile = path.join(base, 'game', 'GraphicsOptions.txt');
  w(cfgFile, INI);
  const prof = integProfile(cfgFile);
  const repo = path.join(base, 'repo');
  const configDir = path.join(base, 'config');
  const dataDir = path.join(base, 'data');
  const scratch = path.join(base, 'scratch');
  const bin = path.join(base, 'bin');
  for (const d of [repo, configDir, dataDir, scratch, bin]) fs.mkdirSync(d, { recursive: true });
  const reg = fakeRegistry({ KIT_SUITE_SLOTS: { value: '8', kind: 'ExpandString' } });
  const sched = fakeScheduler();
  const running = new Set();
  const secrets = SEC.createSecretStore({ dataDir, platform: 'win32', runner: fakeSecretRunner(), recycle: async (p) => { fs.renameSync(p, path.join(bin, path.basename(p))); return true; } });
  let n = 0;
  const deps = {
    env: ENV.createAdapter({ platform: 'win32', runnerSync: reg.runner, secrets, tmpDir: scratch }),
    tasks: TASKS.createAdapter({ platform: 'win32', runnerSync: sched.runner, tmpDir: scratch }),
    appConfig: AC.createAdapter({ platform: 'win32', isRunning: async (names) => names.filter((x) => running.has(x)), now: () => Date.UTC(2026, 9, 18, 15) }),
    git: (() => { const m = new Map(); return { m, get: (r, k) => (m.has(k) ? m.get(k) : null), set: (r, k, v) => m.set(k, v), unset: (r, k) => m.delete(k) }; })(),
    recycle: async (p) => { fs.renameSync(p, path.join(bin, (n++) + '-' + path.basename(p))); return true; },
  };
  const model = P.loadProfile(prof.dir);
  assert.ok(model.ok, JSON.stringify(model.errors));
  return { base, cfgFile, repo, configDir, dataDir, scratch, reg, sched, running, secrets, deps, model, target: { repo, configDir }, values: { repo_code: 'AB', python: 'C:\\Python\\python.exe' } };
}

const planOf = (e) => PL.plan({ model: e.model, selection: P.readSelection(e.dataDir, e.model), dataDir: e.dataDir, target: e.target, values: e.values, deps: e.deps });
const ACKS = ['env-plain', 'env-secret', 'task-real', 'app-cfg'];
const CONSENT = { mode: 'per-task', tasks: { 'ClaudeProfile-Integ': true } };

function allFiles(d) {
  const out = [];
  const rec = (x) => { for (const e of fs.readdirSync(x, { withFileTypes: true })) { const p = path.join(x, e.name); if (e.isDirectory()) rec(p); else out.push(p); } };
  rec(d);
  return out;
}

// ------------------------------------------------------------------ tests

test('engine apply + revert through the real env, secret, task and app-config adapters', async () => {
  const e = setup();
  const put = await e.secrets.put('integ-token', SECRET_VALUE, { apply: true, txDir: path.join(e.dataDir, 'secret-tx') });
  assert.strictEqual(put.status, 'applied', put.reason);
  const cfgBefore = fs.readFileSync(e.cfgFile);

  const p = planOf(e);
  const rows = Object.fromEntries(p.rows.filter((r) => ACKS.includes(r.item)).map((r) => [r.item, r.status]));
  assert.deepStrictEqual(rows, { 'env-plain': 'differs', 'env-secret': 'new', 'task-real': 'new', 'app-cfg': 'differs' }, JSON.stringify(p.rows));

  e.running.add('Game.exe');
  assert.match((await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ACKS })).line, /ClaudeProfile-Integ needs its own consent/);
  const refused = await TX.applyPlan(p, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ACKS, taskConsent: CONSENT });
  assert.strictEqual(refused.ok, false, 'a running owner process refuses the app-config step');
  assert.ok(/Game\.exe is running/.test(refused.line || JSON.stringify(refused)), JSON.stringify(refused));
  assert.strictEqual(e.reg.reg.get('KIT_SUITE_SLOTS').value, '8', 'the earlier env write was rolled back');
  assert.strictEqual(e.reg.reg.has('CC_INTEG_TOKEN'), false);
  assert.strictEqual(e.sched.tasks.size, 0, 'the task registered before the failure was removed again');
  assert.deepStrictEqual(fs.readFileSync(e.cfgFile), cfgBefore);
  e.running.clear();

  const res = await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ACKS, taskConsent: CONSENT });
  assert.strictEqual(res.ok, true, res.line);
  assert.deepStrictEqual(e.reg.reg.get('KIT_SUITE_SLOTS'), { value: ENV_VALUE, kind: 'String' });
  assert.deepStrictEqual(e.reg.reg.get('CC_INTEG_TOKEN'), { value: SECRET_VALUE, kind: 'String' });
  const task = e.sched.tasks.get('\\ClaudeProfile-Integ');
  assert.ok(task && task.includes('<Command>C:\\Python\\python.exe</Command>'), 'task registered from the rendered template');
  assert.strictEqual(fs.readFileSync(e.cfgFile, 'latin1'), INI.replace('MSAA 1', 'MSAA 4'), 'only the value bytes changed, CRLF kept');
  assert.ok(fs.existsSync(e.cfgFile + '.bak-2026-10-18'), 'backup beside the app file');

  // No plaintext value in argv, child env, the journal or any pre-image.
  for (const c of e.reg.calls) {
    assert.ok(!c.argv.includes(ENV_VALUE) && !c.argv.includes(SECRET_VALUE));
    assert.ok(!c.env.includes(ENV_VALUE) && !c.env.includes(SECRET_VALUE));
  }
  const txd = path.join(e.dataDir, 'profile', 'tx', res.tx);
  for (const f of allFiles(txd)) {
    const t = fs.readFileSync(f, 'latin1');
    assert.ok(!t.includes(ENV_VALUE) && !t.includes(SECRET_VALUE) && !t.includes('ExpandString' + '8'), path.relative(txd, f));
    if (/\.env\.json$/.test(f)) assert.ok(!t.includes('"8"'), 'the prior env value is DPAPI-protected in pre/');
  }
  assert.deepStrictEqual(fs.readdirSync(e.scratch), [], 'scratch DPAPI / XML hand-over files are gone');

  const again = planOf(e);
  const st = Object.fromEntries(again.rows.filter((r) => ACKS.includes(r.item)).map((r) => [r.item, r.status]));
  assert.strictEqual(st['env-plain'], 'same');
  assert.strictEqual(st['app-cfg'], 'same');
  assert.strictEqual(st['env-secret'], 'same', 'L3x fix a: a secret mirror re-plans same');
  assert.strictEqual(st['task-real'], 'same', 'L3x fix a: a task re-plans same');

  const done = await TX.revertTx(e.dataDir, 'last', { deps: e.deps, confirm: true });
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.deepStrictEqual(done.flagged, []);
  assert.deepStrictEqual(e.reg.reg.get('KIT_SUITE_SLOTS'), { value: '8', kind: 'ExpandString' }, 'prior value AND kind restored');
  assert.strictEqual(e.reg.reg.has('CC_INTEG_TOKEN'), false, 'a variable that was absent is removed');
  assert.strictEqual(e.sched.tasks.size, 0);
  assert.deepStrictEqual(fs.readFileSync(e.cfgFile), cfgBefore, 'app config byte-identical');
});

test('engine adapters: recover.js shapes (kill-switch {dpapi} restore, task disable / enable) and refusals', async () => {
  const e = setup();
  const env = e.deps.env;
  const snap = env.snapshot('KIT_SUITE_SLOTS');
  assert.ok(snap.dpapi && !JSON.stringify(snap).includes('"8"'));
  env.unset('KIT_SUITE_SLOTS');
  assert.strictEqual(env.get('KIT_SUITE_SLOTS').present, false);
  env.restore('CLAUDE_HEADLESS_BASE_URL', { dpapi: protect('http://127.0.0.1:8787') });
  assert.deepStrictEqual(e.reg.reg.get('CLAUDE_HEADLESS_BASE_URL'), { value: 'http://127.0.0.1:8787', kind: 'String' });
  env.restore('KIT_SUITE_SLOTS', snap);
  assert.deepStrictEqual(e.reg.reg.get('KIT_SUITE_SLOTS'), { value: '8', kind: 'ExpandString' });
  assert.deepStrictEqual(env.snapshot('NOT_SET_X'), { absent: true });
  assert.throws(() => env.set('BAD name', { value: '1' }), /bad variable name|upper case/);
  assert.throws(() => env.set('KIT_X', { value: 'sk-' + 'a'.repeat(20) }), /looks like a key/);
  assert.throws(() => env.set('KIT_X', { secret: 'missing-one' }), /not set/);
  assert.throws(() => env.restore('KIT_X', { token: 'x' }), /unsupported snapshot/);

  const t = e.deps.tasks;
  assert.deepStrictEqual(t.get('ClaudeProfile-Integ'), { present: false });
  assert.strictEqual(t.exportXml('ClaudeProfile-Integ'), null);
  const xml = TASK_XML.replace('{python}', 'C:\\Python\\python.exe');
  t.register('ClaudeProfile-Integ', xml);
  assert.strictEqual(t.get('ClaudeProfile-Integ').enabled, true);
  t.setEnabled('ClaudeProfile-Integ', false);
  assert.strictEqual(t.get('ClaudeProfile-Integ').enabled, false);
  t.setEnabled('ClaudeProfile-Integ', true);
  assert.strictEqual(t.get('ClaudeProfile-Integ').enabled, true);
  t.register('ClaudeProfile-Integ', xml.replace('report.py', 'report2.py'));
  assert.ok(e.sched.calls.some((c) => /^\/Create .* \/F$/.test(c)), 'a replace uses /F');
  assert.throws(() => t.register('Other-Task', xml), /ClaudeProfile-/);
  assert.throws(() => t.register('ClaudeProfile-Elev', xml.replace('LeastPrivilege', 'HighestAvailable')), /least privilege/);
  assert.throws(() => t.register('ClaudeProfile-Two', xml.replace('</Exec>', '</Exec><Exec><Command>x.exe</Command></Exec>')), /exactly one program/);
  t.remove('ClaudeProfile-Integ');
  assert.strictEqual(e.sched.tasks.size, 0);

  const off = ENV.createAdapter({ platform: 'linux', runnerSync: () => { throw new Error('never runs'); } });
  assert.throws(() => off.get('KIT_X'), /Windows only/);
  const offApp = AC.createAdapter({ platform: 'linux' });
  assert.strictEqual(offApp.plan({ kind: 'app-config', target: { file: e.cfgFile, key: 'Video.MSAA' }, to: '4' }, {}).status, 'skipped');
});

test('defaultAdapters wires each L4 / L9 module createAdapter (no OS call at wiring time)', () => {
  const d = TX.defaultAdapters({ dataDir: tmpdir('cc-integ-d-') });
  for (const k of ['env', 'tasks', 'appConfig']) assert.strictEqual(typeof d[k].get === 'function' || typeof d[k].plan === 'function', true, k);
  assert.deepStrictEqual(Object.keys(d.env).sort(), ['get', 'platform', 'restore', 'set', 'snapshot', 'unset']);
  assert.deepStrictEqual(Object.keys(d.tasks).sort(), ['exportXml', 'get', 'register', 'remove', 'setEnabled']);
  assert.deepStrictEqual(Object.keys(d.appConfig).sort(), ['apply', 'plan', 'revert']);
});
