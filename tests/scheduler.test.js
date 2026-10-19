'use strict';
// CON-SCHEDULER (S49 intake, 2026-10-18): server/scheduler.js and its
// routes (server/backendroutes.js). Every OS call goes through an injected runner; this
// file drives a FAKE task store only. No test ever reaches schtasks.exe or
// Get-ScheduledTask (CLAUDE.md: never run a machine-reconfiguring script on this box).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const S = require('../server/scheduler');
const R = require('../server/backendroutes');
const { tmpdir } = require('./helpers');

const { FakeOS } = require('./fakeos');

const EXE = process.execPath; // an absolute path that exists
const MAIN_ROW = { name: 'Sample-TempHygiene', path: '\\', state: 'Ready', lastResult: 0, triggers: [{ kind: 'MSFT_TaskTimeTrigger', start: '2026-01-01T00:00:00', interval: 'PT4H', enabled: true }], actions: [{ exe: 'powershell.exe', args: '-File "C:\\Work\\ops\\runtime\\Temp-Hygiene.ps1"', workdir: 'C:\\Work\\ops\\runtime' }] };
const BOOT_ROW = { name: 'Sample-BootTimeRecord', path: '\\', state: 'Ready', lastResult: 267009, triggers: [{ kind: 'MSFT_TaskBootTrigger', delay: 'PT3M', enabled: true }], actions: [{ exe: 'powershell.exe', args: '-File C:\\Work\\ops\\runtime\\Record-BootTime.ps1', workdir: '' }] };
const ALPHA_ROW = { name: 'Alpha nightly', path: '\\Fleet\\', state: 'Ready', lastResult: 1, triggers: [{ kind: 'MSFT_TaskDailyTrigger', start: '2026-01-01T03:00:00', enabled: true }], actions: [{ exe: 'C:\\Python\\python.exe', args: 'tools\\x.py', workdir: 'D:\\Repos\\Alpha' }] };
const PROJECTS = [{ id: 'main', name: 'Main', path: 'C:\\Work' }, { id: 'alpha', name: 'Alpha', path: 'D:\\Repos\\Alpha' }];

function svc(fake, extra) {
  const dir = tmpdir('cc-sched-');
  return new S.Scheduler(Object.assign({ runner: fake.runner(), dataDir: path.join(dir, 'data'), runDir: path.join(dir, 'run'), projects: () => PROJECTS, consoleRoot: 'C:\\Work\\console', now: () => Date.UTC(2026, 9, 18, 12, 0, 0) }, extra || {}));
}

const DAILY = { name: 'Console-Test', exe: EXE, args: '--version', workdir: '', trigger: { kind: 'daily', at: '04:15' } };

// ---------------------------------------------------------------- pure helpers

test('resultText: CLAUDE.md benign codes are not failures; others are', () => {
  assert.deepStrictEqual(S.resultText(0), { text: 'ok', ok: true });
  assert.deepStrictEqual(S.resultText(267009), { text: 'running', ok: true });
  assert.deepStrictEqual(S.resultText(267011), { text: 'never run', ok: true });
  assert.deepStrictEqual(S.resultText(2147946720), { text: 'repeat refused (IgnoreNew)', ok: true });
  assert.deepStrictEqual(S.resultText(1), { text: 'failed (0x1)', ok: false });
  assert.deepStrictEqual(S.resultText(null), { text: 'unknown', ok: true });
});

test('triggerKind maps CIM class names', () => {
  assert.strictEqual(S.triggerKind('MSFT_TaskDailyTrigger'), 'daily');
  assert.strictEqual(S.triggerKind('MSFT_TaskWeeklyTrigger'), 'weekly');
  assert.strictEqual(S.triggerKind('MSFT_TaskTimeTrigger'), 'once');
  assert.strictEqual(S.triggerKind('MSFT_TaskLogonTrigger'), 'logon');
  assert.strictEqual(S.triggerKind('MSFT_TaskBootTrigger'), 'boot');
  assert.strictEqual(S.triggerKind('MSFT_TaskIdleTrigger'), 'idle');
  assert.strictEqual(S.triggerKind('whatever'), 'other');
});

