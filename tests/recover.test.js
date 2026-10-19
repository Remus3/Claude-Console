'use strict';
// CON-013 L3 (addendum e.1, e.3): stop everything / resume, the browser recovery prompt,
// the standalone recover.ps1 (parse-checked with Windows PowerShell 5.1 and read
// statically - never run here), and the network policy hooks. Every process, task and
// env effect is a fake; nothing outside the scratch dirs is touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');
const R = require('../installer/recover');
const egress = require('../installer/egress');
const release = require('../installer/release');
const cli = require('../installer/cli');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PS1 = path.join(__dirname, '..', 'installer', 'recover.ps1');

function world() {
  const root = tmpdir('cc-rec-');
  const dataDir = path.join(root, 'data');
  const runDir = path.join(root, 'run');
  const configDir = path.join(root, 'config');
  const repo = path.join(root, 'repo');
  // A profile-managed repo settings file with hooks, the user lock with one task.
  const settings = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'python ops/kit/kit_done.py stop-hook' }] }] }, env: { A: '1' } };
  w(path.join(repo, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  w(path.join(repo, '.claude', 'profile.lock.json'), JSON.stringify({ schema: 1, items: ['x'], files: { '.claude/settings.json': { sha: 'x', items: ['x'], hooks: [{ item: 'x', event: 'Stop', matcher: null, entry: { command: 'python ops/kit/kit_done.py stop-hook' } }] } } }));
  w(path.join(dataDir, 'profile', 'targets.json'), JSON.stringify({ schema: 1, repos: [repo] }));
  w(path.join(dataDir, 'profile', 'locks', 'user.json'), JSON.stringify({ schema: 1, items: ['t'], files: {}, tasks: { 'ClaudeProfile-Clean': { item: 't', prior: 'absent' } } }));
  w(path.join(dataDir, 'profile', 'selection.json'), '{ corrupt');
  // Processes: two panes and a headless child recorded; one unrelated process not recorded.
  const procs = new Map([[101, { alive: true, name: 'node.exe', startMs: 1000 }], [102, { alive: true, name: 'claude.exe', startMs: 2000 }], [103, { alive: true, name: 'python.exe', startMs: 3000 }], [999, { alive: true, name: 'notepad.exe', startMs: 50 }], [104, { alive: true, name: 'other.exe', startMs: 9 }]]);
  R.registerSpawn(runDir, { pid: 101, kind: 'pane', name: 'node.exe', startMs: 1000 });
  R.registerSpawn(runDir, { pid: 102, kind: 'pane', name: 'claude.exe', startMs: 2000 });
  R.registerSpawn(runDir, { pid: 103, kind: 'headless', name: 'python.exe', startMs: 3000 });
  R.registerSpawn(runDir, { pid: 104, kind: 'pane', name: 'node.exe', startMs: 4000 }); // pid reused by another program
  const killed = [];
  const tasks = new Map([['ClaudeProfile-Clean', { enabled: true, xml: '<Task/>' }], ['UserOwnTask', { enabled: true, xml: '<T/>' }]]);
  const envm = new Map([['CLAUDE_HEADLESS_BASE_URL', 'http://127.0.0.1:9']]);
  const deps = {
    procInfo: async (pid) => (procs.has(pid) ? Object.assign({}, procs.get(pid)) : { alive: false }),
    killTree: async (pid) => { killed.push(pid); procs.get(pid).alive = false; return true; },
    tasks: { get: (n) => (tasks.has(n) ? { present: true, enabled: tasks.get(n).enabled } : { present: false }), exportXml: (n) => (tasks.has(n) ? tasks.get(n).xml : null), setEnabled: (n, on) => { tasks.get(n).enabled = on; } },
    env: { get: (n) => (envm.has(n) ? { present: true } : { present: false }), unset: (n) => envm.delete(n), snapshot: (n) => ({ token: Buffer.from(envm.get(n)).toString('base64') }), restore: (n, s) => envm.set(n, Buffer.from(s.token, 'base64').toString()) },
  };
  return { root, dataDir, runDir, configDir, repo, deps, procs, killed, tasks, envm, settingsText: r(path.join(repo, '.claude', 'settings.json')) };
}

test('stop-all: dry run first; then only recorded, matching console processes; tasks disabled not deleted; hooks off; kill switch unset', async () => {
  const x = world();
  const dry = await R.stopAll({ dataDir: x.dataDir, runDir: x.runDir, configDir: x.configDir, deps: x.deps });
  assert.ok(dry.dryRun);
  assert.match(dry.line, /stop 4 console process tree\(s\), disable 1 profile task\(s\), turn profile hooks off \(1 settings file\(s\)\), unset CLAUDE_HEADLESS_BASE_URL - confirm/);
  assert.deepStrictEqual(x.killed, []);
  const res = await R.stopAll({ dataDir: x.dataDir, runDir: x.runDir, configDir: x.configDir, deps: x.deps, confirm: true });
  assert.ok(res.ok, res.line);
  assert.deepStrictEqual(x.killed.sort(), [101, 102, 103]);
  assert.ok(x.procs.get(999).alive, 'an unrelated process survives');
  assert.ok(x.procs.get(104).alive, 'a reused pid is never killed');
  assert.strictEqual(res.record.processes.find((p) => p.pid === 104).result, 'skipped: pid now belongs to another process');
  assert.strictEqual(x.tasks.get('ClaudeProfile-Clean').enabled, false);
  assert.ok(x.tasks.has('ClaudeProfile-Clean'), 'disabled, not deleted');
  assert.strictEqual(x.tasks.get('UserOwnTask').enabled, true, 'a task the profile did not add is untouched');
  assert.ok(fs.existsSync(R.markerFile(x.dataDir)));
  const s = JSON.parse(r(path.join(x.repo, '.claude', 'settings.json')));
  assert.deepStrictEqual(Object.keys(s), ['model', 'hooks.profile-disabled', 'env'], 'key renamed in place');
  assert.ok(!x.envm.has('CLAUDE_HEADLESS_BASE_URL'));
  assert.ok(fs.existsSync(path.join(x.dataDir, 'profile', 'stop-all', res.id + '.json')));
  assert.ok(!r(path.join(x.dataDir, 'profile', 'stop-all', res.id + '.json')).includes('127.0.0.1:9'), 'the kill-switch value never in the record');
  // Idempotent: a second run finds nothing more to do.
  const again = await R.stopAll({ dataDir: x.dataDir, runDir: x.runDir, configDir: x.configDir, deps: x.deps, confirm: true });
  assert.deepStrictEqual([again.record.tasks.length, again.record.hooks.files.length, again.record.hooks.marker, again.record.killSwitch], [0, 0, false, null]);
  // Resume replays the first record (the newest not-resumed one is the empty second; resume by id).
  const rs = await R.resume({ dataDir: x.dataDir, id: res.id, deps: x.deps });
  assert.ok(rs.dryRun);
  const done = await R.resume({ dataDir: x.dataDir, id: res.id, deps: x.deps, confirm: true });
  assert.ok(done.ok, done.line);
  assert.match(done.line, /3 process\(es\) not restarted/);
  assert.strictEqual(r(path.join(x.repo, '.claude', 'settings.json')), x.settingsText, 'byte-identical settings');
  assert.ok(!fs.existsSync(R.markerFile(x.dataDir)));
  assert.strictEqual(x.tasks.get('ClaudeProfile-Clean').enabled, true);
  assert.strictEqual(x.envm.get('CLAUDE_HEADLESS_BASE_URL'), 'http://127.0.0.1:9');
  assert.match((await R.resume({ dataDir: x.dataDir, id: res.id, deps: x.deps, confirm: true })).line, /already resumed/);
});

test('resume after the user edited a disabled settings file renames the key back, keeping the edit', async () => {
  const x = world();
  const res = await R.stopAll({ dataDir: x.dataDir, runDir: x.runDir, configDir: x.configDir, deps: x.deps, confirm: true });
  const f = path.join(x.repo, '.claude', 'settings.json');
  const s = JSON.parse(r(f));
  s.theme = 'dark';
  w(f, JSON.stringify(s, null, 2) + '\n');
  assert.ok((await R.resume({ dataDir: x.dataDir, id: res.id, deps: x.deps, confirm: true })).ok);
  const back = JSON.parse(r(f));
  assert.strictEqual(back.theme, 'dark');
  assert.ok(back.hooks && !('hooks.profile-disabled' in back));
});

test('recovery is error-proof: no data dir = nothing to stop or resume', async () => {
  const root = tmpdir('cc-rec0-');
  const none = path.join(root, 'missing');
  assert.match((await R.stopAll({ dataDir: none, runDir: none, confirm: true })).line, /nothing to stop/);
  assert.match((await R.resume({ dataDir: none, confirm: true })).line, /nothing to resume/);
  assert.ok(R.recoverPrompt({ dataDir: none, runDir: none }).ok);
});

test('recover prompt: self-contained, scrubbed, key names and hooks only, undo steps; actions need confirm', async () => {
  const x = world();
  w(path.join(x.configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-' + 'FAKE0000000000000000' }, statusLine: { type: 'command', command: 'node C:/x/statusline.js' } }));
  w(path.join(x.runDir, 'server.log'), 'ok\nERROR: hook failed for zelda_tester at ' + x.root + '\\thing\n');
  const tx = path.join(x.dataDir, 'profile', 'tx', '20261019-010203-001');
  w(path.join(tx, 'report.json'), JSON.stringify({ ok: true, written: ['repo:CLAUDE.md'] }));
  w(path.join(tx, 'journal.jsonl'), JSON.stringify({ seq: 1, op: 'write', abs: path.join(x.repo, 'CLAUDE.md'), display: 'repo:CLAUDE.md', pre: '1', applied_sha: 'a' }) + '\n' + JSON.stringify({ seq: 1, done: true }) + '\n');
  const p = R.recoverPrompt({ dataDir: x.dataDir, runDir: x.runDir, configDir: x.configDir, version: '0.1.3', problems: ['settings parse failed'], username: 'zelda_tester', hostname: 'ZELDA-PC9' });
  const t = p.text;
  assert.match(t, /## What is wrong\n- settings parse failed\n- log: server\.log: ERROR: hook failed for <USER>/);
  assert.match(t, /- user settings: keys env, statusLine/);
  assert.match(t, /- repo repo: keys model, hooks, env\n  - hook Stop: python kit_done\.py/);
  assert.match(t, /20261019-010203-001: applied, 1 write\(s\)/);
  assert.match(t, /repo:CLAUDE\.md: copy pre\/1 back over it/);
  assert.match(t, /claude-console stop-all --yes/);
  assert.match(t, /recover\.ps1 -Stop -DisableHooks -PauseTasks/);
  for (const needle of ['sk-ant-FAKE', 'zelda_tester', 'ZELDA-PC9', x.root, '127.0.0.1:9']) assert.ok(!t.includes(needle), 'no ' + needle);
  const calls = [];
  assert.strictEqual((await R.promptActions(p, { clipboard: (s) => calls.push(['clip', s]), openUrl: (u) => calls.push(['open', u]) })).ok, false);
  assert.strictEqual(calls.length, 0);
  const ok = await R.promptActions(p, { confirm: true, clipboard: (s) => calls.push(['clip', s]), openUrl: (u) => calls.push(['open', u]) });
  assert.ok(ok.ok);
  assert.deepStrictEqual(calls.map((c) => c[0]), ['clip', 'open']);
  assert.strictEqual(calls[1][1], 'https://claude.ai/new');
});

test('cli stop-all / resume / recover-prompt are two-step', async () => {
  const x = world();
  const lines = [];
  const home = path.join(x.root, 'home');
  fs.mkdirSync(home, { recursive: true });
  // The CLI reads <home>/run; point it at the seeded run dir by seeding there.
  fs.cpSync(x.runDir, path.join(home, 'run'), { recursive: true });
  const deps = Object.assign({ out: (s) => lines.push(s), dataDir: x.dataDir, configDir: x.configDir, noDefaultAdapters: true, clipboard: () => {}, openUrl: () => {} }, x.deps);
  let code = await cli.run(['stop-all', '--home', home], deps);
  assert.strictEqual(code, 0);
  assert.match(lines.pop(), /confirm to go ahead/);
  assert.deepStrictEqual(x.killed, []);
  code = await cli.run(['stop-all', '--yes', '--home', home], deps);
  assert.strictEqual(code, 0, lines.join('\n'));
  assert.match(lines.pop(), /^stopped 3 process tree\(s\), disabled 1 task\(s\), hooks off/);
  code = await cli.run(['resume', '--yes', '--home', home], deps);
  assert.strictEqual(code, 0, lines.join('\n'));
  assert.match(lines.pop(), /^resumed /);
  code = await cli.run(['recover-prompt', '--home', home], deps);
  assert.strictEqual(code, 0);
  assert.match(lines[lines.length - 1], /recover-prompt --yes/);
});

// ------------------------------------------------------------------ recover.ps1 (static only)

test('recover.ps1: parses with Windows PowerShell 5.1; ASCII + LF; standalone and floor-safe', { skip: process.platform !== 'win32' }, () => {
  const ps = "$e=$null;$t=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + PS1.replace(/'/g, "''") + "',[ref]$t,[ref]$e);$e.Count";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' }).trim();
  assert.strictEqual(out, '0', 'no parse errors');
  const b = fs.readFileSync(PS1);
  assert.ok(!b.includes(13), 'LF only');
  assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(b.toString('latin1')), 'ASCII only');
  const t = b.toString('utf8');
  for (const sw of ['Stop', 'DisableHooks', 'PauseTasks', 'Resume', 'Revert', 'Prompt']) assert.match(t, new RegExp('\\[(switch|string)\\]\\$' + sw + '\\b'), '-' + sw);
  assert.match(t, /SupportsShouldProcess = \$true/, '-WhatIf');
  assert.match(t, /taskkill\.exe \/PID \(\[int\]\$rec\.pid\) \/T \/F/, 'kills by recorded pid tree');
  assert.ok(!/Stop-Process|Get-Process\s+-Name|taskkill[^\n]*\/IM/i.test(t), 'never by image name');
  assert.ok(!/Remove-Item/i.test(t), 'no direct delete');
  assert.match(t, /SendToRecycleBin/);
  assert.ok(!/Invoke-WebRequest|Invoke-RestMethod|Net\.WebClient|\birm\b/i.test(t.replace(/^#.*$/gm, '')), 'no network');
  assert.match(t, /Disable-ScheduledTask/);
  assert.ok(!/Unregister-ScheduledTask/.test(t.split('function Invoke-Revert')[0]), 'stop only disables tasks');
  assert.match(t, /'hooks' 'hooks\.profile-disabled'/);
  assert.match(t, /HOOKS_OFF/);
  assert.match(t, /Start-Process 'https:\/\/claude\.ai\/new'/);
  assert.ok(!/node(\.exe)?\s/i.test(t.replace(/^#.*$/gm, '')), 'no Node');
});

// ------------------------------------------------------------------ network policy

test('egress policy: update hosts for the update check, browser hosts only for clicks, loopback for the rest', () => {
  assert.ok(egress.allowed('https://api.github.com/repos/a/b/releases', 'update'));
  assert.ok(egress.allowed('https://objects.githubusercontent.com/x', 'update'));
  assert.ok(!egress.allowed('http://api.github.com/x', 'update'), 'https only');
  assert.ok(!egress.allowed('https://claude.ai/new', 'update'));
  assert.ok(egress.allowed('https://claude.ai/new', 'browser'));
  assert.ok(!egress.allowed('https://example.com/', 'browser'));
  assert.ok(egress.allowed('http://127.0.0.1:7800/api', 'loopback'));
  assert.ok(!egress.allowed('http://10.' + '0.0.5/', 'loopback'));
  assert.throws(() => egress.check('https://evil.example/x', 'update'), /egress refused: evil\.example/);
  const last = egress.log().pop();
  assert.deepStrictEqual([last.host, last.kind, last.allowed], ['evil.example', 'update', false]);
  assert.ok(!('path' in last) && !('url' in last), 'no path or query logged');
  const p = egress.policy();
  // The public build strips the Main-only integrations (console_export.py EXCLUDE); there,
  // and only there, their baseline rows name files that are not shipped.
  const stripped = new Set(['server/hom.js', 'server/homctl.js', 'server/localmode.js']);
  // they go together: all three absent = the public build
  const publicBuild = [...stripped].every((f) => !fs.existsSync(path.join(__dirname, '..', f)));
  assert.deepStrictEqual(p.files.filter((f) => !fs.existsSync(path.join(__dirname, '..', f.file)) && !(publicBuild && stripped.has(f.file))).map((f) => f.file), [], 'every baseline file exists');
  assert.ok(p.files.some((f) => f.file === 'installer/release.js' && f.class === 'update'));
});

test('egress log file: one line per attempt, host only', () => {
  const f = path.join(tmpdir('cc-egr-'), 'egress.log');
  egress.setLog(f);
  try { egress.note('https://api.github.com/repos/x/y/releases?token=zz', 'update'); } finally { egress.setLog(null); }
  const line = JSON.parse(r(f).trim());
  assert.deepStrictEqual([line.host, line.kind, line.allowed], ['api.github.com', 'update', true]);
  assert.ok(!r(f).includes('token'));
});

test('release.js routes the update check through the policy (refused host never fetched)', async () => {
  let fetched = 0;
  const cacheFile = path.join(tmpdir('cc-egr-'), 'releases.json');
  const ok = await release.checkReleases({ settings: { check: true, repo: 'Remus3/claude-console', channel: 'stable' }, cacheFile, fetch: async () => { fetched++; return { status: 200, json: async () => [], headers: { get: () => null } }; } });
  assert.strictEqual(ok.checked, true);
  assert.strictEqual(fetched, 1);
  assert.ok(egress.log().some((e) => e.host === 'api.github.com' && e.kind === 'update' && e.allowed));
});

test('runtime guard: loopback passes, anything else is recorded and refused, restore() undoes it', async () => {
  const http = require('http');
  const g = egress.installGuard({});
  try {
    assert.throws(() => http.request('http://198.51.100.7/x'), /egress refused by the test guard: request 198\.51\.100\.7/);
    await assert.rejects(async () => globalThis.fetch('https://example.org/'), /egress refused/);
    const srv = http.createServer((q, s) => s.end('ok'));
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    const port = srv.address().port;
    const body = await new Promise((res, rej) => http.get({ hostname: '127.0.0.1', port, path: '/' }, (s) => { let d = ''; s.on('data', (c) => { d += c; }); s.on('end', () => res(d)); }).on('error', rej));
    srv.close();
    assert.strictEqual(body, 'ok');
    assert.deepStrictEqual(g.attempts.map((a) => [a.via, a.host, a.allowed]), [['request', '198.51.100.7', false], ['fetch', 'example.org', false], ['get', '127.0.0.1', true]]);
  } finally { g.restore(); }
  assert.ok(!/guarded/.test(http.request.name));
});

test('static scan finds network-capable code', () => {
  const hits = egress.scanText("const h = require('https');\nfetch('https://x.example/a');\n$r = Invoke-WebRequest $u\n");
  assert.deepStrictEqual(hits.map((h) => h.kind + ':' + h.match), ['module:https', 'fetch:fetch(', 'url:https://x.example', 'ps-web:Invoke-WebRequest']);
});
