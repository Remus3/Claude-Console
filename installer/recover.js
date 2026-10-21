'use strict';
// Recovery (CON-013 L3, addendum e.3): stop everything, resume, and the browser recovery
// prompt. The standalone recover.ps1 beside this file does the same with the console down.
//
// stopAll() - two-step in every UI (the caller asks; this needs confirm === true):
//   1. kills console-spawned processes only: the records in <run>/spawned/<pid>.json
//      (panes' pty trees, headless children), by recorded pid and its whole tree, and
//      only when the live process still matches the record (image name + start time);
//      never by image name (lsn-kill-by-pid);
//   2. disables (never deletes) every scheduled task the profile added (user lock), XML
//      exported first;
//   3. profile hooks off: the marker <dataDir>/profile/HOOKS_OFF (every profile hook
//      exits 0 silently while it exists), and "hooks" renamed "hooks.profile-disabled" in
//      each settings.json the profile manages hooks in (pre-image kept);
//   4. the headless kill-switch variable unset (snapshot through the env adapter).
//   It writes <dataDir>/profile/stop-all/<stamp>.json (+ <stamp>/ backups). resume()
//   replays that record in reverse with read-back. Idempotent; a corrupt selection.json
//   does not matter (it reads the locks); a missing dataDir is "nothing to stop".
// recoverPrompt() builds one scrubbed, self-contained text for claude.ai: what is wrong,
// the environment, config key names + hooks list (values masked), the last transactions
// and the exact undo steps. promptActions() copies it and opens https://claude.ai/new.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { readJson, exists } = require('./fsutil');
const { stamp } = require('./paths');
const { scrub } = require('./contribute');

const KILL_SWITCH_VAR = 'CLAUDE_HEADLESS_BASE_URL';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function profileDir(dataDir) { return path.join(dataDir, 'profile'); }
function stopDir(dataDir) { return path.join(profileDir(dataDir), 'stop-all'); }
function markerFile(dataDir) { return path.join(profileDir(dataDir), 'HOOKS_OFF'); }
function spawnedDir(runDir) { return path.join(runDir, 'spawned'); }

// ------------------------------------------------------------------ spawn registry
// The server (L5) records every process it starts for a pane or a headless run here, and
// removes the record when the process exits.

function registerSpawn(runDir, rec) {
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) throw new Error('registerSpawn needs a pid');
  const d = spawnedDir(runDir);
  fs.mkdirSync(d, { recursive: true });
  const r = { pid: rec.pid, kind: rec.kind || 'pane', name: rec.name || null, startMs: rec.startMs || null, at: new Date().toISOString() };
  fs.writeFileSync(path.join(d, rec.pid + '.json'), JSON.stringify(r) + '\n');
  return r;
}
function unregisterSpawn(runDir, pid) { try { fs.unlinkSync(path.join(spawnedDir(runDir), pid + '.json')); } catch (e) { /* gone */ } } // our own record, not user data
function listSpawned(runDir) {
  let names = [];
  try { names = fs.readdirSync(spawnedDir(runDir)).filter((n) => /^\d+\.json$/.test(n)); } catch (e) { return []; }
  return names.map((n) => readJson(path.join(spawnedDir(runDir), n), null)).filter((r) => r && Number.isInteger(r.pid));
}

// Real process probes (tests inject fakes).
function procInfoWindows(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps = '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + (+pid) + '"; if ($p) { [pscustomobject]@{ name = $p.Name; start = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }';
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err || !String(out).trim()) return resolve({ alive: false });
      try { const j = JSON.parse(String(out)); resolve({ alive: true, name: j.name, startMs: j.start }); } catch (e) { resolve({ alive: false }); }
    });
  });
}
function killTreeWindows(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(+pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err));
  });
}

// ------------------------------------------------------------------ what the profile manages

function readTargets(dataDir) {
  const j = readJson(path.join(profileDir(dataDir), 'targets.json'), null);
  return isObj(j) && Array.isArray(j.repos) ? j.repos.filter((r) => typeof r === 'string') : [];
}
function readUserLock(dataDir) { const j = readJson(path.join(profileDir(dataDir), 'locks', 'user.json'), null); return isObj(j) ? j : null; }
function readRepoLock(repo) { const j = readJson(path.join(repo, '.claude', 'profile.lock.json'), null); return isObj(j) ? j : null; }

