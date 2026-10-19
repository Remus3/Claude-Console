'use strict';
// CON-013 L4: headless route setup for the setup profile (wizard steps 6 and 7).
// Windows only (Q10). Rules carried over from the headless-route ruling:
// - Single account is the default (Q7): {"mode": "single"} names the account folder;
//   split = a second account behind a loopback proxy the user runs (no proxy is
//   named or shipped).
// - The kill-switch variable CLAUDE_HEADLESS_BASE_URL is REQUIRED in both modes
//   (Q8): every headless run checks it; deleting it stops every next run. It is set
//   through the env adapter (value on stdin, journalled, revertable).
// - The route file is written ONLY by the kit's own CLI (`kit_headless.py route set
//   ...`), never by this module; `route show` is read back after every set. The
//   account folder comes from the console's own account list, never free text, and
//   is never logged.
// - An armed fallback needs the typed acknowledgement "apply hl-fallback-armed".
// - A second account is the user's own OAuth login: this module only returns the
//   pane command (CLAUDE_CONFIG_DIR=<dir> claude) and checks that a login exists.
const fs = require('fs');
const path = require('path');
const C = require('./profile-oscommon');

const KILL_VAR = 'CLAUDE_HEADLESS_BASE_URL';
const MODES = ['single', 'split'];
const FALLBACK_ACK = 'apply hl-fallback-armed';
const CREDENTIALS = '.credentials.json';
const URL_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):([0-9]{2,5})\/?$/;

function explainKillSwitch() {
  return KILL_VAR + ' is the headless kill switch. Every headless run checks it first, with one account or two. Delete this variable and every next headless run is refused; set it again to resume.';
}

function checkUrl(url) {
  if (typeof url !== 'string' || !url) return KILL_VAR + ' (the kill switch) is required in both modes, single included: give its loopback URL';
  const m = URL_RE.exec(url);
  if (!m || +m[2] < 1 || +m[2] > 65535) return 'the kill-switch URL must be plain http to a loopback host with a port (http://127.0.0.1:<port>)';
  return null;
}

