'use strict';
// Project tools: the GUIs / dashboards / pages each project owns, listed as child rows
// under that project in the Projects sidebar. Data-driven from config/tools.json
// (data/tools.local.json entries are appended). Each entry starts exactly what its
// Desktop shortcut starts:
//   launch.file + args + cwd   run a program (detached), or
//   launch.open                hand a file or http(s) URL to the shell's default handler.
// launch.requires {port, file, args, cwd}: a local server the page needs; when nothing
// listens on 127.0.0.1:<port>, that program is started first and the port awaited.
// The console only starts these; it never writes into the owning project.
// Operator edits (CON-PROJ-EDIT): data/tools.local.json `overrides` = { <id>: { label,
// path, removed } } renames an entry, points it at another target (launch.open for a
// page / file, launch.file for a program) or hides it. Only the console's own config
// changes; nothing on disk is touched.
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { readJson } = require('./config');

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const URL_RE = /^https?:\/\/[^\s"]+$/i;

function expandEnv(s) {
  return String(s).replace(/%([A-Za-z0-9_()]+)%/g, (m, k) => (process.env[k] !== undefined ? process.env[k] : m));
}

function normRun(l) {
  if (!l || typeof l.file !== 'string' || !l.file) return null;
  if (l.args !== undefined && (!Array.isArray(l.args) || !l.args.every((a) => typeof a === 'string'))) return null;
  return { file: expandEnv(l.file), args: (l.args || []).map(expandEnv), cwd: l.cwd ? expandEnv(l.cwd) : null };
}

// Validate and normalize. Bad entries are dropped (with a reason), never half-used.
function normalizeTools(list) {
  const out = [];
  const problems = [];
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const why = (r) => problems.push((t && t.id ? t.id : '?') + ': ' + r);
    if (!t || typeof t !== 'object') { why('not an object'); continue; }
    if (!ID_RE.test(String(t.id || ''))) { why('bad id'); continue; }
    if (seen.has(t.id)) { why('duplicate id'); continue; }
    // A local entry (data/tools.local.json) may have no project: it lives in a group
    // (or loose at the bottom of the list) instead of under a project.
    const loose = t._local === true && (t.project === null || t.project === undefined || t.project === '');
    if (!loose && (!t.project || typeof t.project !== 'string')) { why('no project'); continue; }
    if (!t.label || typeof t.label !== 'string') { why('no label'); continue; }
    const l = t.launch || {};
    let launch;
    if (typeof l.open === 'string' && l.open) {
      const target = expandEnv(l.open);
      if (!URL_RE.test(target) && !path.isAbsolute(target)) { why('launch.open must be an http(s) URL or an absolute path'); continue; }
      launch = { open: target };
      if (l.requires) {
        const r = normRun(l.requires);
        const port = l.requires.port;
        if (!r || !Number.isInteger(port) || port < 1 || port > 65535) { why('bad launch.requires'); continue; }
        launch.requires = Object.assign({ port }, r);
      }
    } else {
      launch = normRun(l);
      if (!launch) { why('launch needs file (+ string args) or open'); continue; }
    }
    seen.add(t.id);
    out.push({ id: t.id, project: loose ? null : t.project, label: t.label, title: typeof t.title === 'string' ? t.title : '', launch });
  }
  return { tools: out, problems };
}

function localToolsFile(cfg) {
  return path.join(cfg.dataDir, 'tools.local.json');
}

// Apply the operator's overrides to the raw entries (before validation).
function applyOverrides(list, overrides) {
  const ov = overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  const out = [];
  for (const t of list) {
    const o = t && typeof t.id === 'string' && Object.prototype.hasOwnProperty.call(ov, t.id) ? ov[t.id] : null;
    if (!o || typeof o !== 'object') { out.push(t); continue; }
    if (o.removed === true) continue;
    const c = Object.assign({}, t, { launch: Object.assign({}, t.launch || {}) });
    if (typeof o.label === 'string' && o.label.trim()) c.label = o.label.trim();
    if (typeof o.path === 'string' && o.path.trim()) {
      if (typeof c.launch.open === 'string' && c.launch.open) c.launch.open = o.path.trim();
      else c.launch.file = o.path.trim();
    }
    out.push(c);
  }
  return out;
}