// Settings files the profile put hooks into: [{abs}].
function managedSettings(dataDir, configDir) {
  const out = [];
  const add = (root, lock) => {
    if (!lock || !isObj(lock.files)) return;
    for (const [rel, e] of Object.entries(lock.files)) if (/settings(\.local)?\.json$/.test(rel) && Array.isArray(e.hooks) && e.hooks.length) out.push(path.join(root, ...rel.split('/')));
  };
  for (const repo of readTargets(dataDir)) add(repo, readRepoLock(repo));
  if (configDir) add(configDir, readUserLock(dataDir));
  // FB-1021: the other accounts' user locks (user-<hash>.json) record their own dir.
  let names = [];
  try { names = fs.readdirSync(path.join(profileDir(dataDir), 'locks')); } catch (e) { names = []; }
  for (const n of names.filter((x) => /^user-[0-9a-f]{12}\.json$/.test(x))) {
    const j = readJson(path.join(profileDir(dataDir), 'locks', n), null);
    if (isObj(j) && typeof j.configDir === 'string' && path.isAbsolute(j.configDir)) add(j.configDir, j);
  }
  return [...new Set(out)];
}

function renameKey(obj, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k === from ? to : k] = v;
  return out;
}

function atomicWrite(file, buf) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

// ------------------------------------------------------------------ stop-all / resume

// o: {dataDir, runDir, configDir, confirm, now, killSwitchVar,
//     deps: {procInfo, killTree, tasks, env}}
async function stopAll(o) {
  o = o || {};
  const deps = o.deps || {};
  const procs = o.runDir ? listSpawned(o.runDir) : [];
  const noData = !o.dataDir || !exists(o.dataDir);
  if (noData && !procs.length) return { ok: true, nothing: true, dryRun: o.confirm !== true, line: 'nothing to stop (no console data)' };
  const ulock = o.dataDir ? readUserLock(o.dataDir) : null;
  const tasks = ulock && isObj(ulock.tasks) ? Object.keys(ulock.tasks) : [];
  const settings = o.dataDir ? managedSettings(o.dataDir, o.configDir) : [];
  const ks = o.killSwitchVar || KILL_SWITCH_VAR;
  if (o.confirm !== true) {
    return { ok: true, dryRun: true, processes: procs.map((p) => ({ pid: p.pid, kind: p.kind })), tasks, settings: settings.length, killSwitch: ks,
      line: 'stop everything would: stop ' + procs.length + ' console process tree(s), disable ' + tasks.length + ' profile task(s), turn profile hooks off (' + settings.length + ' settings file(s)), unset ' + ks + ' - confirm to go ahead' };
  }
  const id = stamp(o.now) + '-' + crypto.randomBytes(2).toString('hex');
  const side = noData ? null : path.join(stopDir(o.dataDir), id);
  if (side) fs.mkdirSync(side, { recursive: true });
  const rec = { schema: 1, id, at: (o.now || new Date()).toISOString(), processes: [], tasks: [], hooks: { marker: false, files: [] }, killSwitch: null, resumed: null };
  const problems = [];
  // 1) processes
  const info = deps.procInfo || procInfoWindows;
  const kill = deps.killTree || killTreeWindows;
  for (const p of procs) {
    const live = await info(p.pid);
    if (!live || !live.alive) { rec.processes.push({ pid: p.pid, kind: p.kind, result: 'not running' }); if (o.runDir) unregisterSpawn(o.runDir, p.pid); continue; }
    const nameOk = !p.name || !live.name || String(p.name).toLowerCase() === String(live.name).toLowerCase();
    const startOk = !p.startMs || !live.startMs || Math.abs(p.startMs - live.startMs) < 2000;
    if (!nameOk || !startOk) { rec.processes.push({ pid: p.pid, kind: p.kind, result: 'skipped: pid now belongs to another process' }); continue; }
    await kill(p.pid);
    const after = await info(p.pid);
    const gone = !after || !after.alive;
    rec.processes.push({ pid: p.pid, kind: p.kind, result: gone ? 'stopped' : 'still running' });
    if (gone && o.runDir) unregisterSpawn(o.runDir, p.pid);
    if (!gone) problems.push('pid ' + p.pid + ' still running');
  }
  if (noData) {
    const n = rec.processes.filter((p) => p.result === 'stopped').length;
    return { ok: !problems.length, id: null, record: rec, problems, line: 'stopped ' + n + ' process tree(s); no profile data, so no tasks, hooks or kill switch to change' };
  }
  // 2) tasks
  for (const name of tasks) {
    const a = deps.tasks;
    if (!a) { problems.push('task adapter not installed'); break; }
    const g = a.get(name) || {};
    if (!g.present || g.enabled === false) continue;
    const xml = a.exportXml(name);
    const backup = xml ? 'task-' + name + '.xml' : null;
    if (xml) fs.writeFileSync(path.join(side, backup), String(xml));
    a.setEnabled(name, false);
    const ok = (a.get(name) || {}).enabled === false;
    rec.tasks.push({ name, backup, disabled: ok });
    if (!ok) problems.push('task ' + name + ' not disabled');
  }
  // 3) hooks
  const mf = markerFile(o.dataDir);
  if (!exists(mf)) { fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, 'Profile hooks are off (stop everything ' + id + '). Resume removes this file.\n'); rec.hooks.marker = true; }
  let n = 0;
  for (const file of settings) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { continue; }
    let obj;
    try { obj = JSON.parse(buf.toString('utf8')); } catch (e) { problems.push(path.basename(file) + ' unreadable; hooks there not renamed (the marker still holds them off)'); continue; }
    if (!isObj(obj) || !('hooks' in obj) || 'hooks.profile-disabled' in obj) continue;
    const pre = 'settings-' + (n++) + '.json';
    fs.writeFileSync(path.join(side, pre), buf);
    const after = Buffer.from(JSON.stringify(renameKey(obj, 'hooks', 'hooks.profile-disabled'), null, 2) + '\n', 'utf8');
    atomicWrite(file, after);
    rec.hooks.files.push({ file, pre, applied_sha: sha(after) });
  }
  // 4) kill switch
  if (deps.env) {
    const g = deps.env.get(ks) || {};
    if (g.present) {
      const snap = deps.env.snapshot(ks);
      fs.writeFileSync(path.join(side, 'killswitch.json'), JSON.stringify(snap));
      deps.env.unset(ks);
      rec.killSwitch = { name: ks, snap: 'killswitch.json', unset: !(deps.env.get(ks) || {}).present };
      if (!rec.killSwitch.unset) problems.push(ks + ' still set');
    }
  } else problems.push('env adapter not installed: ' + ks + ' left as is');
  fs.writeFileSync(path.join(stopDir(o.dataDir), id + '.json'), JSON.stringify(rec, null, 2) + '\n');
  const stopped = rec.processes.filter((p) => p.result === 'stopped').length;
  return { ok: !problems.length, id, record: rec, problems,
    line: 'stopped ' + stopped + ' process tree(s), disabled ' + rec.tasks.length + ' task(s), hooks off' + (rec.hooks.files.length ? ' (' + rec.hooks.files.length + ' settings file(s))' : '') + (rec.killSwitch ? ', ' + ks + ' unset' : '') + (problems.length ? '; ' + problems.length + ' problem(s): ' + problems[0] : '') };
}

