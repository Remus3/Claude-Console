'use strict';
// Project tools (child rows under a project in the Projects sidebar): config parsing,
// the shipped config, launching (detached, same program / args / folder as the
// Desktop shortcut) and the token-guarded API.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../server/tools');
const { createConsoleServer } = require('../server/server');
const { makeFixture, writeFile } = require('./helpers');

test('normalizeTools keeps valid entries and drops bad ones with a reason', () => {
  const r = T.normalizeTools([
    { id: 'ok-one', project: 'AL', label: 'One', launch: { file: 'C:/x.exe', args: ['a'], cwd: 'C:/' } },
    { id: 'ok-one', project: 'AL', label: 'Dup', launch: { file: 'C:/x.exe' } },
    { id: 'Bad Id', project: 'AL', label: 'x', launch: { file: 'C:/x.exe' } },
    { id: 'nofile', project: 'AL', label: 'x', launch: {} },
    { id: 'noproj', label: 'x', launch: { file: 'C:/x.exe' } },
    { id: 'badargs', project: 'AL', label: 'x', launch: { file: 'C:/x.exe', args: [1] } },
  ]);
  assert.deepStrictEqual(r.tools.map((t) => t.id), ['ok-one']);
  assert.strictEqual(r.problems.length, 5);
  const o = T.normalizeTools([
    { id: 'page', project: 'AL', label: 'P', launch: { open: 'http://127.0.0.1:1/x', requires: { port: 1, file: 'C:/m.exe' } } },
    { id: 'file', project: 'AL', label: 'F', launch: { open: 'C:/a.html' } },
    { id: 'rel', project: 'AL', label: 'R', launch: { open: 'a.html' } },
    { id: 'badreq', project: 'AL', label: 'B', launch: { open: 'http://x/', requires: { port: 'x', file: 'C:/m.exe' } } },
  ]);
  assert.deepStrictEqual(o.tools.map((t) => t.id), ['page', 'file']);
  assert.deepStrictEqual(o.tools[0].launch, { open: 'http://127.0.0.1:1/x', requires: { port: 1, file: 'C:/m.exe', args: [], cwd: null } });
  assert.deepStrictEqual(r.tools[0].launch, { file: 'C:/x.exe', args: ['a'], cwd: 'C:/' });
  process.env.CC_TOOLS_TEST = 'D:/zz';
  assert.strictEqual(T.expandEnv('%CC_TOOLS_TEST%/a'), 'D:/zz/a');
  assert.strictEqual(T.expandEnv('%CC_NOT_SET_XYZ%/a'), '%CC_NOT_SET_XYZ%/a');
});

test('shipped config/tools.json is valid and puts each tool under its project', () => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'tools.json'), 'utf8'));
  const r = T.normalizeTools(j.tools);
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.tools.length, j.tools.length, 'every shipped tool normalizes');
  for (const t of r.tools) assert.ok(typeof t.project === 'string' && t.project, t.id);
});

test('publicTool matches the project by code, name or id and hides the command line', () => {
  const t = T.normalizeTools([{ id: 'a', project: 'AL', label: 'A', launch: { file: process.execPath, args: ['--secret-arg'] } }]).tools[0];
  const pub = T.publicTool(t, [{ id: 'alpha', name: 'Alpha', code: 'AL' }]);
  assert.deepStrictEqual(pub, { id: 'a', label: 'A', title: '', projectId: 'alpha', available: true, kind: 'run', path: process.execPath });
  assert.ok(!JSON.stringify(pub).includes('secret'));
  assert.strictEqual(T.publicTool(t, []).projectId, null);
});