function createRouteAdapter(opts) {
  opts = opts || {};
  const runner = opts.runner || C.realRunner;
  const env = opts.env;
  if (!env) throw new Error('env adapter required');
  const platform = opts.platform || process.platform;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const exists = opts.exists || fs.existsSync;
  const accounts = opts.accounts || (() => []);
  const python = opts.python;
  const kitHeadless = opts.kitHeadless;

  const norm = (d) => path.win32.normalize(String(d)).replace(/\\+$/, '').toLowerCase();

  function checkAccount(dir) {
    if (typeof dir !== 'string' || !dir) return 'single mode needs an account folder from the account list';
    if (!path.win32.isAbsolute(dir)) return 'the account folder must be an absolute path';
    if (!(accounts() || []).some((a) => norm(a) === norm(dir))) return 'choose the account folder from the console\'s account list';
    if (!exists(path.join(dir, CREDENTIALS))) return 'that account folder has no login yet: open a pane for it and log in first';
    return null;
  }

  async function plan(input) {
    input = input || {};
    const mode = input.mode === undefined ? 'single' : input.mode;
    const errors = [];
    if (!MODES.includes(mode)) errors.push('mode must be single or split');
    const u = checkUrl(input.baseUrl);
    if (u) errors.push(u);
    const fb = input.fallback === undefined || input.fallback === null ? null : input.fallback;
    const dirRoute = mode === 'single' ? 'single' : fb === 'single' ? 'single-fallback' : null;
    if (dirRoute) {
      const a = checkAccount(input.configDir);
      if (a) errors.push(a);
    } else if (input.configDir !== undefined && input.configDir !== null) errors.push('split mode takes no account folder (the proxy decides the account)');
    if (fb !== null) {
      if (!MODES.includes(fb) || fb === mode) errors.push('the fallback must be the other route');
      if (input.ack !== FALLBACK_ACK) errors.push('an armed fallback needs the typed acknowledgement "' + FALLBACK_ACK + '"');
    }
    const routeArgs = ['route', 'set', mode].concat(dirRoute ? ['--config-dir', input.configDir] : []).concat(fb ? ['--fallback', fb] : []);
    return {
      ok: !errors.length, mode, fallback: fb, errors, routeArgs,
      steps: [
        { kind: 'env', name: KILL_VAR, does: explainKillSwitch() },
        { kind: 'route', does: mode === 'single' ? 'Headless runs use the named account folder, no proxy.' : 'Headless runs go through your loopback proxy to the second account.' },
      ],
    };
  }

  async function kit(args) {
    if (!python || !kitHeadless) return { ok: false, error: 'the kit is not installed (no kit_headless.py)' };
    const r = await runner(python, [kitHeadless].concat(args), { timeoutMs: 30000 });
    const j = C.parseJsonLine(r.stdout);
    if (!j) return { ok: false, code: r.code, error: C.firstLine(r.stderr) || 'no answer from the kit CLI' };
    return { ok: r.code === 0 && j.valid === true, code: r.code, doc: j, error: j.error ? (j.code ? j.code + ': ' : '') + j.error : j.reason || null };
  }

  async function show() {
    const r = await kit(['route', 'show']);
    const d = r.doc || {};
    return { valid: d.valid === true, mode: d.valid === true ? d.mode : null, fallback: d.fallback || null };
  }

  async function apply(input, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    const p = await plan(input);
    if (!p.ok) return { status: 'refused', reason: p.errors.join('; '), plan: p };
    const prior = await show();
    if (o.apply !== true) return { status: 'dry-run', plan: p, current: { mode: prior.mode, valid: prior.valid } };
    if (!(o.consent === true || (Array.isArray(o.consent) && o.consent.includes('headless-route')))) return { status: 'refused', reason: 'the headless route needs the user\'s consent' };
    const envOpts = Object.assign({}, o, { consent: true });
    const e = await env.apply({ name: KILL_VAR, value: input.baseUrl, scope: 'user' }, envOpts);
    if (e.status !== 'applied' && e.status !== 'same') return { status: 'failed', reason: 'kill-switch variable: ' + (e.reason || e.status) };
    const entry = C.journalWrite(o, { kind: 'route', prior, applied: { mode: p.mode, fallback: p.fallback } });
    const s = await kit(p.routeArgs);
    const back = s.ok ? await show() : null;
    if (back && back.valid && back.mode === p.mode && back.fallback === p.fallback) {
      log('route set ' + p.mode + (p.fallback ? ' fallback ' + p.fallback : '') + ' ok');
      return { status: 'applied', mode: p.mode, fallback: p.fallback, entry, envEntry: e.entry || null };
    }
    let rolledBack = true;
    if (e.status === 'applied' && e.entry) rolledBack = (await env.revert(e.entry, envOpts)).status === 'reverted';
    log('route set ' + p.mode + ' failed');
    return { status: 'failed', reason: 'route set refused or did not read back: ' + (s.error || 'mismatch'), rolledBack, entry };
  }

  async function revert(entry, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!entry || entry.kind !== 'route' || !entry.prior) return { status: 'refused', reason: 'not a route journal entry' };
    const pr = entry.prior;
    if (!pr.valid) return { status: 'kept', reason: 'there was no valid route before; the kit CLI never deletes it. Delete ' + KILL_VAR + ' to stop every headless run.' };
    const needDir = pr.mode === 'single' || pr.fallback === 'single';
    if (needDir) {
      const a = checkAccount(o.configDir);
      if (a) return { status: 'refused', reason: 'restoring the prior single route needs its account folder: ' + a };
    }
    const args = ['route', 'set', pr.mode].concat(needDir ? ['--config-dir', o.configDir] : []).concat(pr.fallback ? ['--fallback', pr.fallback] : []);
    if (o.apply !== true) return { status: 'dry-run', action: 'route set ' + pr.mode };
    const s = await kit(args);
    const back = s.ok ? await show() : null;
    const ok = !!back && back.valid && back.mode === pr.mode && back.fallback === pr.fallback;
    log('route revert ' + pr.mode + (ok ? ' ok' : ' failed'));
    return ok ? { status: 'reverted', mode: pr.mode } : { status: 'failed', reason: 'route revert did not read back: ' + (s.error || 'mismatch') };
  }

  const killSwitch = {
    explain: explainKillSwitch,
    async status() {
      const s = await env.read(KILL_VAR);
      return { name: KILL_VAR, armed: s.present === true, display: C.mask(s) };
    },
    off(o) { return env.unset(KILL_VAR, o); },
    async on(url, o) {
      const u = checkUrl(url);
      if (u) return { status: 'refused', reason: u };
      return env.apply({ name: KILL_VAR, value: url, scope: 'user' }, o);
    },
  };

  function secondAccount(dir) {
    if (typeof dir !== 'string' || !path.win32.isAbsolute(dir)) throw new Error('the account folder must be an absolute path');
    return {
      dir,
      ready: !!exists(path.join(dir, CREDENTIALS)),
      login: { exe: 'claude', args: [], env: { CLAUDE_CONFIG_DIR: dir } },
      note: 'Open a console pane with this account folder and log in yourself; the console never asks for a password or token.',
    };
  }

  return { plan, show, apply, revert, killSwitch, secondAccount };
}

module.exports = { createRouteAdapter, explainKillSwitch, checkUrl, KILL_VAR, FALLBACK_ACK, MODES };