function listStops(dataDir) {
  let names = [];
  try { names = fs.readdirSync(stopDir(dataDir)).filter((n) => /^\d{8}-\d{6}-[0-9a-f]{4}\.json$/.test(n)).sort(); } catch (e) { return []; }
  return names.map((n) => readJson(path.join(stopDir(dataDir), n), null)).filter(Boolean);
}

// o: {dataDir, id (default: the last not-resumed), confirm, deps: {tasks, env}, now}
async function resume(o) {
  o = o || {};
  const deps = o.deps || {};
  if (!o.dataDir || !exists(o.dataDir)) return { ok: true, nothing: true, line: 'nothing to resume' };
  const all = listStops(o.dataDir);
  const rec = o.id ? all.find((r) => r.id === o.id) : all.filter((r) => !r.resumed).pop();
  if (!rec) return { ok: true, nothing: true, line: 'nothing to resume' };
  if (rec.resumed) return { ok: false, line: 'refused: ' + rec.id + ' was already resumed' };
  if (o.confirm !== true) return { ok: true, dryRun: true, id: rec.id, line: 'resume would: re-enable ' + rec.tasks.length + ' task(s), turn hooks back on, restore the kill switch' + (rec.processes.length ? '; ' + rec.processes.filter((p) => p.result === 'stopped').length + ' stopped process(es) are not restarted (open the panes again)' : '') + ' - confirm to go ahead' };
  const side = path.join(stopDir(o.dataDir), rec.id);
  const problems = [];
  if (rec.killSwitch && deps.env) {
    // A record from recover.ps1 holds a DPAPI string; the env adapter restores {dpapi}.
    const raw = () => fs.readFileSync(path.join(side, rec.killSwitch.snap), 'utf8');
    try { deps.env.restore(rec.killSwitch.name, rec.killSwitch.format === 'dpapi' ? { dpapi: raw().trim() } : JSON.parse(raw())); if (!(deps.env.get(rec.killSwitch.name) || {}).present) problems.push(rec.killSwitch.name + ' not restored'); }
    catch (e) { problems.push(rec.killSwitch.name + ': ' + e.message); }
  }
  for (const f of rec.hooks.files) {
    let buf;
    try { buf = fs.readFileSync(f.file); } catch (e) { problems.push(path.basename(f.file) + ' missing'); continue; }
    if (sha(buf) === f.applied_sha) { atomicWrite(f.file, fs.readFileSync(path.join(side, f.pre))); continue; }
    let obj;
    try { obj = JSON.parse(buf.toString('utf8')); } catch (e) { problems.push(path.basename(f.file) + ' unreadable'); continue; }
    if (isObj(obj) && 'hooks.profile-disabled' in obj && !('hooks' in obj)) atomicWrite(f.file, Buffer.from(JSON.stringify(renameKey(obj, 'hooks.profile-disabled', 'hooks'), null, 2) + '\n', 'utf8'));
  }
  if (rec.hooks.marker) { try { fs.unlinkSync(markerFile(o.dataDir)); } catch (e) { /* gone */ } } // the marker is ours, never user data
  for (const t of rec.tasks) {
    if (!deps.tasks) { problems.push('task adapter not installed'); break; }
    if (!t.disabled) continue;
    deps.tasks.setEnabled(t.name, true);
    if ((deps.tasks.get(t.name) || {}).enabled !== true) problems.push('task ' + t.name + ' not re-enabled');
  }
  rec.resumed = { at: (o.now || new Date()).toISOString(), ok: !problems.length, problems };
  fs.writeFileSync(path.join(stopDir(o.dataDir), rec.id + '.json'), JSON.stringify(rec, null, 2) + '\n');
  const notRestarted = rec.processes.filter((p) => p.result === 'stopped').length;
  return { ok: !problems.length, id: rec.id, problems, line: 'resumed ' + rec.id + ': ' + rec.tasks.length + ' task(s) re-enabled, hooks on' + (notRestarted ? '; ' + notRestarted + ' process(es) not restarted (open the panes again)' : '') + (problems.length ? '; problem: ' + problems[0] : '') };
}