test('launchTool spawns detached with the configured args and folder; missing program fails', async () => {
  const calls = [];
  const fake = (file, args, opts) => { calls.push({ file, args, opts }); return { pid: 42, unref() {}, on() {} }; };
  // A GUI program (explorer.exe) starts as it is; console programs go through cmd start.
  const gui = require('path').join(process.env.SystemRoot || 'C:/Windows', 'explorer.exe');
  const t = T.normalizeTools([{ id: 'a', project: 'AL', label: 'A', launch: { file: gui, args: ['.'], cwd: __dirname } }]).tools[0];
  assert.deepStrictEqual(await T.launchTool(t, { spawn: fake }), { ok: true, pid: 42 });
  assert.strictEqual(calls[0].file, gui);
  assert.deepStrictEqual(calls[0].args, ['.']);
  assert.strictEqual(calls[0].opts.cwd, __dirname);
  assert.strictEqual(calls[0].opts.detached, true);
  const gone = T.normalizeTools([{ id: 'b', project: 'AL', label: 'B', launch: { file: 'C:/no/such/program.exe' } }]).tools[0];
  const r = await T.launchTool(gone, { spawn: fake });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(calls.length, 1);
});

test('launchTool open: hands the target to explorer; starts the required server first only when its port is closed', async () => {
  const calls = [];
  const fake = (file, args) => { calls.push({ exe: path.basename(file).toLowerCase(), args }); return { unref() {}, on() {} }; };
  const page = T.normalizeTools([{ id: 'p', project: 'AL', label: 'P', launch: { open: 'http://127.0.0.1:65000/review', requires: { port: 65000, file: process.execPath, args: ['srv.js'] } } }]).tools[0];
  let up = false;
  const probe = async () => up;
  const r1 = await T.launchTool(page, { spawn: fake, portOpen: probe, waitMs: 0 });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.started, true);
  assert.deepStrictEqual(calls.map((c) => c.exe), [path.basename(process.execPath).toLowerCase(), 'explorer.exe']);
  assert.deepStrictEqual(calls[1].args, ['http://127.0.0.1:65000/review']);
  calls.length = 0;
  up = true;
  const r2 = await T.launchTool(page, { spawn: fake, portOpen: probe });
  assert.strictEqual(r2.started, false);
  assert.deepStrictEqual(calls.map((c) => c.exe), ['explorer.exe'], 'server already up: only the page opens');
  const file = T.normalizeTools([{ id: 'f', project: 'AL', label: 'F', launch: { open: __filename } }]).tools[0];
  calls.length = 0;
  assert.strictEqual((await T.launchTool(file, { spawn: fake })).ok, true);
  assert.deepStrictEqual(calls[0].args, [path.win32.normalize(__filename)]);
  const gone = T.normalizeTools([{ id: 'g', project: 'AL', label: 'G', launch: { open: 'C:/no/such/page.html' } }]).tools[0];
  assert.strictEqual((await T.launchTool(gone, { spawn: fake })).ok, false);
});

test('tools API: listed per project, launch needs the token, unknown id 404', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const file = path.join(fx.root, 'tools.json');
  writeFile(file, JSON.stringify({ tools: [{ id: 'alpha-gui', project: 'AL', label: 'Alpha gui', launch: { file: process.execPath, args: ['-v'] } }] }));
  const calls = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, toolsFile: file, toolSpawn: (f, a) => { calls.push(a); return { unref() {}, on() {} }; } });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token };
  const list = await (await fetch(base + '/api/tools', { headers: H })).json();
  assert.deepStrictEqual(list.tools, [{ id: 'alpha-gui', label: 'Alpha gui', title: '', projectId: 'alpha', available: true, kind: 'run', path: process.execPath }]);
  assert.strictEqual((await fetch(base + '/api/tools/alpha-gui/launch', { method: 'POST' })).status, 401);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await fetch(base + '/api/tools/alpha-gui/launch', { method: 'POST', headers: H })).status, 200);
  // node.exe is a console program: it gets its own window through cmd start (CON-TOOL-CONSOLE).
  assert.deepStrictEqual(calls, [['/d', '/s', '/c', '"start "" "' + process.execPath + '" -v"']]);
  assert.strictEqual((await fetch(base + '/api/tools/nope/launch', { method: 'POST', headers: H })).status, 404);
});