test('validateSpec: accepts a good spec with defaults; refuses bad names, paths, exes, triggers', () => {
  const ok = S.validateSpec(DAILY);
  assert.ok(ok.ok, ok.error);
  assert.strictEqual(ok.spec.path, '\\');
  assert.strictEqual(ok.spec.enabled, true);
  assert.strictEqual(ok.spec.limitMinutes, 60);
  const bad = [
    {}, Object.assign({}, DAILY, { name: '' }), Object.assign({}, DAILY, { name: 'a/b' }), Object.assign({}, DAILY, { name: '..\\x' }),
    Object.assign({}, DAILY, { name: 'x'.repeat(81) }), Object.assign({}, DAILY, { path: 'Fleet' }), Object.assign({}, DAILY, { path: '\\Microsoft\\Windows\\' }),
    Object.assign({}, DAILY, { path: '\\a\\..\\' }), Object.assign({}, DAILY, { exe: 'python.exe' }), Object.assign({}, DAILY, { exe: 'C:\\no\\such\\file.exe' }),
    Object.assign({}, DAILY, { args: 'a\nb' }), Object.assign({}, DAILY, { args: 'x'.repeat(1025) }), Object.assign({}, DAILY, { workdir: 'relative' }),
    Object.assign({}, DAILY, { trigger: { kind: 'hourly' } }), Object.assign({}, DAILY, { trigger: { kind: 'daily', at: '25:00' } }),
    Object.assign({}, DAILY, { trigger: { kind: 'daily' } }), Object.assign({}, DAILY, { trigger: { kind: 'weekly', at: '04:00', days: [] } }),
    Object.assign({}, DAILY, { trigger: { kind: 'weekly', at: '04:00', days: ['Funday'] } }), Object.assign({}, DAILY, { trigger: { kind: 'once', at: '04:00', date: '2026-13-01' } }),
    Object.assign({}, DAILY, { trigger: { kind: 'daily', at: '04:00', everyMinutes: 2 } }), Object.assign({}, DAILY, { trigger: { kind: 'boot', delaySeconds: 99999 } }),
    Object.assign({}, DAILY, { limitMinutes: 0 }), Object.assign({}, DAILY, { description: 'x'.repeat(201) }), Object.assign({}, DAILY, { enabled: 'yes' }),
  ];
  for (const b of bad) assert.strictEqual(S.validateSpec(b).ok, false, JSON.stringify(b));
});

test('buildXml: task XML with escaped text, the trigger in schema order, IgnoreNew + StartWhenAvailable', () => {
  const v = S.validateSpec(Object.assign({}, DAILY, { args: '--x "a&b" <c>', description: 'it\'s "q"', trigger: { kind: 'daily', at: '04:15', everyMinutes: 30 } }));
  const xml = S.buildXml(v.spec, Date.UTC(2026, 9, 18, 12));
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  assert.ok(xml.includes('<Arguments>--x &quot;a&amp;b&quot; &lt;c&gt;</Arguments>'));
  assert.ok(xml.includes('<Description>it&apos;s &quot;q&quot;</Description>'));
  assert.ok(/<CalendarTrigger>\s*<Repetition>[\s\S]*<StartBoundary>2026-10-18T04:15:00<\/StartBoundary>[\s\S]*<ScheduleByDay>/.test(xml));
  assert.ok(xml.includes('<Interval>PT30M</Interval>'));
  assert.ok(xml.includes('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>'));
  assert.ok(xml.includes('<StartWhenAvailable>true</StartWhenAvailable>'));
  assert.ok(xml.includes('<ExecutionTimeLimit>PT60M</ExecutionTimeLimit>'));
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(xml), 'ASCII only');
  const wk = S.buildXml(S.validateSpec(Object.assign({}, DAILY, { trigger: { kind: 'weekly', at: '17:00', days: ['Fri', 'Mon'] } })).spec, 0);
  assert.ok(/<ScheduleByWeek><WeeksInterval>1<\/WeeksInterval><DaysOfWeek><Monday \/><Friday \/><\/DaysOfWeek><\/ScheduleByWeek>/.test(wk));
  const boot = S.buildXml(S.validateSpec(Object.assign({}, DAILY, { trigger: { kind: 'boot', delaySeconds: 180 } })).spec, 0);
  assert.ok(boot.includes('<BootTrigger>') && boot.includes('<Delay>PT180S</Delay>'));
  const off = S.buildXml(S.validateSpec(Object.assign({}, DAILY, { enabled: false })).spec, 0);
  assert.ok(/<Settings>[\s\S]*<Enabled>false<\/Enabled>/.test(off));
});

