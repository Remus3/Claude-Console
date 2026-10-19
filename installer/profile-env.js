'use strict';
// CON-013 L4: user-scope environment variable adapter (Windows only, Q10). Writes
// HKCU\Environment through installer/ps/env.ps1 run by an injected runner, then
// broadcasts WM_SETTINGCHANGE so new terminals see it. Contract: profile-oscommon.js.
//
// - A value travels on the child's STDIN only, never in argv, the child env, a log,
//   the journal or a result (results carry "set (N chars)" and hashes).
// - Before a write the prior value is captured DPAPI-protected into
//   <txDir>/pre/env/<NAME>.dpapi; the journal holds presence, kind, sha256 and the
//   pre-image path, so revert restores value AND kind exactly, or removes a variable
//   that was absent.
// - Set only on consent (opts.consent true or a list naming the variable).
// - A secret contribution ({name, secret: <ref>}) is a mirror of a stored secret: it
//   needs its own opt-in (opts.mirror) and the value goes from the DPAPI file to the
//   registry inside PowerShell; node never holds it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('./profile-oscommon');

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const KINDS = ['String', 'ExpandString'];
// A literal that looks like a credential is refused: secrets go through the store.
const KEY_SHAPES = [/^sk-[A-Za-z0-9_-]{16,}/, /^gh[pousr]_[A-Za-z0-9]{20,}/, /^github_pat_/, /^AKIA[0-9A-Z]{16}/, /^xox[abpr]-/, /^[0-9a-fA-F]{32,}$/, /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./];
const MIRROR_WARNING = 'A user environment variable is readable by every process of this user; the DPAPI store alone is safer.';

// Plain-English explanation per known variable (wizard step "Environment variables").
const CATALOG = Object.freeze({
  PYTHONUTF8: { does: 'Makes Python child processes read and write UTF-8 regardless of the console code page.', why: 'Hook and kit scripts print and parse text; without it a non-ASCII character can crash them on Windows.' },
  CLAUDE_CODE_NO_FLICKER: { does: 'Tells Claude Code to redraw its terminal without flicker.', why: 'A calm display: no repaint flashes in the console panes.' },
  KIT_SUITE_SLOTS: { does: 'Number of whole test suites that may run at once on this machine (the suite gate).', why: 'Concurrent whole suites lost workers and flaked timing tests; the gate queues the rest.' },
  CLAUDE_HEADLESS_BASE_URL: { does: 'The headless kill switch: the loopback URL every headless run checks before it starts, in both route modes. Delete it and every next headless run is refused.', why: 'One act stops all headless spend on this machine; it is required even with a single account.' },
  CLAUDE_CONFIG_DIR: { does: 'Points Claude Code at a different account folder.', why: 'Only set per process for a second account; a user-wide value would move every session.' },
});

function explain(name, item) {
  if (item && item.does && item.why) return { name, does: item.does, why: item.why };
  const x = CATALOG[name];
  return x ? { name, does: x.does, why: x.why } : null;
}

function keyShaped(v) {
  return KEY_SHAPES.some((re) => re.test(v));
}

function validate(c) {
  if (!c || typeof c !== 'object') return 'contribution required';
  if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) return 'variable name must be upper case letters, digits and underscore';
  if ((c.scope || 'user') !== 'user') return 'only the user scope is written';
  const hasValue = c.value !== undefined;
  const hasSecret = c.secret !== undefined;
  if (hasValue === hasSecret) return 'exactly one of value, secret';
  if (hasValue) {
    if (typeof c.value !== 'string' || !c.value.length) return 'value must be non-empty text';
    if (/[\x00-\x1f\x7f]/.test(c.value)) return 'value must be one line without control characters';
    if (c.value.length > 2047) return 'value too long';
    if (keyShaped(c.value)) return 'value looks like a key: store it as a secret and reference it';
  } else if (typeof c.secret !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(c.secret)) return 'bad secret reference name';
  if (c.kind !== undefined && !KINDS.includes(c.kind)) return 'kind must be String or ExpandString';
  return null;
}

