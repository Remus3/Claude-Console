'use strict';
// CON-013 L3x engine fixes from integration:
//  (a) re-plan is idempotent: a secret env item compares by reference / sha256 (never a
//      value), and a scheduled task compares semantically (normalised fields), not by
//      the raw XML bytes Windows hands back from /Query /XML;
//  (b) per-task consent is restored: the custom path names each task, the preset path
//      gives ONE grouped yes/no that lists every task; both land in the journal, and the
//      high-risk ack alone never stands in for it.
// Only the OS edge is faked (env.ps1, secret.ps1, schtasks.exe answered in memory).
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
const cli = require('../installer/cli');

const MIN = path.join(__dirname, 'fixtures', 'profile-min');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const ALL = ['win32'];

const protect = (s) => 'FAKEDPAPI:' + Buffer.from(s, 'utf8').toString('base64') + ':' + crypto.randomBytes(4).toString('hex');
const unprotect = (t) => Buffer.from(String(t).trim().split(':')[1], 'base64').toString('utf8');

function fakeRegistry() {
  const reg = new Map();
  const state = (n) => (reg.has(n) ? { present: true, kind: reg.get(n).kind, sha256: sha(Buffer.from(reg.get(n).value, 'utf8')), length: reg.get(n).value.length } : { present: false });
  const runner = (file, args, opts) => {
    const e = opts.env;
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
  return { reg, runner };
}

function fakeSecretRunner() {
  return async (file, args, opts) => {
    const e = opts.env;
    const f = e.CC_SECRET_FILE;
    if (e.CC_SECRET_OP === 'put') { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, protect(String(opts.input))); }
    else if (!fs.existsSync(f)) return { code: 0, stdout: '{"ok":false}\n', stderr: '' };
    const v = unprotect(fs.readFileSync(f, 'utf8'));
    return { code: 0, stdout: JSON.stringify({ ok: true, length: v.length, sha256: sha(Buffer.from(v, 'utf8')) }) + '\n', stderr: '' };
  };
}

// What Windows does to a registered task: /Query /XML returns a re-serialised document
// (UTF-16 declaration, CRLF, RegistrationInfo added, defaults spelled out, elements
// re-ordered and re-indented, StartBoundary unchanged).
function windowsExport(xml) {
  const pick = (re) => (re.exec(xml) || [])[0] || '';
  const triggers = pick(/<Triggers>[\s\S]*?<\/Triggers>/);
  const principals = pick(/<Principals>[\s\S]*?<\/Principals>/);
  const actions = pick(/<Actions[\s\S]*?<\/Actions>/);
  const settings = pick(/<Settings>[\s\S]*?<\/Settings>/).replace('<Settings>', '<Settings>\r\n    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>\r\n    <StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>\r\n    <Priority>7</Priority>');
  return ['<?xml version="1.0" encoding="UTF-16"?>', '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>', '    <URI>\\ClaudeProfile-Replan</URI>', '  </RegistrationInfo>',
    '  ' + principals.replace(/></g, '>\r\n      <'), '  ' + settings, '  ' + triggers.replace(/></g, '>\r\n    <'), '  ' + actions.replace(/></g, '>\r\n      <'), '</Task>', ''].join('\r\n');
}

