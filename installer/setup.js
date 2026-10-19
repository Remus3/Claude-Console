'use strict';
// CON-SHIP-SETUP: the Claude Code commands and settings the console relies on ship in
// console/claude/ (listed in claude/setup.json). Setup runs from the installer
// (`claude-console install --setup` shows the plan), the CLI (`claude-console setup`),
// or a Claude-guided first run (claude/first-run.md). It NEVER edits ~/.claude* silently:
//   - planSetup() is read-only and says, per item, new / same / differs / conflict /
//     unreadable / runtime, the target path and the exact settings keys;
//   - applySetup() writes only with confirm === true, only the selected items, never
//     over a user's different file unless force/replace was asked, and backs the old
//     file up first; an unreadable settings.json is never written.
// The pane hooks stay runtime-only: an additive per-pane --settings file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, exists, writeJsonAtomic } = require('./fsutil');
const { stamp } = require('./paths');

const SPEC = path.join('claude', 'setup.json');

function loadSpec(consoleRoot) {
  const s = readJson(path.join(consoleRoot, SPEC), null);
  if (!s || !Array.isArray(s.items)) throw new Error('no ' + SPEC);
  return s;
}

function configDirFor(env, home) {
  env = env || process.env;
  if (env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR;
  return path.join(home || os.homedir(), '.claude');
}

function fill(v, vars) {
  if (typeof v === 'string') return v.replace(/\{(console|node|statusline)\}/g, (m, k) => vars[k]);
  if (Array.isArray(v)) return v.map((x) => fill(x, vars));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, vars)]));
  return v;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// o: consoleRoot, configDir, nodePath, only (ids), force (commands), replace (settings)
function planSetup(o) {
  const spec = loadSpec(o.consoleRoot);
  // An installed console points the status line at the install home's shim (rewritten
  // on every update, so the settings line never goes stale); a checkout at its own file.
  const fwd = (p) => String(p).replace(/\\/g, '/');
  const vars = {
    console: fwd(path.resolve(o.consoleRoot)),
    node: fwd(o.nodePath || process.execPath),
    statusline: fwd(o.statuslinePath || path.join(path.resolve(o.consoleRoot), 'statusline', 'statusline.js')),
  };
  const only = Array.isArray(o.only) && o.only.length ? new Set(o.only) : null;
  const settingsFile = path.join(o.configDir, 'settings.json');
  let current;
  let unreadable = false;
  if (exists(settingsFile)) {
    try { current = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) { unreadable = true; }
    if (!unreadable && (!current || typeof current !== 'object' || Array.isArray(current))) unreadable = true;
  }
  current = current || {};
  const actions = [];
  for (const it of spec.items) {
    const wanted = only ? only.has(it.id) : it.default === true;
    const a = { id: it.id, kind: it.kind, why: it.why, wanted };
    if (it.kind === 'runtime') {
      Object.assign(a, { status: 'runtime', selected: false, target: null });
    } else if (it.kind === 'command') {
      const src = path.join(o.consoleRoot, ...it.src.split('/'));
      const target = path.join(o.configDir, 'commands', it.name + '.md');
      const body = fs.readFileSync(src);
      let status = 'new';
      if (exists(target)) status = Buffer.compare(fs.readFileSync(target), body) === 0 ? 'same' : 'differs';
      Object.assign(a, { src, target, status, selected: wanted && (status === 'new' || (status === 'differs' && !!o.force)) });
    } else if (it.kind === 'settings') {
      const add = fill(it.settings, vars);
      let status;
      if (unreadable) status = 'unreadable';
      else {
        const keys = Object.keys(add);
        const differ = keys.filter((k) => k in current && !same(current[k], add[k]));
        const missing = keys.filter((k) => !(k in current));
        status = differ.length ? 'conflict' : missing.length ? 'new' : 'same';
        a.current = Object.fromEntries(keys.filter((k) => k in current).map((k) => [k, current[k]]));
      }
      Object.assign(a, { target: settingsFile, add, status, selected: wanted && (status === 'new' || (status === 'conflict' && !!o.replace)) });
    } else {
      Object.assign(a, { status: 'unknown', selected: false });
    }
    actions.push(a);
  }
  return { configDir: o.configDir, settingsFile, actions };
}

function backupOf(file, now) {
  const b = file + '.bak-' + stamp(now);
  fs.copyFileSync(file, b);
  return b;
}

