'use strict';
// `claude-console uninstall [--purge] [--keep-profile]` (VMFIX). A setup profile that is
// still applied refuses the uninstall (R1-14): its tasks and hooks would keep running
// with the tool that can remove them gone; --keep-profile overrides. Else it stops a
// running console, removes the
// shell integration (Desktop + Start-menu shortcuts, the Apps & features entry, the
// user PATH entry, the auto-update task) and the code (app/, .base/, cache/, reports/,
// run/, the launchers, the install marker). User data (data/, drops/, backups/) stays
// unless --purge; purged user data goes to the Recycle Bin, never a direct delete.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { layout } = require('./paths');
const { exists, recycleWindows } = require('./fsutil');
const { readToken } = require('./detect');
const stopper = require('./stop');

const CODE = ['app', '.base', 'cache', 'reports', 'run'];
const FILES = ['install.json', 'launch.vbs', 'claude-console.cmd', 'statusline.js', 'autoupdate.vbs', 'register-autoupdate.ps1'];
const USER = ['data', 'drops', 'backups'];

const PROFILE_REFUSAL = 'Your setup profile is still applied. See what it would remove: claude-console profile uninstall --all. Add --apply --yes to remove it, then uninstall again. To leave it in place: claude-console uninstall --keep-profile';

// A lock's item count; a lock that exists but cannot be read counts as applied (the guard
// fails closed and --keep-profile still gets past it).
function lockState(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { items: 0 } : { items: 1, unreadable: true }; }
  try {
    const j = JSON.parse(raw);
    return { items: j && Array.isArray(j.items) ? j.items.length : 0, configDir: j && j.configDir };
  } catch (e) { return { items: 1, unreadable: true }; }
}

// What `profile status` calls applied: an item in a user lock (one per account's config
// dir) or in the lock of a repo the profile was applied to. Read from the files only, so
// a broken profile engine can not make the uninstall throw.
function profileApplied(dataDir) {
  const root = path.join(dataDir, 'profile');
  const out = { applied: false, repos: [], accounts: [], unreadable: [] };
  const seen = (file, s) => { if (s.unreadable) out.unreadable.push(file); if (s.items) out.applied = true; return !!s.items; };
  let names = [];
  try { names = fs.readdirSync(path.join(root, 'locks')).filter((n) => /^user(-[0-9a-f]+)?\.json$/.test(n)); } catch (e) { names = []; }
  for (const n of names) {
    const file = path.join(root, 'locks', n);
    const s = lockState(file);
    if (seen(file, s) && n !== 'user.json' && s.configDir) out.accounts.push(String(s.configDir));
  }
  let repos = [];
  try { repos = JSON.parse(fs.readFileSync(path.join(root, 'targets.json'), 'utf8')).repos; } catch (e) { repos = []; }
  for (const r of Array.isArray(repos) ? repos : []) {
    const file = path.join(String(r), '.claude', 'profile.lock.json');
    if (seen(file, lockState(file))) out.repos.push(String(r));
  }
  return out;
}