// ------------------------------------------------------------------ recovery prompt

function settingsSummary(file) {
  const j = readJson(file, null);
  if (!isObj(j)) return null;
  const hooks = [];
  const h = isObj(j.hooks) ? j.hooks : isObj(j['hooks.profile-disabled']) ? j['hooks.profile-disabled'] : {};
  for (const [ev, groups] of Object.entries(h)) for (const g of Array.isArray(groups) ? groups : []) for (const x of Array.isArray(g.hooks) ? g.hooks : []) {
    const cmd = String((x && x.command) || '').trim().split(/\s+/);
    const exe = path.basename((cmd[0] || '?').replace(/"/g, ''));
    const script = cmd.slice(1).map((a) => a.replace(/"/g, '')).find((a) => /\.(py|js|ps1|sh|cmd)$/i.test(a));
    hooks.push(ev + (g.matcher ? ' [' + g.matcher + ']' : '') + ': ' + exe + (script ? ' ' + path.basename(script) : ''));
  }
  return { keys: Object.keys(j), hooks, disabled: 'hooks.profile-disabled' in j };
}

// o: {dataDir, runDir, configDir, home, installDir, version, problems: [lines], os, node,
//     username, hostname, token}
function recoverPrompt(o) {
  o = o || {};
  const L = [];
  L.push('I need help recovering my Claude Code setup. Claude Console (a local GUI for the Claude Code CLI) and its optional setup profile are installed. Read everything below, tell me the cause you think is most likely, and give me the exact steps. Change nothing until I agree.');
  L.push('');
  L.push('## What is wrong');
  for (const p of o.problems || []) L.push('- ' + p);
  const errs = [];
  if (o.runDir) {
    const { lastLogLines } = require('./crashreport');
    for (const l of lastLogLines(o.runDir, 400)) if (/error|fail|exception|refused|denied/i.test(l)) errs.push(l);
  }
  if (!errs.length && !(o.problems || []).length) L.push('- (no failing check recorded; describe what you see)');
  for (const l of errs.slice(-20)) L.push('- log: ' + l);
  L.push('');
  L.push('## Environment');
  L.push('- console ' + (o.version || '?') + ', ' + (o.os || (os.platform() + ' ' + os.release())) + ', node ' + (o.node || process.version));
  L.push('');
  L.push('## Relevant config (key names and hooks only; values masked)');
  const files = [];
  if (o.configDir) files.push(['user settings', path.join(o.configDir, 'settings.json')]);
  if (o.dataDir) for (const r of readTargets(o.dataDir)) files.push(['repo ' + path.basename(r), path.join(r, '.claude', 'settings.json')]);
  for (const [label, f] of files) {
    const s = settingsSummary(f);
    if (!s) { L.push('- ' + label + ': none or unreadable'); continue; }
    L.push('- ' + label + ': keys ' + (s.keys.join(', ') || '(none)') + (s.disabled ? ' (profile hooks disabled by stop everything)' : ''));
    for (const h of s.hooks) L.push('  - hook ' + h);
  }
  if (o.dataDir && exists(markerFile(o.dataDir))) L.push('- the hooks-off marker is present: profile hooks exit silently');
  L.push('');
  L.push('## Profile transactions (newest last)');
  const txs = [];
  if (o.dataDir) {
    let names = [];
    try { names = fs.readdirSync(path.join(profileDir(o.dataDir), 'tx')).filter((n) => /^\d{8}-\d{6}-\d{3}$/.test(n)).sort(); } catch (e) { /* none */ }
    for (const n of names.slice(-5)) {
      const rep = readJson(path.join(profileDir(o.dataDir), 'tx', n, 'report.json'), null);
      const rev = readJson(path.join(profileDir(o.dataDir), 'tx', n, 'revert.json'), null);
      txs.push(n);
      L.push('- ' + n + ': ' + (rep ? (rep.ok ? 'applied, ' + (rep.written || []).length + ' write(s)' : 'failed and rolled back') : 'no report') + (rev ? ', reverted' : ''));
    }
  }
  if (!txs.length) L.push('- none');
  L.push('');
  L.push('## Undo steps (in this order; each is safe to repeat)');
  L.push('1. Stop everything: `claude-console stop-all --yes` (or, with the console down: `powershell -NoProfile -ExecutionPolicy Bypass -File <install folder>\\recover.ps1 -Stop -DisableHooks -PauseTasks`).');
  L.push('2. Undo the last profile change: `claude-console profile revert --last --apply --yes` (console down: `recover.ps1 -Revert last`).');
  if (txs.length && o.dataDir) {
    const last = txs[txs.length - 1];
    let entries = [];
    try { entries = fs.readFileSync(path.join(profileDir(o.dataDir), 'tx', last, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.op === 'write' && e.display); } catch (e) { /* none */ }
    if (entries.length) {
      L.push('3. By hand, if both fail: for transaction ' + last + ', in the console data folder under profile/tx/' + last + '/pre/:');
      for (const e of entries.slice(0, 20)) L.push('   - ' + e.display + ': ' + (e.pre ? 'copy pre/' + e.pre + ' back over it' : 'created by the profile; move it to the Recycle Bin'));
    }
  }
  L.push('4. Turn hooks back on later with `claude-console resume --yes` (or delete the HOOKS_OFF file in the profile folder and rename "hooks.profile-disabled" back to "hooks").');
  const raw = L.join('\n') + '\n';
  let username = o.username;
  if (username === undefined) { try { username = os.userInfo().username; } catch (e) { username = ''; } }
  const text = scrub(raw, { home: o.home, extra: [o.dataDir, o.runDir, o.installDir, o.configDir].filter(Boolean), username, hostname: o.hostname !== undefined ? o.hostname : os.hostname(), token: o.token,
    machineDir: o.dataDir ? path.join(o.dataDir, 'machine') : null });
  return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8') };
}

// Copies the prompt and opens claude.ai/new (user-initiated). o: {confirm, clipboard, openUrl}
async function promptActions(prompt, o) {
  o = o || {};
  if (o.confirm !== true) return { ok: false, reason: 'preview first; then confirm' };
  const cr = require('./crashreport');
  await (o.clipboard || cr.clipboardDefault)(prompt.text);
  await (o.openUrl || cr.openUrlDefault)('https://claude.ai/new');
  return { ok: true, line: 'copied to the clipboard and opened claude.ai - paste it into the new chat' };
}

module.exports = { stopAll, resume, listStops, recoverPrompt, promptActions, registerSpawn, unregisterSpawn, listSpawned, managedSettings, markerFile, KILL_SWITCH_VAR, procInfoWindows, killTreeWindows };