function createEnvAdapter(opts) {
  opts = opts || {};
  const runner = opts.runner || C.realRunner;
  const platform = opts.platform || process.platform;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const secrets = opts.secrets || null;

  async function op(name, which, extra, input) {
    const env = Object.assign({ CC_ENV_OP: which, CC_ENV_NAME: name }, extra || {});
    const r = await runner(C.POWERSHELL, C.psArgs('env.ps1'), { env, input: input === undefined ? '' : input, timeoutMs: 30000 });
    const j = C.parseJsonLine(r.stdout);
    if (r.code !== 0 || !j || j.error) return { ok: false, error: (j && j.error) || C.firstLine(r.stderr) || 'exit ' + r.code };
    return { ok: true, state: j.present ? { present: true, kind: j.kind, sha256: j.sha256, length: j.length } : { present: false } };
  }

  async function read(name) {
    if (!NAME_RE.test(String(name))) throw new Error('bad variable name');
    const r = await op(name, 'read');
    return r.ok ? r.state : { present: null, error: r.error };
  }

  async function wantedSha(c) {
    if (c.value !== undefined) return { sha256: C.sha256(c.value) };
    if (!secrets) return { error: 'no secret store' };
    const s = await secrets.check(c.secret);
    return s.ok ? { sha256: s.sha256 } : { error: 'secret ' + c.secret + ' is not set' };
  }

  async function plan(c) {
    const off = C.windowsOnly(platform);
    if (off) return Object.assign({ kind: 'env', name: c && c.name }, off);
    const bad = validate(c);
    if (bad) return { kind: 'env', name: c && c.name, status: 'refused', reason: bad };
    const cur = await read(c.name);
    if (cur.present === null) return { kind: 'env', name: c.name, status: 'unreadable', reason: cur.error };
    const want = await wantedSha(c);
    const kind = c.kind || 'String';
    let status = 'new';
    if (cur.present) status = want.sha256 && cur.sha256 === want.sha256 && cur.kind === kind ? 'same' : 'differs';
    return { kind: 'env', name: c.name, scope: 'user', status, current: C.mask(cur), proposed: c.value !== undefined ? c.value : 'secret reference ' + c.secret };
  }

  async function describe(c, item) {
    const p = await plan(c);
    const x = explain(c.name, item) || { does: 'Set by the setup profile.', why: 'See the item that adds it.' };
    return { name: c.name, scope: 'user', does: x.does, why: x.why, proposed: p.proposed, current: p.current || 'not set', matches: p.status === 'same', status: p.status };
  }

  async function restorePrior(name, prior, txDir) {
    if (prior.present) {
      const r = await op(name, 'restore', { CC_ENV_FILE: path.join(txDir, ...prior.pre.split('/')), CC_ENV_KIND: prior.kind });
      return r.ok && r.state.present && r.state.sha256 === prior.sha256 && r.state.kind === prior.kind;
    }
    const r = await op(name, 'remove');
    return r.ok && !r.state.present;
  }

  async function capture(name, txDir) {
    const pre = C.preFile(txDir, 'env', name + '.dpapi');
    const cap = await op(name, 'capture', { CC_ENV_FILE: pre.abs });
    if (!cap.ok) return null;
    return cap.state.present ? { present: true, kind: cap.state.kind, sha256: cap.state.sha256, length: cap.state.length, pre: pre.rel } : { present: false };
  }

  async function apply(c, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    const bad = validate(c);
    if (bad) return { status: 'refused', name: c && c.name, reason: bad };
    if (c.secret !== undefined && o.mirror !== true) return { status: 'refused', name: c.name, reason: 'mirroring a secret into an environment variable needs its own opt-in (mirror). ' + MIRROR_WARNING };
    const p = await plan(c);
    if (p.status === 'unreadable') return { status: 'failed', name: c.name, reason: 'the current value could not be read: ' + p.reason };
    if (o.apply !== true) return { status: 'dry-run', name: c.name, plan: p };
    if (!C.consentFor(o.consent, c.name)) return { status: 'refused', name: c.name, reason: 'setting ' + c.name + ' needs the user\'s consent' };
    if (p.status === 'same') return { status: 'same', name: c.name, plan: p };
    const want = await wantedSha(c);
    if (!want.sha256) return { status: 'refused', name: c.name, reason: want.error };
    const kind = c.kind || 'String';
    const prior = await capture(c.name, o.txDir);
    if (!prior) return { status: 'failed', name: c.name, reason: 'backup of the prior value failed; nothing written' };
    const entry = C.journalWrite(o, { kind: 'env', name: c.name, scope: 'user', prior, applied: { present: true, kind, sha256: want.sha256 } });
    const w = c.value !== undefined
      ? await op(c.name, 'set', { CC_ENV_KIND: kind }, c.value)
      : await op(c.name, 'set-secret', { CC_ENV_FILE: secrets.file(c.secret), CC_ENV_KIND: kind });
    const back = w.ok ? await read(c.name) : null;
    if (back && back.present && back.sha256 === want.sha256 && back.kind === kind) {
      log('env set ' + c.name + ' ok');
      const res = { status: 'applied', name: c.name, entry, current: C.mask(back) };
      if (c.secret !== undefined) res.warning = MIRROR_WARNING;
      return res;
    }
    const rolledBack = await restorePrior(c.name, prior, o.txDir);
    log('env set ' + c.name + ' failed, rolled back ' + rolledBack);
    return { status: 'failed', name: c.name, reason: w.ok ? 'read-back did not match the value written' : 'write failed: ' + w.error, rolledBack, entry };
  }

  async function unset(name, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!NAME_RE.test(String(name))) return { status: 'refused', name, reason: 'bad variable name' };
    const cur = await read(name);
    if (cur.present === null) return { status: 'failed', name, reason: 'the current value could not be read' };
    if (!cur.present) return { status: 'same', name };
    if (o.apply !== true) return { status: 'dry-run', name, plan: { kind: 'env', name, status: 'remove', current: C.mask(cur) } };
    if (!C.consentFor(o.consent, name)) return { status: 'refused', name, reason: 'removing ' + name + ' needs the user\'s consent' };
    const prior = await capture(name, o.txDir);
    if (!prior) return { status: 'failed', name, reason: 'backup of the prior value failed; nothing removed' };
    const entry = C.journalWrite(o, { kind: 'env', name, scope: 'user', prior, applied: { present: false } });
    const w = await op(name, 'remove');
    if (w.ok && !w.state.present) { log('env remove ' + name + ' ok'); return { status: 'applied', name, entry }; }
    const rolledBack = await restorePrior(name, prior, o.txDir);
    return { status: 'failed', name, reason: 'remove did not read back absent', rolledBack, entry };
  }

  async function revert(entry, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!entry || entry.kind !== 'env' || !NAME_RE.test(String(entry.name)) || !entry.prior) return { status: 'refused', reason: 'not an env journal entry' };
    const action = entry.prior.present ? 'restore the prior value' : 'remove the variable';
    if (o.apply !== true) return { status: 'dry-run', name: entry.name, action };
    const ok = await restorePrior(entry.name, entry.prior, o.txDir);
    log('env revert ' + entry.name + (ok ? ' ok' : ' failed'));
    return ok ? { status: 'reverted', name: entry.name, action } : { status: 'failed', name: entry.name, reason: 'revert did not read back the prior state' };
  }

  return { platform, read, plan, describe, apply, unset, revert, explain };
}