// The app window's Edge profile (server.js openWindow), and its parent when that leaves it
// empty. Returns null, or the folder when it stays (an open window holds its files).
function removeEdgeProfileDir(dir, rm) {
  if (!dir || !exists(dir)) return null;
  try { (rm || fs.rmSync)(dir, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* named below */ }
  if (exists(dir)) return dir;
  try { fs.rmdirSync(path.dirname(dir)); } catch (e) { /* not empty */ }
  return null;
}

function edgeProfileDir(env) {
  const local = (env || process.env).LOCALAPPDATA;
  return local ? path.join(local, 'ClaudeConsole', 'edge-profile') : null; // no LOCALAPPDATA: it is under run/
}

// o: home, purge, keepProfile, port, removeShell(home), recycle(path), removeEdgeProfile()
// (default real, except where a test injected removeShell), postShutdown(port, token),
// and the stop.js probes (isAlive, kill, sleep, listServers, timeoutMs), rm, retryMs.
// Anything left behind = ok false and ONE "uninstall incomplete: ..." line.
async function uninstall(o) {
  const L = layout(o.home);
  const lines = [];
  const rep = { kind: 'uninstall', home: L.home, removed: [], kept: [], ok: true, lines };
  if (!exists(L.home)) {
    lines.push('nothing to uninstall: ' + L.home + ' does not exist');
    return rep;
  }
  const profile = profileApplied(L.data);
  if (profile.applied && !o.keepProfile) {
    rep.ok = false;
    rep.refused = 'profile';
    lines.push(PROFILE_REFUSAL);
    for (const r of profile.repos) lines.push('Also applied to a project: claude-console profile uninstall --all --target repo:"' + r + '"');
    for (const c of profile.accounts) lines.push('Also applied for another account: ' + c);
    for (const f of profile.unreadable) lines.push('Could not read this record of it: ' + f);
    return rep;
  }
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryMs = o.retryMs || 1000;
  const problems = [];
  // CON-0.1.1: stop = the server PROCESS is gone (it holds app\<v> open), not just the
  // port; one that will not quit is killed (uninstall means it), and a leftover server
  // of an older version, found by its command line, goes the same way.
  const stopOpts = { run: L.run, home: L.home, port: o.port || 7800, token: readToken(L.run), force: true, timeoutMs: o.timeoutMs || 10000, postShutdown: o.postShutdown, isAlive: o.isAlive, kill: o.kill, sleep, listServers: o.listServers };
  const st = await stopper.stopServer(stopOpts);
  if (st.alive.length) problems.push('the console server (pid ' + st.alive.join(', ') + ') would not stop');
  else if (st.running) {
    lines.push('stopped the running console' + (st.killed.length ? ' (killed pid ' + st.killed.join(', ') + ')' : ''));
    await sleep(500); // let it release node-pty and its files
  }
  try {
    const out = await (o.removeShell || require('./launcher').removeShellWindows)(L.home);
    for (const l of out || []) if (l) lines.push(l);
  } catch (e) {
    problems.push('shortcuts / Apps & features / PATH (' + e.message + ')');
  }
  const rm = o.rm || fs.rmSync;
  const errs = {};
  for (const d of CODE) {
    const p = path.join(L.home, d);
    for (let i = 0; i < 5 && exists(p); i++) {
      try {
        rm(p, { recursive: true, force: true, maxRetries: 3 });
        delete errs[d];
      } catch (e) {
        errs[d] = e;
        if (i === 1) await stopper.stopServer(Object.assign({}, stopOpts, { postShutdown: async () => false, timeoutMs: 2000 }));
        await sleep(retryMs);
      }
    }
    if (!exists(p)) rep.removed.push(d);
  }
  for (const f of FILES) {
    const p = path.join(L.home, f);
    if (!exists(p) || f === 'claude-console.cmd') continue;
    try { fs.unlinkSync(p); rep.removed.push(f); } catch (e) { errs[f] = e; }
  }
  // Never report success while files remain: what is still there, and why.
  const left = CODE.concat(FILES).filter((x) => x !== 'claude-console.cmd' && exists(path.join(L.home, x)));
  if (left.length) {
    const why = left.map((x) => errs[x]).find((e) => e);
    problems.push('could not remove ' + left.map((x) => path.join(L.home, x)).join(', ') + (why ? ' (' + (why.code || '') + (why.code ? ': ' : '') + why.message + ')' : ''));
  }
  if (problems.length) {
    rep.ok = false;
    lines.push('uninstall incomplete: ' + problems.join('; ') + ' - close any program using ' + L.home + ' and run claude-console uninstall again');
    return rep;
  }
  const cmdFile = path.join(L.home, 'claude-console.cmd');
  if (exists(cmdFile)) rep.removed.push('claude-console.cmd');
  const rmEdge = o.removeEdgeProfile !== undefined ? o.removeEdgeProfile : (o.removeShell ? null : () => removeEdgeProfileDir(edgeProfileDir()));
  if (typeof rmEdge === 'function') {
    const stays = await rmEdge();
    if (stays) lines.push("The console window's browser data stays in " + stays + '. Close that window, then delete the folder.');
  }
  const user = USER.filter((d) => exists(path.join(L.home, d)));
  if (o.purge) {
    const recycle = o.recycle || recycleWindows;
    for (const d of user) { await recycle(path.join(L.home, d)); rep.removed.push(d); }
    let left = [];
    // claude-console.cmd is not "left": the cleanup below removes it, then the folder.
    try { left = fs.readdirSync(L.home).filter((n) => n !== 'claude-console.cmd'); } catch (e) { left = []; }
    if (!left.length) { try { fs.rmdirSync(L.home); } catch (e) { /* in use */ } }
    lines.push('uninstalled; user data moved to the Recycle Bin' + (left.length ? ' (left in ' + L.home + ': ' + left.join(', ') + ')' : ''));
  } else {
    rep.kept = user;
    lines.push('uninstalled the code from ' + L.home);
    if (user.length) lines.push('kept your data: ' + user.map((d) => path.join(L.home, d)).join(', ') + ' (remove it too with: claude-console uninstall --purge, or delete the folder)');
  }
  if (profile.applied) lines.push('Your setup profile stays applied: its files, settings and scheduled tasks remain.');
  lines.push('Claude Code settings (~/.claude) are not touched; a statusLine entry that points at ' + path.join(L.home, 'statusline.js') + ' can be removed by hand.');
  lines.push('Claude Code, Node.js and Git stay installed.');
  // claude-console.cmd is the batch file running this very command, and cmd.exe checks
  // it again after node exits ("The system cannot find the path specified." / "The batch
  // file cannot be found." and exit 1 once it is gone). CON-0.1.2: it, and for --purge
  // the emptied folder, go from a cleanup script in %TEMP% that first waits for this
  // process and the .cmd that ran it to exit; started last, after all other work.
  if (exists(cmdFile)) (o.deleteLater || deleteLaterWindows)([cmdFile], o.purge ? L.home : null);
  return rep;
}

// The cleanup script (VBScript run by wscript.exe: a GUI host, so it runs detached with
// no console and no window; a detached powershell.exe exits at once without a console,
// measured). Arguments: the CLI's pid (node), its parent's pid, the files ("|"-joined),
// and for --purge the folder. The parent is waited for too when it is the cmd.exe
// running claude-console.cmd (`cmd /c` from PowerShell or Apps & features), not when it
// is an interactive cmd that stays open. A pid counts as alive only with the creation
// time first seen (no wait on a reused pid). Nothing is removed before the waits end
// (10 min cap); then the files, the folder when empty, and the script itself.
function cleanupScript() {
  return [
    "' Claude Console uninstall cleanup (written to %TEMP% by claude-console uninstall).",
    'Option Explicit',
    'Dim args, fso, wmi, cliPid, parentPid, files, folder, deadline, cliBorn, parentBorn, waitParent, p, f, i',
    'Set args = WScript.Arguments',
    'If args.Count < 3 Then WScript.Quit 2',
    'cliPid = CLng(args(0))',
    'parentPid = CLng(args(1))',
    'files = Split(args(2), "|")',
    'folder = ""',
    'If args.Count > 3 Then folder = args(3)',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    'Set wmi = GetObject("winmgmts:{impersonationLevel=impersonate}!\\\\.\\root\\cimv2")',
    'Function Born(pid)',
    '  Dim r, q',
    '  r = ""',
    '  If pid > 0 Then',
    '    For Each q In wmi.ExecQuery("SELECT CreationDate FROM Win32_Process WHERE ProcessId=" & pid)',
    '      r = q.CreationDate & ""',
    '    Next',
    '  End If',
    '  Born = r',
    'End Function',
    'cliBorn = Born(cliPid)',
    'waitParent = False',
    'If parentPid > 0 Then',
    '  For Each p In wmi.ExecQuery("SELECT Name, CommandLine, CreationDate FROM Win32_Process WHERE ProcessId=" & parentPid)',
    '    If LCase(p.Name & "") = "cmd.exe" And InStr(1, p.CommandLine & "", "claude-console.cmd", 1) > 0 Then',
    '      waitParent = True',
    '      parentBorn = p.CreationDate & ""',
    '    End If',
    '  Next',
    'End If',
    'deadline = DateAdd("s", 600, Now)',
    'Do While Now < deadline',
    '  If cliBorn <> "" Then',
    '    If Born(cliPid) <> cliBorn Then cliBorn = ""',
    '  End If',
    '  If waitParent Then',
    '    If Born(parentPid) <> parentBorn Then waitParent = False',
    '  End If',
    '  If cliBorn = "" And Not waitParent Then Exit Do',
    '  WScript.Sleep 200',
    'Loop',
    'WScript.Sleep 500',
    'On Error Resume Next',
    'For Each f In files',
    '  If f <> "" Then',
    '    For i = 1 To 20',
    '      If Not fso.FileExists(f) Then Exit For',
    '      Err.Clear',
    '      fso.DeleteFile f, True',
    '      If fso.FileExists(f) Then WScript.Sleep 500',
    '    Next',
    '  End If',
    'Next',
    'If folder <> "" Then',
    '  If fso.FolderExists(folder) Then',
    '    If fso.GetFolder(folder).Files.Count = 0 And fso.GetFolder(folder).SubFolders.Count = 0 Then fso.DeleteFolder folder, True',
    '  End If',
    'End If',
    'fso.DeleteFile WScript.ScriptFullName, True',
    '',
  ].join('\n');
}

// Writes the cleanup script to %TEMP% (the install folder is about to go) and starts it
// detached with no stdio, so the terminal sees nothing from it.
// o (tests): spawn, tmpdir, pid, ppid. Returns the script path.
function deleteLaterWindows(files, emptyDir, o) {
  o = o || {};
  const pid = o.pid || process.pid;
  const file = path.join(o.tmpdir || os.tmpdir(), 'claude-console-cleanup-' + pid + '.vbs');
  fs.writeFileSync(file, cleanupScript());
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  const args = ['//B', '//Nologo', file, String(pid), String(o.ppid || process.ppid), files.join('|')];
  if (emptyDir) args.push(emptyDir);
  const c = (o.spawn || require('child_process').spawn)(wscript, args, { detached: true, stdio: 'ignore', windowsHide: true });
  if (c.on) c.on('error', () => {}); // no wscript: the .cmd stays, uninstall already reported
  c.unref();
  return file;
}

module.exports = { uninstall, CODE, FILES, USER, PROFILE_REFUSAL, profileApplied, removeEdgeProfileDir, edgeProfileDir, deleteLaterWindows, cleanupScript };