function fakeScheduler() {
  const tasks = new Map();
  const runner = (file, args) => {
    const tn = args[args.indexOf('/TN') + 1];
    if (args[0] === '/Query' && args.includes('/XML')) return tasks.has(tn) ? { code: 0, stdout: tasks.get(tn), stderr: '' } : { code: 1, stdout: '', stderr: 'ERROR: not found' };
    if (args[0] === '/Query') return { code: 0, stdout: [...tasks.keys()].map((k) => '"' + k + '","N/A","Ready"').join('\r\n'), stderr: '' };
    if (args[0] === '/Create') {
      const b = fs.readFileSync(args[args.indexOf('/XML') + 1]);
      tasks.set(tn, windowsExport(b.slice(2).toString('utf16le')));
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (args[0] === '/Delete') { tasks.delete(tn); return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    if (args[0] === '/Change') { tasks.set(tn, tasks.get(tn).replace(/<Enabled>(true|false)<\/Enabled>/, '<Enabled>' + args.includes('/ENABLE') + '</Enabled>')); return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    return { code: 1, stdout: '', stderr: 'unexpected' };
  };
  return { tasks, runner };
}

const TASK_XML = [
  '<?xml version="1.0" encoding="UTF-16"?>',
  '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
  '  <Triggers><CalendarTrigger><StartBoundary>2026-10-18T04:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>',
  '  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
  '  <Settings><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>',
  '  <Actions Context="Author"><Exec><Command>{python}</Command><Arguments>tools/report.py</Arguments></Exec></Actions>',
  '</Task>', '',
].join('\n');

function profileWith(items, presetModules) {
  const dir = path.join(tmpdir('cc-replan-p-'), 'profile');
  fs.cpSync(MIN, dir, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8'));
  pj.modules.push('mach');
  pj.presets.recommended = presetModules || ['floors', 'session', 'mach'];
  w(path.join(dir, 'profile.json'), JSON.stringify(pj, null, 2) + '\n');
  const mod = { schema: 1, id: 'mach', order: 3, title: 'Machine', summary: 'Machine items.', why: 'Re-plan tests.', default: 'on', items };
  w(path.join(dir, 'modules', 'mach', 'module.json'), JSON.stringify(mod, null, 2) + '\n');
  w(path.join(dir, 'modules', 'mach', 'templates', 'task.xml'), TASK_XML);
  w(path.join(dir, 'modules', 'mach', 'templates', 'task2.xml'), TASK_XML.replace('report.py', 'other.py'));
  return dir;
}
const item = (id, order, contributes, extra) => Object.assign({ id, order, title: id, does: 'Does ' + id + '.', why: 'Because ' + id + '.', risk: 'high', default: 'on', platform: ALL, depends_on: [], pairs_with: [], conflicts_with: [], contributes }, extra || {});

function setup(items) {
  const base = tmpdir('cc-replan-');
  const repo = path.join(base, 'repo');
  const dataDir = path.join(base, 'data');
  const scratch = path.join(base, 'scratch');
  for (const d of [repo, dataDir, scratch]) fs.mkdirSync(d, { recursive: true });
  const reg = fakeRegistry();
  const sched = fakeScheduler();
  const secrets = SEC.createSecretStore({ dataDir, platform: 'win32', runner: fakeSecretRunner(), recycle: async (p) => { fs.renameSync(p, p + '.binned'); return true; } });
  const deps = {
    env: ENV.createAdapter({ platform: 'win32', runnerSync: reg.runner, secrets, tmpDir: scratch }),
    tasks: TASKS.createAdapter({ platform: 'win32', runnerSync: sched.runner, tmpDir: scratch }),
    git: (() => { const m = new Map(); return { get: (r, k) => (m.has(k) ? m.get(k) : null), set: (r, k, v) => m.set(k, v), unset: (r, k) => m.delete(k) }; })(),
    recycle: async (p) => { fs.renameSync(p, p + '.binned'); return true; },
  };
  const profileDir = profileWith(items);
  const model = P.loadProfile(profileDir);
  assert.ok(model.ok, JSON.stringify(model.errors));
  return { base, repo, dataDir, reg, sched, secrets, deps, model, profileDir, values: { repo_code: 'AB', python: 'C:\\Python\\python.exe' } };
}
const planOf = (e) => PL.plan({ model: e.model, selection: P.readSelection(e.dataDir, e.model), dataDir: e.dataDir, target: { repo: e.repo, configDir: null }, values: e.values, deps: e.deps, platform: 'win32' });
const statusOf = (p, id) => p.rows.filter((r) => r.item === id).map((r) => r.status);

// ------------------------------------------------------------------ (a) idempotent re-plan

test('re-plan: a secret env item is same after apply; a re-stored secret makes it differ', async () => {
  const e = setup([item('env-secret', 301, [{ kind: 'env', name: 'CC_REPLAN_TOKEN', secret: 'replan-token' }])]);
  assert.strictEqual((await e.secrets.put('replan-token', 'tok-value-1', { apply: true, txDir: path.join(e.dataDir, 'stx') })).status, 'applied');
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['new']);
  const res = await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['env-secret'] });
  assert.strictEqual(res.ok, true, res.line);
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['same'], 'idempotent after apply');
  const lock = JSON.parse(fs.readFileSync(PL.userLockFile(e.dataDir), 'utf8'));
  assert.strictEqual(lock.env.CC_REPLAN_TOKEN.secret, 'replan-token', 'the lock records the reference');
  assert.ok(!JSON.stringify(lock).includes('tok-value-1'), 'never the value');
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['same']);
  // The user stores a new value: the mirror is stale, so the plan says differs.
  assert.strictEqual((await e.secrets.put('replan-token', 'tok-value-2', { apply: true, txDir: path.join(e.dataDir, 'stx2') })).status, 'applied');
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['differs']);
  // Someone else changes the variable: differs too.
  const res2 = await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['env-secret'] });
  assert.strictEqual(res2.ok, true, res2.line);
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['same']);
  e.reg.reg.set('CC_REPLAN_TOKEN', { value: 'hand-edited', kind: 'String' });
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['differs']);
});

