'use strict';
// CON-013 L4: shared helpers of the setup profile's machine adapters
// (profile-env.js, profile-secrets.js, profile-route.js, profile-tasks.js,
// profile-appconfig.js). Every OS effect goes through ONE injected runner
// runner(file, args, {env, input, timeoutMs}) -> {code, stdout, stderr}; tests pass
// fakes and never reach the registry, DPAPI, the kit CLI or the scheduler (floor:
// never run a machine-reconfiguring script on this box to test it).
//
// Adapter contract (the engine's profile-tx.js calls it):
//   plan(c)                 read-only: {status: new|same|differs|skipped, ...}
//   apply(c, opts)          opts.apply !== true = dry run (returns the plan, writes
//                           nothing); otherwise backup first, one change, read back,
//                           roll back on mismatch. Result status: dry-run | same |
//                           applied | refused | failed | skipped.
//   revert(entry, opts)     replays one journal entry; opts.apply !== true = dry run.
// opts.journal(entry) receives one entry per write BEFORE the write; entries and logs
// carry names, kinds, hashes and lengths, never a value. Pre-images live under
// opts.txDir/pre/.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const PS_DIR = path.join(__dirname, 'ps');

function sha256(s) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(s) ? s : Buffer.from(String(s), 'utf8')).digest('hex');
}

function windowsOnly(platform) {
  return (platform || process.platform) === 'win32' ? null : { status: 'skipped', reason: 'Windows only' };
}

// "set (12 chars)" / "not set": the only way a value's existence is ever shown.
function mask(state) {
  return state && state.present ? 'set (' + (state.length === undefined ? '?' : state.length) + ' chars)' : 'not set';
}

function psArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(PS_DIR, script)];
}

// Real runner: no shell, hidden window, bounded time; opts.input is written to stdin
// and stdin is closed (values travel only there).
function realRunner(file, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, shell: false, env: opts.env ? Object.assign({}, process.env, opts.env) : process.env });
    } catch (e) {
      resolve({ code: 1, stdout: '', stderr: String(e && e.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish({ code: 1, stdout, stderr: 'timeout' }); }, opts.timeoutMs || 60000);
    child.stdout.on('data', (d) => { if (stdout.length < 1048576) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1048576) stderr += d; });
    child.on('error', (e) => finish({ code: 1, stdout, stderr: String(e && e.message) }));
    child.on('close', (code) => finish({ code: typeof code === 'number' ? code : 1, stdout, stderr }));
    child.stdin.on('error', () => { /* child exited early */ });
    child.stdin.end(opts.input === undefined ? '' : Buffer.from(String(opts.input), 'utf8'));
  });
}

// INTEGRATE-1: the synchronous twin of realRunner for the engine adapters
// (createAdapter in profile-env.js and profile-tasks.js; the L3 engine calls them
// synchronously). Same contract: no shell, hidden window, bounded time, value on stdin.
function realRunnerSync(file, args, opts) {
  opts = opts || {};
  const r = spawnSync(file, args, {
    windowsHide: true, shell: false, timeout: opts.timeoutMs || 60000, maxBuffer: 32 * 1048576,
    env: opts.env ? Object.assign({}, process.env, opts.env) : process.env,
    input: Buffer.from(opts.input === undefined ? '' : String(opts.input), 'utf8'),
  });
  if (r.error) return { code: 1, stdout: String(r.stdout || ''), stderr: String(r.error.message || r.error) };
  return { code: typeof r.status === 'number' ? r.status : 1, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}

// The last JSON line of a child's stdout, or null.
function parseJsonLine(stdout) {
  const lines = String(stdout || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(lines[i]); if (j && typeof j === 'object') return j; } catch (e) { /* not JSON */ }
  }
  return null;
}

function firstLine(s) {
  return String(s || '').replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean).join(' ').slice(0, 200);
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(ms) { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }

// A pre-image path under txDir/pre/<area>/; returns {abs, rel} (rel goes in the journal).
function preFile(txDir, area, name) {
  if (!txDir) throw new Error('txDir required for a write');
  const rel = path.posix.join('pre', area, name);
  const abs = path.join(txDir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return { abs, rel };
}

function journalWrite(opts, entry) {
  if (opts && typeof opts.journal === 'function') opts.journal(entry);
  return entry;
}

function consentFor(consent, name) {
  return consent === true || (Array.isArray(consent) && consent.includes(name));
}

module.exports = {
  POWERSHELL, PS_DIR, sha256, windowsOnly, mask, psArgs, realRunner, realRunnerSync, parseJsonLine, firstLine,
  writeAtomic, localDate, preFile, journalWrite, consentFor,
};