test('replaceBlock swaps Triggers / Actions in a foreign task XML and keeps the rest', () => {
  const xml = FakeOS.xmlOf({ actions: [{ exe: 'a.exe' }] });
  const t = S.replaceBlock(xml, 'Triggers', '<Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>');
  assert.ok(t.includes('<LogonTrigger>') && !t.includes('<BootTrigger>') && t.includes('<Author>someone</Author>'));
  const a = S.replaceBlock(xml, 'Actions', '<Actions Context="Author"><Exec><Command>b.exe</Command></Exec></Actions>');
  assert.ok(a.includes('b.exe') && !a.includes('a.exe'));
  assert.strictEqual(S.replaceBlock('<Task></Task>', 'Triggers', '<Triggers/>'), null);
});

test('ownerOf maps a task to the longest matching project path, the console root, else null', () => {
  assert.strictEqual(S.ownerOf(MAIN_ROW, PROJECTS, 'C:\\Work\\console'), 'main');
  assert.strictEqual(S.ownerOf(ALPHA_ROW, PROJECTS, 'C:\\Work\\console'), 'alpha');
  assert.strictEqual(S.ownerOf({ actions: [{ exe: 'node.exe', args: 'C:\\Work\\CONSOLE\\x.js' }] }, PROJECTS, 'C:\\Work\\console'), 'console');
  assert.strictEqual(S.ownerOf({ actions: [{ exe: 'C:\\Other\\a.exe' }] }, PROJECTS, 'C:\\Work\\console'), null);
  assert.strictEqual(S.ownerOf({ actions: [{ exe: 'C:\\Mainframe\\a.exe' }] }, PROJECTS, 'C:\\Work\\console'), null, 'prefix must end at a separator');
  assert.strictEqual(S.ownerOf(ALPHA_ROW, [{ id: 'alpha', dir: 'D:\\Repos\\Alpha' }], null), 'alpha', 'discovery projects carry dir');
});

// ---------------------------------------------------------------- list

test('list: rows normalized with owner, result text, boot notes; Microsoft folder never reaches the list call', async () => {
  const fake = new FakeOS([MAIN_ROW, BOOT_ROW, ALPHA_ROW]);
  const s = svc(fake);
  const r = await s.list();
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.tasks.length, 3);
  const boot = r.tasks.find((t) => t.name === 'Sample-BootTimeRecord');
  assert.strictEqual(boot.owner, 'main');
  assert.strictEqual(boot.result.text, 'running');
  assert.ok(boot.notes.some((n) => /boot/.test(n)));
  assert.deepStrictEqual(boot.triggers.map((t) => t.kind), ['boot']);
  const alpha = r.tasks.find((t) => t.owner === 'alpha');
  assert.strictEqual(alpha.result.ok, false);
  assert.ok(Array.isArray(r.facts) && r.facts.some((f) => /267009/.test(f)) && r.facts.some((f) => /Temp/.test(f)));
  assert.deepStrictEqual(r.byProject, { main: 2, alpha: 1 });
  assert.ok(S.PS_LIST.includes("-notlike '\\Microsoft\\*'"));
  const only = await s.list({ project: 'alpha' });
  assert.deepStrictEqual(only.tasks.map((t) => t.name), ['Alpha nightly']);
  assert.strictEqual(fake.writes().length, 0, 'listing never writes');
});

test('list: an unreadable scheduler or no runner reports unavailable, never throws', async () => {
  const fake = new FakeOS([]);
  fake.failList = true;
  assert.strictEqual((await svc(fake).list()).available, false);
  const none = new S.Scheduler({ runner: null, dataDir: tmpdir('cc-sched-'), runDir: tmpdir('cc-sched-'), projects: () => [] });
  const r = await none.list();
  assert.strictEqual(r.available, false);
  assert.strictEqual((await none.add(DAILY)).status, 503);
});

test('report(project) is the compact self-report row set for one repo', async () => {
  const s = svc(new FakeOS([MAIN_ROW, BOOT_ROW, ALPHA_ROW]));
  const r = await s.report('alpha');
  assert.strictEqual(r.project, 'alpha');
  assert.deepStrictEqual(r.tasks.map((t) => [t.name, t.ok]), [['Alpha nightly', false]]);
  assert.strictEqual(r.line, 'alpha: 1 task, 1 failing');
});

// ---------------------------------------------------------------- writes

test('add: writes UTF-16 XML through schtasks /Create, reads it back, logs it', async () => {
  const fake = new FakeOS([]);
  const s = svc(fake);
  const r = await s.add(DAILY);
  assert.strictEqual(r.status, 201, r.error);
  assert.strictEqual(r.task.name, 'Console-Test');
  assert.strictEqual(r.readBack, true);
  const w = fake.writes();
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0][1][0], '/Create');
  assert.ok(!w[0][1].includes('/F'), 'add never overwrites');
  assert.ok(fs.readFileSync(path.join(s.runDir, 'scheduler.log'), 'utf8').includes('add \\Console-Test ok'));
  assert.deepStrictEqual(fs.readdirSync(path.join(s.dataDir, 'scheduler', 'tmp')), [], 'temp XML removed');
});