test('launchTool open: a forward-slash file path reaches explorer with backslashes (else explorer opens Documents)', async () => {
  const calls = [];
  const fake = (file, args) => { calls.push({ exe: path.basename(file).toLowerCase(), args }); return { unref() {}, on() {} }; };
  const fwd = __filename.replace(/\\/g, '/');
  const t = T.normalizeTools([{ id: 'f', project: 'AL', label: 'F', launch: { open: fwd } }]).tools[0];
  assert.strictEqual((await T.launchTool(t, { spawn: fake })).ok, true);
  assert.strictEqual(calls[0].exe, 'explorer.exe');
  assert.deepStrictEqual(calls[0].args, [path.win32.normalize(__filename)]);
  assert.ok(!calls[0].args[0].includes('/'), 'no forward slash reaches explorer.exe');
  calls.length = 0;
  const u = T.normalizeTools([{ id: 'u', project: 'AL', label: 'U', launch: { open: 'http://127.0.0.1:1/a/b' } }]).tools[0];
  await T.launchTool(u, { spawn: fake });
  assert.deepStrictEqual(calls[0].args, ['http://127.0.0.1:1/a/b'], 'a URL is passed unchanged');
});

test('applyOverrides renames, retargets (open or program) and removes entries', () => {
  const list = [
    { id: 'pg', project: 'AL', label: 'Page', launch: { open: 'C:/a.html' } },
    { id: 'pr', project: 'AL', label: 'Prog', launch: { file: 'C:/x.exe', args: ['-a'] } },
    { id: 'gone', project: 'AL', label: 'Gone', launch: { file: 'C:/y.exe' } },
  ];
  const out = T.applyOverrides(list, { pg: { label: ' New page ', path: 'D:/b.html' }, pr: { path: 'D:/z.exe' }, gone: { removed: true }, other: { label: 'x' } });
  assert.deepStrictEqual(out.map((t) => t.id), ['pg', 'pr']);
  assert.strictEqual(out[0].label, 'New page');
  assert.strictEqual(out[0].launch.open, 'D:/b.html');
  assert.strictEqual(out[1].launch.file, 'D:/z.exe');
  assert.deepStrictEqual(out[1].launch.args, ['-a']);
  assert.strictEqual(list[0].launch.open, 'C:/a.html', 'the source entries are not mutated');
  assert.deepStrictEqual(T.applyOverrides(list, null), list);
});

test('validateToolPath: absolute and existing; a page also takes a URL; a program must be a file', () => {
  const pg = { launch: { open: 'C:/a.html' } };
  const pr = { launch: { file: 'C:/x.exe', args: [] } };
  assert.deepStrictEqual(T.validateToolPath(pg, __filename), { ok: true, path: __filename });
  assert.deepStrictEqual(T.validateToolPath(pg, '"' + __filename + '"'), { ok: true, path: __filename }, 'surrounding quotes are stripped');
  assert.strictEqual(T.validateToolPath(pg, __dirname).ok, true, 'a page tool may open a folder');
  assert.strictEqual(T.validateToolPath(pg, 'http://127.0.0.1:9/x').ok, true);
  assert.strictEqual(T.validateToolPath(pr, 'http://127.0.0.1:9/x').ok, false, 'a program is never a URL');
  assert.match(T.validateToolPath(pg, 'relative\\page.html').error, /absolute/);
  assert.match(T.validateToolPath(pg, '\\no-drive\\page.html').error, /absolute/);
  assert.match(T.validateToolPath(pg, '').error, /empty/);
  assert.match(T.validateToolPath(pg, 'C:\\a\u0001b').error, /invalid/);
  assert.match(T.validateToolPath(pg, path.join(__dirname, 'no-such-file.html')).error, /Not found/);
  assert.match(T.validateToolPath(pr, __dirname).error, /must be a file/);
  assert.strictEqual(T.validateToolPath(pr, process.execPath).ok, true);
});