function applySetup(plan, o) {
  if (!o || o.confirm !== true) throw new Error('setup writes only with an explicit confirm');
  const written = [];
  const backups = [];
  for (const a of plan.actions) {
    if (!a.selected) continue;
    if (a.kind === 'command') {
      fs.mkdirSync(path.dirname(a.target), { recursive: true });
      if (exists(a.target)) backups.push(backupOf(a.target, o.now));
      fs.copyFileSync(a.src, a.target);
      written.push({ id: a.id, target: a.target });
    } else if (a.kind === 'settings') {
      let cur = {};
      if (exists(a.target)) {
        try { cur = JSON.parse(fs.readFileSync(a.target, 'utf8')); } catch (e) { continue; } // never write over what we cannot read
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) continue;
        backups.push(backupOf(a.target, o.now));
      }
      writeJsonAtomic(a.target, Object.assign({}, cur, a.add));
      written.push({ id: a.id, target: a.target, keys: Object.keys(a.add) });
    }
  }
  return { written, backups };
}

function planLines(plan) {
  const lines = ['Claude setup plan for ' + plan.configDir + ' (nothing written yet)'];
  for (const a of plan.actions) {
    lines.push(a.status.padEnd(10) + ' ' + a.id + (a.selected ? ' [will apply]' : '') + (a.target ? '  -> ' + a.target : '') + '  - ' + a.why);
    if (a.kind === 'settings' && a.add) lines.push('           adds ' + JSON.stringify(a.add) + (a.current && Object.keys(a.current).length ? '; current ' + JSON.stringify(a.current) : ''));
  }
  return lines;
}

// The shim path when this console runs from the install home's app dir, else null.
function statuslineFor(L, consoleRoot) {
  const app = path.resolve(L.appRoot).toLowerCase() + path.sep;
  return path.resolve(consoleRoot).toLowerCase().startsWith(app) ? path.join(L.home, 'statusline.js') : null;
}

// CON-013: once the shipped setup profile has its `console` module, `claude-console setup`
// is `profile apply --only console --target user` (same dry-run default, same --apply
// --yes gate, journaled and revertable). The old setup.json ids map onto the profile items.
const LEGACY_IDS = { 'cmd-done': 'console-done-chip', statusline: 'console-statusline-basic', 'pane-hooks': 'console-pane-hooks' };

function profileRoute(consoleRoot, deps) {
  if (deps.legacySetup) return null;
  const dir = deps.profileDir || path.join(consoleRoot, 'profile');
  const pj = readJson(path.join(dir, 'profile.json'), null);
  return pj && Array.isArray(pj.modules) && pj.modules.includes('console') ? dir : null;
}

function profileArgs(a, only) {
  const args = ['apply', '--target', 'user', '--only', only.join(',')];
  if (a['config-dir'] && a['config-dir'] !== true) args.push('--config-dir', a['config-dir']);
  if (a.apply) args.push('--apply');
  if (a.yes === true) args.push('--yes');
  if (a.json) args.push('--json');
  return args;
}

async function cliSetup(a, L, deps, emit, out) {
  const consoleRoot = deps.consoleRoot || path.resolve(__dirname, '..');
  const routed = profileRoute(consoleRoot, deps);
  if (routed) {
    const ids = typeof a.only === 'string' ? a.only.split(',').map((s) => s.trim()).filter(Boolean).map((id) => LEGACY_IDS[id] || id) : ['console'];
    return require('./profile-cli').cliProfile(profileArgs(a, ids), L, Object.assign({}, deps, { out, profileDir: routed }));
  }
  const configDir = a['config-dir'] && a['config-dir'] !== true ? path.resolve(a['config-dir']) : configDirFor(process.env);
  const only = typeof a.only === 'string' ? a.only.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const plan = planSetup({ consoleRoot, configDir, nodePath: deps.nodePath, only, force: !!a.force, replace: !!a.replace, statuslinePath: statuslineFor(L, consoleRoot) });
  if (!a.apply) {
    emit(plan, planLines(plan).concat(['apply with: claude-console setup --apply --yes [--only ' + plan.actions.filter((x) => x.kind !== 'runtime').map((x) => x.id).join(',') + ']']));
    return 0;
  }
  if (a.yes !== true) {
    out('setup --apply writes into ' + configDir + '; add --yes after reviewing the plan');
    return 1;
  }
  const res = applySetup(plan, { confirm: true });
  emit(res, ['written: ' + (res.written.map((x) => x.id + ' -> ' + x.target).join(', ') || 'nothing')].concat(res.backups.map((b) => 'backup: ' + b)));
  return 0;
}

module.exports = { loadSpec, configDirFor, planSetup, applySetup, planLines, cliSetup, statuslineFor, LEGACY_IDS, profileRoute };