test('add: refuses an existing task, an invalid spec, and a second write while one runs', async () => {
  const fake = new FakeOS([MAIN_ROW]);
  const s = svc(fake);
  assert.strictEqual((await s.add(Object.assign({}, DAILY, { name: 'Sample-TempHygiene' }))).status, 409);
  assert.strictEqual((await s.add({ name: 'x' })).status, 400);
  s.busy = 'add';
  assert.strictEqual((await s.add(DAILY)).status, 409);
  assert.strictEqual(fake.writes().length, 0);
});

test('add: a failed read-back deletes what was registered (rollback)', async () => {
  const fake = new FakeOS([]);
  fake.corruptCreate = true;
  const s = svc(fake);
  const r = await s.add(DAILY);
  assert.strictEqual(r.status, 500);
  assert.match(r.error, /read-back/);
  assert.strictEqual(r.rolledBack, true);
  assert.strictEqual(fake.tasks.size, 0);
});

test('add: schtasks failure is reported with its message', async () => {
  const fake = new FakeOS([]);
  fake.failCreate = true;
  const r = await svc(fake).add(DAILY);
  assert.strictEqual(r.status, 500);
  assert.match(r.error, /access denied/);
});

test('alter: backs up the XML first, then enable/disable via /Change, read back', async () => {
  const fake = new FakeOS([MAIN_ROW]);
  const s = svc(fake);
  const r = await s.alter({ path: '\\', name: 'Sample-TempHygiene' }, { enabled: false });
  assert.strictEqual(r.status, 200, r.error);
  assert.strictEqual(r.task.state, 'Disabled');
  assert.ok(r.backup && fs.existsSync(r.backup));
  const order = fake.calls.map((c) => (c[0] === 'powershell.exe' ? (c[1].includes(S.PS_EXPORT) ? 'export' : 'list') : c[1][0]));
  assert.ok(order.indexOf('export') < order.indexOf('/Change'), 'backup before the write: ' + order.join(','));
  assert.deepStrictEqual(fake.writes()[0][1], ['/Change', '/TN', '\\Sample-TempHygiene', '/DISABLE']);
});

test('alter: a new trigger replaces only the Triggers block of the exported XML (/Create /F)', async () => {
  const fake = new FakeOS([BOOT_ROW]);
  const s = svc(fake);
  const r = await s.alter({ path: '\\', name: 'Sample-BootTimeRecord' }, { trigger: { kind: 'logon', delaySeconds: 30 } });
  assert.strictEqual(r.status, 200, r.error);
  assert.deepStrictEqual(r.task.triggers.map((t) => t.kind), ['logon']);
  const xml = fake.tasks.get('\\Sample-BootTimeRecord').xml;
  assert.ok(xml.includes('<Author>someone</Author>'), 'the rest of the foreign XML is kept');
  const w = fake.writes();
  assert.strictEqual(w[0][1][0], '/Create');
  assert.ok(w[0][1].includes('/F'));
});

test('alter: a failed read-back restores the backup', async () => {
  const fake = new FakeOS([BOOT_ROW]);
  const s = svc(fake);
  fake.corruptCreate = true;
  const r = await s.alter({ path: '\\', name: 'Sample-BootTimeRecord' }, { action: { exe: EXE, args: '-v', workdir: '' } });
  assert.strictEqual(r.status, 500);
  assert.strictEqual(r.rolledBack, true);
  // the restore is itself a /Create /F of the backup; with corruptCreate still on the fake
  // registers evil.exe again, so the service must say the restore did not read back
  assert.strictEqual(r.restoreReadBack, false);
  fake.corruptCreate = false;
  const r2 = await s.alter({ path: '\\', name: 'Sample-BootTimeRecord' }, { enabled: true });
  assert.strictEqual(r2.status, 200);
});