function loadTools(cfg, file) {
  const base = readJson(file || path.join(cfg.root, 'config', 'tools.json'), {});
  const local = readJson(localToolsFile(cfg), {});
  const mine = (Array.isArray(local.tools) ? local.tools : []).map((t) => (t && typeof t === 'object' ? Object.assign({}, t, { _local: true }) : t));
  return normalizeTools(applyOverrides([].concat(base.tools || [], mine), local.overrides));
}

// The editable target of a tool: the page / file it opens, else the program it runs.
function toolPath(t) {
  return t.launch.open || t.launch.file;
}

// Validate an operator-typed target. Returns { ok, path } or { ok: false, error }.
// A page tool also takes an http(s) URL; everything else must be an absolute local
// path (drive letter or UNC) that exists; a program must be a file.
function validateToolPath(t, raw) {
  let p = typeof raw === 'string' ? raw.trim() : '';
  if (/^"[^"]*"$/.test(p)) p = p.slice(1, -1).trim();
  if (!p) return { ok: false, error: 'Path is empty.' };
  if (p.length > 1024 || /[\u0000-\u001f]/.test(p)) return { ok: false, error: 'Path has invalid characters.' };
  const isOpen = !!t.launch.open;
  if (isOpen && URL_RE.test(p)) return { ok: true, path: p };
  const exp = expandEnv(p);
  if (!/^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(exp) || !path.win32.isAbsolute(exp)) {
    return { ok: false, error: 'Path must be absolute (for example D:\\folder\\file)' + (isOpen ? ' or an http(s) URL.' : '.') };
  }
  let st = null;
  try { st = fs.statSync(exp); } catch (e) { st = null; }
  if (!st) return { ok: false, error: 'Not found on this machine: ' + path.win32.normalize(exp) };
  if (!isOpen && !st.isFile()) return { ok: false, error: 'This tool runs a program: the path must be a file, not a folder.' };
  return { ok: true, path: p };
}

// Write one override (label / path / removed) into data/tools.local.json.
function saveOverride(cfg, id, patch, writeJson) {
  const file = localToolsFile(cfg);
  const local = readJson(file, {});
  const cur = local && typeof local === 'object' && !Array.isArray(local) ? local : {};
  if (!cur.overrides || typeof cur.overrides !== 'object' || Array.isArray(cur.overrides)) cur.overrides = {};
  cur.overrides[id] = Object.assign({}, cur.overrides[id], patch);
  writeJson(file, cur);
}

function runnable(r) {
  return !!r && fs.existsSync(r.file) && (!r.cwd || fs.existsSync(r.cwd));
}

function isAvailable(t) {
  const l = t.launch;
  if (l.open) return (URL_RE.test(l.open) || fs.existsSync(l.open)) && (!l.requires || runnable(l.requires));
  return runnable(l);
}

// What the UI gets: no command lines, just what it shows and whether it can start.
// The target path is shown so the operator can edit it; program arguments are not.
function publicTool(t, projects) {
  const p = (projects || []).find((x) => x.name === t.project || x.id === t.project || x.code === t.project);
  const out = { id: t.id, label: t.label, title: t.title, projectId: p ? p.id : null, available: isAvailable(t), kind: t.launch.open ? 'open' : 'run', path: toolPath(t) };
  if (t.project === null) out.loose = true;
  return out;
}