test('tools API: rename, edit path (validated) and remove persist in data/tools.local.json; token and disk untouched', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const file = path.join(fx.root, 'tools.json');
  const page = path.join(fx.root, 'pages', 'page.html');
  const other = path.join(fx.root, 'pages', 'other.html');
  writeFile(page, 'p');
  writeFile(other, 'o');
  writeFile(file, JSON.stringify({ tools: [
    { id: 'alpha-page', project: 'AL', label: 'Alpha page', launch: { open: page.replace(/\\/g, '/') } },
    { id: 'alpha-gui', project: 'AL', label: 'Alpha gui', launch: { file: process.execPath } },
  ] }));
  const before = fs.readFileSync(file, 'utf8');
  writeFile(path.join(fx.dataDir, 'settings.json'), JSON.stringify({ sidebarGroups: [{ id: 'g-1', name: 'G', open: true, items: ['t:alpha-page', 't:alpha-gui'] }] }));
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, toolsFile: file, toolSpawn: () => ({ unref() {}, on() {} }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const req = (m, id, body, h) => fetch(base + '/api/tools/' + id, { method: m, headers: h || H, body: body ? JSON.stringify(body) : undefined });
  const local = () => JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'tools.local.json'), 'utf8'));
  assert.strictEqual((await req('PATCH', 'alpha-page', { label: 'X' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual((await req('DELETE', 'alpha-page', null, { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual((await req('PATCH', 'alpha-page', { label: 'X' }, Object.assign({ Origin: 'http://evil.example' }, H))).status, 403);
  assert.strictEqual((await req('PATCH', 'nope', { label: 'X' })).status, 404);
  assert.ok(!fs.existsSync(path.join(fx.dataDir, 'tools.local.json')), 'refused calls write nothing');
  let r = await req('PATCH', 'alpha-page', { label: '  Renamed   page ' });
  assert.strictEqual(r.status, 200);
  let j = await r.json();
  assert.strictEqual(j.tools.find((x) => x.id === 'alpha-page').label, 'Renamed page');
  assert.deepStrictEqual(local().overrides, { 'alpha-page': { label: 'Renamed page' } });
  assert.strictEqual((await req('PATCH', 'alpha-page', { label: '' })).status, 400);
  r = await req('PATCH', 'alpha-page', { path: 'pages\\other.html' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /absolute/);
  r = await req('PATCH', 'alpha-page', { path: path.join(fx.root, 'pages', 'missing.html') });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /Not found/);
  r = await req('PATCH', 'alpha-gui', { path: fx.root });
  assert.strictEqual(r.status, 400, 'a program path must be a file');
  r = await req('PATCH', 'alpha-page', { path: other });
  assert.strictEqual(r.status, 200);
  j = await r.json();
  assert.strictEqual(j.tools.find((x) => x.id === 'alpha-page').path, other);
  assert.deepStrictEqual(local().overrides['alpha-page'], { label: 'Renamed page', path: other });
  const list = await (await fetch(base + '/api/tools', { headers: H })).json();
  assert.strictEqual(list.tools.find((x) => x.id === 'alpha-page').path, other, 'a reload keeps the edit');
  r = await req('DELETE', 'alpha-page');
  assert.strictEqual(r.status, 200);
  j = await r.json();
  assert.deepStrictEqual(j.tools.map((x) => x.id), ['alpha-gui']);
  assert.strictEqual(local().overrides['alpha-page'].removed, true);
  const s = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'settings.json'), 'utf8'));
  assert.deepStrictEqual(s.sidebarGroups[0].items, ['t:alpha-gui'], 'the removed tool leaves its group');
  assert.strictEqual((await req('DELETE', 'alpha-page')).status, 404);
  assert.strictEqual((await fetch(base + '/api/tools/alpha-page/launch', { method: 'POST', headers: H })).status, 404);
  assert.ok(fs.existsSync(page) && fs.existsSync(other), 'files on disk are never touched');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the shipped tools.json is never written');
});