test('re-plan: an adapter that reports secretRef or secretSha compares by reference / sha256', () => {
  const e = setup([item('env-secret', 301, [{ kind: 'env', name: 'CC_REPLAN_TOKEN', secret: 'replan-token' }])]);
  e.deps.env = { get: () => ({ present: true, sha256: 'aa', secretRef: 'replan-token' }) };
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['same']);
  e.deps.env = { get: () => ({ present: true, sha256: 'bb', secretRef: 'other' }) };
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['differs']);
  e.deps.env = { get: () => ({ present: true, sha256: 'cc' }), secretSha: (ref) => (ref === 'replan-token' ? 'cc' : null) };
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['same']);
  e.deps.env = { get: () => ({ present: true, sha256: 'dd' }), secretSha: () => 'cc' };
  assert.deepStrictEqual(statusOf(planOf(e), 'env-secret'), ['differs']);
});

test('re-plan: a scheduled task compares semantically, not by the XML bytes Windows returns', async () => {
  const e = setup([item('task-a', 301, [{ kind: 'task', name: 'ClaudeProfile-Replan', template: 'templates/task.xml' }])]);
  const res = await TX.applyPlan(planOf(e), { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['task-a'], taskConsent: { mode: 'per-task', tasks: { 'ClaudeProfile-Replan': true } } });
  assert.strictEqual(res.ok, true, res.line);
  const stored = e.sched.tasks.get('\\ClaudeProfile-Replan');
  assert.ok(/RegistrationInfo/.test(stored) && /\r\n/.test(stored), 'the fake re-serialises like Windows');
  assert.deepStrictEqual(statusOf(planOf(e), 'task-a'), ['same'], 'idempotent after apply');
  e.deps.tasks.setEnabled('ClaudeProfile-Replan', false);
  assert.deepStrictEqual(statusOf(planOf(e), 'task-a'), ['differs'], 'a disabled task differs');
  e.deps.tasks.setEnabled('ClaudeProfile-Replan', true);
  e.sched.tasks.set('\\ClaudeProfile-Replan', stored.replace('tools/report.py', 'tools/other.py'));
  assert.deepStrictEqual(statusOf(planOf(e), 'task-a'), ['differs'], 'changed arguments differ');
});