// Scripts are not programs CreateProcess can start: each goes through its host, the
// way a double-click on it would (.cmd / .bat cmd.exe, .ps1 powershell.exe,
// .vbs / .js / .wsf wscript.exe). Returns { file, args, verbatim }.
function cmdQuote(a) {
  return a === '' || /[\s"&|<>^()]/.test(a) ? '"' + a.replace(/"/g, '""') + '"' : a;
}
function hostFor(file, args) {
  const ext = path.extname(file).toLowerCase();
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const nfile = path.win32.normalize(file);
  if (ext === '.cmd' || ext === '.bat') {
    const line = ['"' + nfile + '"'].concat(args.map(cmdQuote)).join(' ');
    return { file: process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', '"' + line + '"'], verbatim: true };
  }
  if (ext === '.ps1') return { file: path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', nfile].concat(args) };
  if (ext === '.vbs' || ext === '.js' || ext === '.wsf') return { file: path.join(sys, 'System32', 'wscript.exe'), args: [nfile].concat(args) };
  return { file, args };
}

// True when the file is a console-subsystem PE (powershell.exe, cmd.exe, python.exe):
// IMAGE_OPTIONAL_HEADER.Subsystem == 3. Anything unreadable counts as not console.
function isConsoleExe(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(1024);
    const n = fs.readSync(fd, b, 0, b.length, 0);
    if (n < 64 || b.readUInt16LE(0) !== 0x5a4d) return false;
    const pe = b.readUInt32LE(0x3c);
    if (pe + 94 > n || b.readUInt32LE(pe) !== 0x4550) return false;
    return b.readUInt16LE(pe + 24 + 68) === 3;
  } catch (e) {
    return false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

// A console program started detached gets DETACHED_PROCESS from libuv: no console at
// all, so a visible tool (powershell -NoExit, a .cmd, a .ps1) shows nothing and
// powershell.exe exits at once (CON-TOOL-CONSOLE root cause, a project Start script). Such a
// launch goes through `cmd /c start "" ...`, which gives the program its own console
// window, the way its Desktop shortcut does.
function consoleWindow(h, origFile, origArgs) {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const inner = h.verbatim
    ? ['"' + path.win32.normalize(origFile) + '"'].concat(origArgs.map(cmdQuote)).join(' ')
    : ['"' + path.win32.normalize(h.file) + '"'].concat(h.args.map(cmdQuote)).join(' ');
  return { file: process.env.ComSpec || path.join(sys, 'System32', 'cmd.exe'), args: ['/d', '/s', '/c', '"start "" ' + inner + '"'], verbatim: true };
}

function startDetached(r, spawnFn, visible) {
  if (!fs.existsSync(r.file)) throw new Error('program not found: ' + path.basename(r.file));
  if (r.cwd && !fs.existsSync(r.cwd)) throw new Error('folder not found: ' + r.cwd);
  let h = hostFor(r.file, r.args || []);
  if (visible && isConsoleExe(h.file)) h = consoleWindow(h, r.file, r.args || []);
  const o = { cwd: r.cwd || path.dirname(r.file), detached: true, stdio: 'ignore', windowsHide: false };
  if (h.verbatim) o.windowsVerbatimArguments = true;
  const child = (spawnFn || spawn)(h.file, h.args, o);
  if (child && child.on) child.on('error', () => {});
  if (child && child.unref) child.unref();
  return child;
}

function portOpen(port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms || 400, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Start the tool. deps: { spawn, portOpen, waitMs } are injectable for tests.
async function launchTool(t, deps) {
  deps = deps || {};
  const sp = deps.spawn;
  const probe = deps.portOpen || portOpen;
  try {
    const l = t.launch;
    if (!l.open) {
      const child = startDetached(l, sp, true);
      return { ok: true, pid: child && child.pid };
    }
    let started = false;
    if (l.requires && !(await probe(l.requires.port))) {
      startDetached(l.requires, sp);
      started = true;
      const end = Date.now() + (deps.waitMs === undefined ? 8000 : deps.waitMs);
      while (!(await probe(l.requires.port)) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    }
    if (!URL_RE.test(l.open) && !fs.existsSync(l.open)) throw new Error('not found: ' + l.open);
    // explorer.exe hands a file or URL to its default handler (no console window).
    // A local path goes over with backslashes: explorer.exe does not parse a
    // forward-slash path ("E:/dir/page.html") and falls back to opening the
    // Documents folder instead (CON-PROJ-EDIT root cause).
    const target = URL_RE.test(l.open) ? l.open : path.win32.normalize(l.open);
    startDetached({ file: path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe'), args: [target], cwd: null }, sp);
    return { ok: true, started };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- add a tool (CON-TOOL-ADD): +Tool dialog and drops on the Projects list ----------
// Programs and scripts run (launch.file); a .lnk is resolved to its target, arguments
// and folder; a folder, a URL and EVERY other file type (documents, images, .url ...)
// opens with the Windows default handler (launch.open: explorer.exe, backslash path).
const RUN_EXT = new Set(['.exe', '.com', '.cmd', '.bat', '.ps1', '.vbs']);

// Split a Windows command line into argv (CommandLineToArgvW rules: whitespace,
// double quotes, "" inside quotes, backslashes doubled only before a quote).
function splitArgs(str) {
  const s = String(str || '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let cur = '';
    let inQ = false;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        let n = 0;
        while (s[i] === '\\') { n++; i++; }
        if (s[i] === '"') {
          cur += '\\'.repeat(Math.floor(n / 2));
          if (n % 2) { cur += '"'; i++; }
        } else {
          cur += '\\'.repeat(n);
        }
        continue;
      }
      if (c === '"') {
        if (inQ && s[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQ = !inQ;
        i++;
        continue;
      }
      if (!inQ && /\s/.test(c)) break;
      cur += c;
      i++;
    }
    out.push(cur);
  }
  return out;
}

// Resolve a .lnk with the shell's own reader (WScript.Shell CreateShortcut). The path
// goes over in an environment variable, never inside the script text.
function resolveShortcut(lnk, deps) {
  deps = deps || {};
  const execFile = deps.execFile || require('child_process').execFile;
  return new Promise((resolve) => {
    if (!lnk || !fs.existsSync(lnk)) return resolve({ ok: false, error: 'Shortcut not found.' });
    const script = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
      '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:CC_LNK);' +
      '[Console]::Out.Write((ConvertTo-Json @{t=[string]$s.TargetPath;a=[string]$s.Arguments;w=[string]$s.WorkingDirectory} -Compress))';
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    execFile(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: Object.assign({}, process.env, { CC_LNK: lnk }), windowsHide: true, timeout: 20000, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve({ ok: false, error: 'Could not read the shortcut.' });
        try {
          const j = JSON.parse(String(stdout).trim());
          resolve({ ok: true, target: j.t || '', args: j.a || '', cwd: j.w || '' });
        } catch (e) {
          resolve({ ok: false, error: 'Could not read the shortcut.' });
        }
      });
  });
}

// The user, OneDrive and Public Desktops that exist.
function desktopDirs() {
  const out = [];
  const add = (d) => { if (d && !out.some((x) => x.toLowerCase() === d.toLowerCase()) && fs.existsSync(d)) out.push(d); };
  add(path.join(require('os').homedir(), 'Desktop'));
  if (process.env.OneDrive) add(path.join(process.env.OneDrive, 'Desktop'));
  if (process.env.PUBLIC) add(path.join(process.env.PUBLIC, 'Desktop'));
  return out;
}

// The browser gives a dropped file's NAME only, so look for it on the Desktops:
// exact name, case-insensitive, top level. Returns the full path or null.
function findOnDesktop(name, dirs) {
  const n = String(name || '');
  if (!n || n.length > 255 || /[\\/:*?"<>|\u0000-\u001f]/.test(n) || n === '.' || n === '..') return null;
  for (const d of dirs || desktopDirs()) {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    const hit = names.find((x) => x.toLowerCase() === n.toLowerCase());
    if (hit) return path.join(d, hit);
  }
  return null;
}

// One-line text (a name, a title) or null.
function cleanText(v, max) {
  const t = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return t && t.length <= max && !/[\u0000-\u001f]/.test(t) ? t : null;
}

// Default label: the file name without its extension (a folder keeps its name).
function labelFromPath(p, isDir) {
  const b = path.win32.basename(String(p || '').replace(/[\\/]+$/, ''));
  if (isDir) return b;
  const e = path.win32.extname(b);
  return (e && b.length > e.length ? b.slice(0, -e.length) : b).trim();
}

// An absolute local path that exists: { ok, path, exp, st } or { ok: false, error }.
function checkAbs(raw, what) {
  let p = typeof raw === 'string' ? raw.trim() : '';
  if (/^"[^"]*"$/.test(p)) p = p.slice(1, -1).trim();
  if (!p) return { ok: false, error: what + ' is empty.' };
  if (p.length > 1024 || /[\u0000-\u001f]/.test(p)) return { ok: false, error: what + ' has invalid characters.' };
  const exp = expandEnv(p);
  if (!/^([A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(exp) || !path.win32.isAbsolute(exp)) return { ok: false, error: what + ' must be absolute (for example D:\\folder\\file).' };
  let st = null;
  try { st = fs.statSync(exp); } catch (e) { st = null; }
  if (!st) return { ok: false, error: 'Not found on this machine: ' + path.win32.normalize(exp) };
  return { ok: true, path: p, exp, st };
}

// The launch of a new tool from { path, args?, cwd? } (args = one command-line
// string). A .lnk is resolved to its target, arguments and folder. Returns
// { ok, launch, kind, isDir, source } or { ok: false, error }.
async function buildLaunch(spec, deps) {
  const raw = typeof spec.path === 'string' ? spec.path.trim().replace(/^"([^"]*)"$/, '$1').trim() : '';
  const argStr = typeof spec.args === 'string' ? spec.args.trim() : '';
  const cwdStr = typeof spec.cwd === 'string' ? spec.cwd.trim() : '';
  if (argStr.length > 4096 || /[\u0000-\u001f]/.test(argStr)) return { ok: false, error: 'Arguments have invalid characters.' };
  if (URL_RE.test(raw)) {
    if (argStr || cwdStr) return { ok: false, error: 'Arguments and folder apply only to a program.' };
    return { ok: true, launch: { open: raw }, kind: 'open', isDir: false, source: null };
  }
  const v = checkAbs(raw, 'Path');
  if (!v.ok) return v.error === 'Path must be absolute (for example D:\\folder\\file).' ? { ok: false, error: 'Path must be absolute (for example D:\\folder\\file) or an http(s) URL.' } : v;
  let file = v.exp;
  let st = v.st;
  let args = splitArgs(argStr);
  let cwd = cwdStr;
  let source = null;
  if (st.isFile() && path.extname(file).toLowerCase() === '.lnk') {
    const r = await resolveShortcut(file, deps);
    if (!r.ok) return r;
    source = path.win32.basename(file);
    if (!r.target) {
      // No file target (a store app or shell item): open the shortcut itself.
      return { ok: true, launch: { open: path.win32.normalize(file) }, kind: 'open', isDir: false, source };
    }
    const t = checkAbs(r.target, 'The shortcut target');
    if (!t.ok) return { ok: false, error: 'The shortcut points at something missing: ' + r.target };
    file = t.exp;
    st = t.st;
    if (!argStr) args = splitArgs(r.args);
    if (!cwdStr && r.cwd) cwd = r.cwd;
  }
  const isRun = st.isFile() && RUN_EXT.has(path.extname(file).toLowerCase());
  if (!isRun) {
    if (argStr || cwdStr) return { ok: false, error: 'Arguments and folder apply only to a program (.exe, .cmd, .bat, .ps1, .vbs).' };
    return { ok: true, launch: { open: path.win32.normalize(file) }, kind: 'open', isDir: st.isDirectory(), source };
  }
  let c = null;
  if (cwd) {
    const cv = checkAbs(cwd, 'Folder');
    if (!cv.ok) return cv;
    if (!cv.st.isDirectory()) return { ok: false, error: 'Folder must be a folder, not a file.' };
    c = path.win32.normalize(cv.exp);
  }
  return { ok: true, launch: { file: path.win32.normalize(file), args, cwd: c }, kind: 'run', isDir: false, source };
}

function newToolId(label, taken) {
  const base = String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'tool';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = base + '-' + i;
  return id;
}

// Append a new entry to data/tools.local.json `tools`; returns its id.
function addLocalTool(cfg, entry, takenIds, writeJson) {
  const file = localToolsFile(cfg);
  const cur = readJson(file, {});
  const local = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
  if (!Array.isArray(local.tools)) local.tools = [];
  const taken = new Set(takenIds || []);
  for (const t of local.tools) if (t && t.id) taken.add(t.id);
  if (local.overrides && typeof local.overrides === 'object') for (const k of Object.keys(local.overrides)) taken.add(k);
  const id = newToolId(entry.label, taken);
  local.tools.push({ id, project: entry.project || null, label: entry.label, title: entry.title || '', launch: entry.launch });
  writeJson(file, local);
  return id;
}

// Remove: an added entry leaves tools.local.json; a configured one is hidden.
function removeTool(cfg, id, writeJson) {
  const file = localToolsFile(cfg);
  const cur = readJson(file, {});
  if (cur && Array.isArray(cur.tools) && cur.tools.some((t) => t && t.id === id)) {
    cur.tools = cur.tools.filter((t) => !(t && t.id === id));
    if (cur.overrides && typeof cur.overrides === 'object') delete cur.overrides[id];
    writeJson(file, cur);
    return;
  }
  saveOverride(cfg, id, { removed: true }, writeJson);
}

module.exports = {
  loadTools, normalizeTools, publicTool, launchTool, expandEnv, portOpen, applyOverrides, validateToolPath, saveOverride, toolPath, localToolsFile,
  splitArgs, resolveShortcut, desktopDirs, findOnDesktop, cleanText, labelFromPath, buildLaunch, newToolId, addLocalTool, removeTool, hostFor, isConsoleExe,
};