// ------------------------------------------------------------------ engine adapter
// INTEGRATE-1: the synchronous surface installer/profile-tx.js, profile-plan.js,
// profile-verify.js and recover.js call (deps.env), on the same env.ps1 and rules:
//   get(name)               -> {present, kind, sha256, length} (never a value)
//   set(name, {value, kind?} | {secret, kind?})   value on stdin; a secret goes from its
//                              DPAPI file to the registry inside PowerShell
//   unset(name)
//   snapshot(name)          -> {absent: true} | {dpapi, kind, sha256}: the prior value
//                              DPAPI-protected (current user), safe for the tx pre/ folder
//   restore(name, snap)     snap from snapshot(), {absent: true}, or {dpapi} alone (the
//                              recover.ps1 kill-switch record; kind String)
// Every call throws one line on failure; off Windows every call throws "Windows only".
// Selecting the item is the opt-in for a secret mirror here (the engine's high-risk ack
// gate holds it); createEnvAdapter keeps its own opts.mirror switch.
function createAdapter(o) {
  o = o || {};
  const runner = o.runnerSync || C.realRunnerSync;
  const platform = o.platform || process.platform;
  const tmp = o.tmpDir || os.tmpdir();
  let secrets = o.secrets || null;
  const store = () => {
    if (!secrets && o.dataDir) secrets = require('./profile-secrets').createSecretStore({ dataDir: o.dataDir, platform, runner: o.runner });
    return secrets;
  };

  function op(name, which, extra, input) {
    if (C.windowsOnly(platform)) throw new Error('env adapter: Windows only');
    if (!NAME_RE.test(String(name))) throw new Error('bad variable name');
    const env = Object.assign({ CC_ENV_OP: which, CC_ENV_NAME: name }, extra || {});
    const r = runner(C.POWERSHELL, C.psArgs('env.ps1'), { env, input: input === undefined ? '' : input, timeoutMs: 30000 });
    const j = C.parseJsonLine(r.stdout);
    if (r.code !== 0 || !j || j.error) throw new Error('env ' + which + ' ' + name + ' failed: ' + ((j && j.error) || C.firstLine(r.stderr) || 'exit ' + r.code));
    return j.present ? { present: true, kind: j.kind, sha256: j.sha256, length: j.length } : { present: false };
  }

  // A scratch file for one DPAPI hand-over; it holds only protected text and is ours.
  function withFile(fn) {
    const f = path.join(tmp, 'cc-env-' + process.pid + '-' + crypto.randomBytes(6).toString('hex') + '.dpapi');
    try { return fn(f); } finally { try { fs.rmSync(f, { force: true }); } catch (e) { /* scratch */ } }
  }

  const kindOf = (k) => {
    const kind = k || 'String';
    if (!KINDS.includes(kind)) throw new Error('kind must be String or ExpandString');
    return kind;
  };

  function get(name) { return op(name, 'read'); }

  function set(name, v) {
    v = v || {};
    const c = v.secret !== undefined ? { name, secret: v.secret, kind: v.kind } : { name, value: v.value, kind: v.kind };
    const bad = validate(c);
    if (bad) throw new Error('env ' + name + ': ' + bad);
    const kind = kindOf(v.kind);
    if (c.value !== undefined) return op(name, 'set', { CC_ENV_KIND: kind }, c.value);
    const s = store();
    if (!s) throw new Error('env ' + name + ': no secret store');
    const f = s.file(c.secret);
    if (!fs.existsSync(f)) throw new Error('env ' + name + ': secret ' + c.secret + ' is not set');
    return op(name, 'set-secret', { CC_ENV_FILE: f, CC_ENV_KIND: kind });
  }

  function unset(name) {
    const st = op(name, 'remove');
    if (st.present) throw new Error('env ' + name + ' still set after remove');
    return st;
  }

  function snapshot(name) {
    return withFile((f) => {
      const st = op(name, 'capture', { CC_ENV_FILE: f });
      if (!st.present) return { absent: true };
      return { dpapi: fs.readFileSync(f, 'latin1').trim(), kind: st.kind, sha256: st.sha256 };
    });
  }

  function restore(name, snap) {
    if (!snap || snap.absent) return unset(name);
    if (typeof snap.dpapi !== 'string' || !snap.dpapi) throw new Error('env ' + name + ': unsupported snapshot (needs dpapi or absent)');
    const kind = kindOf(snap.kind);
    return withFile((f) => {
      fs.writeFileSync(f, snap.dpapi, 'latin1');
      const st = op(name, 'restore', { CC_ENV_FILE: f, CC_ENV_KIND: kind });
      if (!st.present || (snap.sha256 && st.sha256 !== snap.sha256)) throw new Error('env ' + name + ': restore did not read back');
      return st;
    });
  }

  return { platform, get, set, unset, snapshot, restore };
}

module.exports = { createEnvAdapter, createAdapter, explain, validate, CATALOG, NAME_RE, MIRROR_WARNING };