test('taskSemantics: whitespace, CRLF, BOM, element order and spelled-out defaults are equal; real fields are not', () => {
  const x = TASK_XML.replace('{python}', 'C:\\Python\\python.exe');
  assert.ok(PL.taskSame(x, '\uFEFF' + windowsExport(x)));
  assert.ok(PL.taskSame(x, x.replace('<Command>C:\\Python\\python.exe</Command>', '<Command>"c:/python/python.exe"</Command>')), 'exe case, quotes and slashes');
  assert.ok(!PL.taskSame(x, x.replace('04:00', '05:00')), 'trigger time');
  assert.ok(!PL.taskSame(x, x.replace('PT10M', 'PT20M')), 'runtime cap');
  assert.ok(!PL.taskSame(x, x.replace('<Hidden>true</Hidden>', '<Hidden>false</Hidden>')), 'hidden');
  assert.ok(!PL.taskSame(x, x.replace('<DaysInterval>1</DaysInterval>', '<DaysInterval>2</DaysInterval>')), 'days interval');
  assert.ok(!PL.taskSame(x, x.replace('CalendarTrigger', 'LogonTrigger').replace('CalendarTrigger', 'LogonTrigger')), 'trigger kind');
  assert.ok(PL.taskSame('<Task>x</Task>', '<Task>x</Task>\n'), 'unparsable XML falls back to normalised text');
});

// ------------------------------------------------------------------ (b) per-task consent

test('consent: custom path needs one consent per task; the high-risk ack alone is refused; select-all is refused', async () => {
  const e = setup([
    item('task-a', 301, [{ kind: 'task', name: 'ClaudeProfile-A', template: 'templates/task.xml' }]),
    item('task-b', 302, [{ kind: 'task', name: 'ClaudeProfile-B', template: 'templates/task2.xml' }]),
  ]);
  const p = planOf(e);
  assert.deepStrictEqual(TX.tasksNeedingConsent(p).map((t) => [t.name, t.item, t.status]), [['ClaudeProfile-A', 'task-a', 'new'], ['ClaudeProfile-B', 'task-b', 'new']]);
  const base = { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, acks: ['task-a', 'task-b'] };
  let r = await TX.applyPlan(p, base);
  assert.strictEqual(r.ok, false);
  assert.match(r.line, /refused: scheduled task ClaudeProfile-A needs its own consent/);
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'per-task', tasks: { 'ClaudeProfile-A': true } } }));
  assert.match(r.line, /ClaudeProfile-B needs its own consent/);
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'per-task', tasks: { '*': true } } }));
  assert.match(r.line, /no select-all/);
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: true }));
  assert.match(r.line, /needs its own consent/);
  assert.strictEqual(e.sched.tasks.size, 0, 'nothing registered by a refused plan');
  assert.ok(!fs.existsSync(path.join(e.dataDir, 'profile', 'tx')), 'no transaction opened');
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'per-task', tasks: { 'ClaudeProfile-A': true, 'ClaudeProfile-B': true } } }));
  assert.strictEqual(r.ok, true, r.line);
  const j = TX.readJournal(e.dataDir, r.tx);
  const c = j.find((x) => x.op === 'consent');
  assert.deepStrictEqual({ kind: c.kind, mode: c.mode, tasks: c.tasks }, { kind: 'tasks', mode: 'per-task', tasks: ['ClaudeProfile-A', 'ClaudeProfile-B'] });
  assert.strictEqual(c.seq, 0, 'recorded before any write');
  const rv = await TX.revertTx(e.dataDir, 'last', { deps: e.deps });
  assert.ok(!rv.entries.some((x) => x.op === 'consent'), 'a consent record is not a change to undo');
  const done = await TX.revertTx(e.dataDir, 'last', { deps: e.deps, confirm: true });
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.strictEqual(e.sched.tasks.size, 0);
});

