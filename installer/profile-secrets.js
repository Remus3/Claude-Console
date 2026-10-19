'use strict';
// CON-013 L4: the setup profile's secret store (design d.6, Q6). Windows only (Q10).
//
// - One DPAPI file per secret: <dataDir>/profile/secrets/<name>.dpapi, written by
//   installer/ps/secret.ps1 (ConvertFrom-SecureString, current user) with the value
//   on STDIN only. A <name>.meta.json beside it holds the length and the date, so the
//   UI can show "set (12 chars)" without decrypting.
// - Never echoed: no result, log, journal entry, argv or child env carries a value.
// - Consumers get a reference, {"command": [powershell.exe ... read-secret.ps1 -Name
//   <name> -Dir <dir>]}, resolved at use time by the kit's secret resolver.
// - Overwrite and remove keep the prior DPAPI file in <txDir>/pre/secrets/; revert
//   restores those bytes. A secret file the profile created leaves through the
//   Recycle Bin (injected recycle), never a direct unlink.
const fs = require('fs');
const path = require('path');
const C = require('./profile-oscommon');

const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

function createSecretStore(opts) {
  opts = opts || {};
  if (!opts.dataDir) throw new Error('dataDir required');
  const runner = opts.runner || C.realRunner;
  const platform = opts.platform || process.platform;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = opts.now || (() => Date.now());
  const recycle = opts.recycle || require('./fsutil').recycleWindows;
  const dir = path.join(opts.dataDir, 'profile', 'secrets');

  const goodName = (n) => typeof n === 'string' && NAME_RE.test(n);
  const file = (n) => {
    if (!goodName(n)) throw new Error('bad secret name (lower case letters, digits, - and _)');
    return path.join(dir, n + '.dpapi');
  };
  const metaFile = (n) => path.join(dir, n + '.meta.json');

  async function op(which, f, input) {
    const r = await runner(C.POWERSHELL, C.psArgs('secret.ps1'), { env: { CC_SECRET_OP: which, CC_SECRET_FILE: f }, input: input === undefined ? '' : input, timeoutMs: 30000 });
    const j = C.parseJsonLine(r.stdout);
    if (r.code !== 0 || !j || j.error) return { ok: false, error: (j && j.error) || C.firstLine(r.stderr) || 'exit ' + r.code };
    return j.ok ? { ok: true, length: j.length, sha256: j.sha256 } : { ok: false, error: 'not readable' };
  }

  async function check(name) {
    if (C.windowsOnly(platform)) return { ok: false, error: 'Windows only' };
    const f = file(name);
    if (!fs.existsSync(f)) return { ok: false, error: 'not set' };
    return op('check', f);
  }

  function status(name) {
    const present = goodName(name) && fs.existsSync(file(name));
    let length;
    if (present) {
      try { length = JSON.parse(fs.readFileSync(metaFile(name), 'utf8')).length; } catch (e) { length = undefined; }
    }
    return { name, present, display: C.mask({ present, length }) };
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.dpapi')).map((f) => f.slice(0, -6)).filter(goodName).sort(); } catch (e) { names = []; }
    return names.map(status);
  }

  function reference(name, o) {
    const script = (o && o.script) || path.join(C.PS_DIR, 'read-secret.ps1');
    file(name);
    return { command: [C.POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Name', name, '-Dir', dir] };
  }

  // Copy the current file + meta into the tx pre-images; {present:false} when absent.
  function capture(name, txDir) {
    const f = file(name);
    if (!fs.existsSync(f)) return { present: false };
    const pre = C.preFile(txDir, 'secrets', name + '.dpapi');
    const bytes = fs.readFileSync(f);
    fs.writeFileSync(pre.abs, bytes);
    let meta = null;
    try { meta = fs.readFileSync(metaFile(name)); } catch (e) { meta = null; }
    if (meta) fs.writeFileSync(pre.abs + '.meta.json', meta);
    return { present: true, pre: pre.rel, sha256: C.sha256(bytes) };
  }

  function restoreBytes(name, prior, txDir) {
    const src = path.join(txDir, ...prior.pre.split('/'));
    const bytes = fs.readFileSync(src);
    C.writeAtomic(file(name), bytes);
    if (fs.existsSync(src + '.meta.json')) C.writeAtomic(metaFile(name), fs.readFileSync(src + '.meta.json'));
    return C.sha256(fs.readFileSync(file(name))) === prior.sha256;
  }

  async function dropFile(name) {
    const f = file(name);
    if (fs.existsSync(f)) await recycle(f);
    try { fs.rmSync(metaFile(name), { force: true }); } catch (e) { /* metadata only */ }
    return !fs.existsSync(f);
  }

  async function put(name, value, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!goodName(name)) return { status: 'refused', name, reason: 'bad secret name (lower case letters, digits, - and _)' };
    if (typeof value !== 'string' || !value.length) return { status: 'refused', name, reason: 'empty value' };
    if (/[\x00-\x1f\x7f]/.test(value) || value.length > 8192) return { status: 'refused', name, reason: 'value must be one line of text' };
    const exists = fs.existsSync(file(name));
    if (o.apply !== true) return { status: 'dry-run', name, plan: { kind: 'secret', name, status: exists ? 'differs' : 'new', current: status(name).display } };
    const prior = capture(name, o.txDir);
    const entry = C.journalWrite(o, { kind: 'secret', name, prior, applied: { present: true } });
    fs.mkdirSync(dir, { recursive: true });
    const w = await op('put', file(name), value);
    const back = w.ok ? await op('check', file(name)) : null;
    if (back && back.ok && back.sha256 === C.sha256(value) && back.length === value.length) {
      C.writeAtomic(metaFile(name), JSON.stringify({ name, length: value.length, set: C.localDate(now()) }) + '\n');
      log('secret put ' + name + ' ok');
      return { status: 'applied', name, entry, display: status(name).display };
    }
    let rolledBack;
    if (prior.present) rolledBack = restoreBytes(name, prior, o.txDir);
    else { try { fs.rmSync(file(name), { force: true }); } catch (e) { /* failed attempt */ } rolledBack = !fs.existsSync(file(name)); }
    log('secret put ' + name + ' failed');
    return { status: 'failed', name, reason: w.ok ? 'read-back of the stored secret did not match' : 'DPAPI write failed: ' + w.error, rolledBack, entry };
  }

  async function remove(name, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!goodName(name)) return { status: 'refused', name, reason: 'bad secret name' };
    if (!fs.existsSync(file(name))) return { status: 'same', name };
    if (o.apply !== true) return { status: 'dry-run', name, plan: { kind: 'secret', name, status: 'remove' } };
    const prior = capture(name, o.txDir);
    const entry = C.journalWrite(o, { kind: 'secret', name, prior, applied: { present: false } });
    const gone = await dropFile(name);
    log('secret remove ' + name + (gone ? ' ok' : ' failed'));
    return gone ? { status: 'applied', name, entry } : { status: 'failed', name, reason: 'the secret file is still there', entry };
  }

  async function revert(entry, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!entry || entry.kind !== 'secret' || !goodName(entry.name) || !entry.prior) return { status: 'refused', reason: 'not a secret journal entry' };
    const action = entry.prior.present ? 'restore the prior secret file' : 'send the secret file to the Recycle Bin';
    if (o.apply !== true) return { status: 'dry-run', name: entry.name, action };
    const ok = entry.prior.present ? restoreBytes(entry.name, entry.prior, o.txDir) : await dropFile(entry.name);
    log('secret revert ' + entry.name + (ok ? ' ok' : ' failed'));
    return ok ? { status: 'reverted', name: entry.name, action } : { status: 'failed', name: entry.name, reason: 'revert did not read back' };
  }

  return { dir, file, status, list, reference, check, put, remove, revert };
}

module.exports = { createSecretStore, NAME_RE };