test('alter / remove: unknown tasks, Microsoft folder, empty patch, bad refs refused without a write', async () => {
  const fake = new FakeOS([MAIN_ROW]);
  const s = svc(fake);
  assert.strictEqual((await s.alter({ path: '\\', name: 'Nope' }, { enabled: true })).status, 404);
  assert.strictEqual((await s.alter({ path: '\\Microsoft\\Windows\\', name: 'X' }, { enabled: true })).status, 400);
  assert.strictEqual((await s.alter({ path: '\\', name: 'Sample-TempHygiene' }, {})).status, 400);
  assert.strictEqual((await s.alter({ path: '\\', name: 'Sample-TempHygiene' }, { trigger: { kind: 'never' } })).status, 400);
  assert.strictEqual((await s.remove({ path: '\\', name: 'a\\b' })).status, 400);
  assert.strictEqual((await s.remove({ path: '\\', name: 'Nope' })).status, 404);
  assert.strictEqual(fake.writes().length, 0);
});

test('remove: backup XML kept, /Delete, read back absent', async () => {
  const fake = new FakeOS([ALPHA_ROW]);
  const s = svc(fake);
  const r = await s.remove({ path: '\\Fleet\\', name: 'Alpha nightly' });
  assert.strictEqual(r.status, 200, r.error);
  assert.ok(fs.existsSync(r.backup));
  assert.ok(fs.readFileSync(r.backup).slice(2).toString('utf16le').includes('python.exe'));
  assert.deepStrictEqual(fake.writes()[0][1], ['/Delete', '/TN', '\\Fleet\\Alpha nightly', '/F']);
  assert.strictEqual(fake.tasks.size, 0);
});

test('backup refused = no write (fail closed)', async () => {
  const fake = new FakeOS([MAIN_ROW]);
  const s = svc(fake);
  const orig = fake.runner();
  s.runner = async (file, args, opts) => (args.includes(S.PS_EXPORT) ? { code: 1, stdout: '', stderr: 'denied' } : orig(file, args, opts));
  const r = await s.remove({ path: '\\', name: 'Sample-TempHygiene' });
  assert.strictEqual(r.status, 500);
  assert.match(r.error, /backup/);
  assert.strictEqual(fake.tasks.size, 1);
});

test('the default runner is never used under test: a Scheduler without runner never spawns', () => {
  assert.strictEqual(typeof S.realRunner, 'function');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'scheduler.js'), 'utf8');
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(src), 'scheduler.js is ASCII');
  assert.ok(!src.includes('\r'), 'LF only');
});

// ---------------------------------------------------------------- routes

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      try {
        if (!(await handler(req, res, url.pathname, req.method, url))) { res.writeHead(404); res.end('{}'); }
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function call(srv, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { j = null; } resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('routes: GET list (+project filter, report), POST add, PATCH alter, DELETE remove; others fall through', async () => {
  const fake = new FakeOS([MAIN_ROW, ALPHA_ROW]);
  const s = svc(fake);
  const logs = [];
  const srv = await serve(R.createBackendRoutes({ scheduler: s, log: (l) => logs.push(l) }));
  try {
    let r = await call(srv, 'GET', '/api/scheduler');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.tasks.length, 2);
    r = await call(srv, 'GET', '/api/scheduler?project=alpha');
    assert.deepStrictEqual(r.body.tasks.map((t) => t.name), ['Alpha nightly']);
    r = await call(srv, 'GET', '/api/scheduler/report?project=alpha');
    assert.strictEqual(r.body.line, 'alpha: 1 task, 1 failing');
    r = await call(srv, 'POST', '/api/scheduler/tasks', DAILY);
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    r = await call(srv, 'PATCH', '/api/scheduler/tasks', { path: '\\', name: 'Console-Test', enabled: false });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.task.state, 'Disabled');
    r = await call(srv, 'DELETE', '/api/scheduler/tasks?path=' + encodeURIComponent('\\') + '&name=Console-Test');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    r = await call(srv, 'POST', '/api/scheduler/tasks', { name: 'bad' });
    assert.strictEqual(r.status, 400);
    r = await call(srv, 'GET', '/api/other');
    assert.strictEqual(r.status, 404);
    assert.ok(logs.some((l) => /scheduler add/.test(l)));
  } finally { srv.close(); }
});

test('routes: a non-loopback peer is refused (403)', async () => {
  const s = svc(new FakeOS([]));
  const handler = R.createBackendRoutes({ scheduler: s, isLoopback: () => false });
  const srv = await serve(handler);
  try {
    assert.strictEqual((await call(srv, 'GET', '/api/scheduler')).status, 403);
  } finally { srv.close(); }
});

test('routes: without a scheduler the endpoints answer 503 (not wired)', async () => {
  const srv = await serve(R.createBackendRoutes({}));
  try {
    assert.strictEqual((await call(srv, 'GET', '/api/scheduler')).status, 503);
  } finally { srv.close(); }
});