test('consent: the preset path takes ONE grouped yes/no that must list every task; recorded in the journal', async () => {
  const e = setup([
    item('task-a', 301, [{ kind: 'task', name: 'ClaudeProfile-A', template: 'templates/task.xml' }]),
    item('task-b', 302, [{ kind: 'task', name: 'ClaudeProfile-B', template: 'templates/task2.xml' }]),
  ]);
  const p = planOf(e);
  const base = { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, groupedConsent: true };
  let r = await TX.applyPlan(p, base);
  assert.match(r.line, /one grouped consent that lists every scheduled task/, 'grouped high-risk consent alone does not consent to tasks');
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'grouped', yes: true, listed: ['ClaudeProfile-A'] } }));
  assert.match(r.line, /did not list ClaudeProfile-B/);
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'grouped', yes: false, listed: ['ClaudeProfile-A', 'ClaudeProfile-B'] } }));
  assert.match(r.line, /answered no/);
  r = await TX.applyPlan(p, Object.assign({}, base, { taskConsent: { mode: 'grouped', yes: true, listed: ['ClaudeProfile-A', 'ClaudeProfile-B'] } }));
  assert.strictEqual(r.ok, true, r.line);
  const c = TX.readJournal(e.dataDir, r.tx).find((x) => x.op === 'consent');
  assert.deepStrictEqual({ mode: c.mode, tasks: c.tasks, yes: c.yes }, { mode: 'grouped', tasks: ['ClaudeProfile-A', 'ClaudeProfile-B'], yes: true });
  // A plan with no task needs no task consent.
  const again = planOf(e);
  assert.deepStrictEqual(TX.tasksNeedingConsent(again), []);
  assert.strictEqual((await TX.applyPlan(again, { model: e.model, dataDir: e.dataDir, deps: e.deps, confirm: true, groupedConsent: true })).ok, true);
});

test('cli: --consent-task per task (custom) and --preset --grouped-consent (lists every task)', async () => {
  const e = setup([
    item('task-a', 301, [{ kind: 'task', name: 'ClaudeProfile-A', template: 'templates/task.xml' }]),
    item('task-b', 302, [{ kind: 'task', name: 'ClaudeProfile-B', template: 'templates/task2.xml' }]),
  ]);
  const lines = [];
  const deps = Object.assign({}, e.deps, { out: (s) => lines.push(s), profileDir: e.profileDir, dataDir: e.dataDir, configDir: path.join(e.base, 'cfg'), platform: 'win32' });
  const run = async (args) => { lines.length = 0; const code = await cli.run(['profile'].concat(args, ['--home', path.join(e.base, 'home')]), deps); return { code, text: lines.join('\n') }; };
  const common = ['--target', 'repo:' + e.repo, '--var', 'repo_code=AB', '--var', 'python=py'];
  let x = await run(['apply'].concat(common));
  assert.match(x.text, /scheduled tasks need consent: ClaudeProfile-A, ClaudeProfile-B/);
  assert.match(x.text, /--consent-task ClaudeProfile-A --consent-task ClaudeProfile-B/);
  x = await run(['apply'].concat(common, ['--apply', '--yes', '--ack', 'task-a,task-b']));
  assert.strictEqual(x.code, 1);
  assert.match(x.text, /ClaudeProfile-A needs its own consent/);
  x = await run(['apply'].concat(common, ['--apply', '--yes', '--ack', 'task-a,task-b', '--consent-task', 'ClaudeProfile-A', '--consent-task', 'ClaudeProfile-B']));
  assert.strictEqual(x.code, 0, x.text);
  assert.strictEqual(e.sched.tasks.size, 2);
  x = await run(['revert', '--last', '--apply', '--yes']);
  assert.strictEqual(x.code, 0, x.text);
  x = await run(['apply'].concat(common, ['--preset', 'recommended', '--grouped-consent', '--apply', '--yes']));
  assert.strictEqual(x.code, 0, x.text);
  assert.match(x.text, /scheduled tasks \(one grouped consent\): ClaudeProfile-A, ClaudeProfile-B/);
  const txs = TX.listTx(e.dataDir);
  const c = TX.readJournal(e.dataDir, txs[txs.length - 1].id).find((y) => y.op === 'consent');
  assert.strictEqual(c.mode, 'grouped');
});
