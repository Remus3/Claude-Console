'use strict';
// Config loading: config/console.json merged with data/console.local.json.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = Object.assign({}, base);
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(1));
  return p;
}

// CON-PUBLIC B: an installed console keeps user data OUTSIDE its code dir. The launcher
// (bin/claude-console.js start) sets these to <install home>\data, run and drops; a
// checkout run (launch.vbs / launch.cmd) sets none and keeps console/data, run, drops.
// Explicit opts always win (tests pass their own dirs).
function envDir(env, name) {
  const v = env && env[name];
  return typeof v === 'string' && v && path.isAbsolute(v) ? v : null;
}

function loadConfig(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const baseFile = opts.configFile || path.join(ROOT, 'config', 'console.json');
  const fromEnv = !opts.dataDir && !opts.runDir;
  const dataDir = opts.dataDir || (fromEnv && envDir(env, 'CLAUDE_CONSOLE_DATA')) || path.join(ROOT, 'data');
  const localFile = path.join(dataDir, 'console.local.json');
  let cfg = readJson(baseFile, {});
  cfg = deepMerge(cfg, readJson(localFile, {}));
  if (opts.overrides) cfg = deepMerge(cfg, opts.overrides);
  cfg.dataDir = dataDir;
  cfg.runDir = opts.runDir || (fromEnv && envDir(env, 'CLAUDE_CONSOLE_RUN')) || path.join(ROOT, 'run');
  const drops = fromEnv && envDir(env, 'CLAUDE_CONSOLE_DROPS');
  if (drops && !cfg.dropsDir) cfg.dropsDir = drops;
  cfg.root = ROOT;
  cfg.quotaStateFile = expandHome(cfg.quotaStateFile || '~/.config/claude-quota.state.json');
  return cfg;
}

// FB-1021: the configured accounts' setup problems, words only (never a path), keyed by
// account id. configDir null is the default ~/.claude, which belongs to the FIRST account;
// a later account with null (or with the same dir as an earlier one) is the same login,
// so its quota and settings would land on that one. o: {home, exists} for tests.
function accountDir(a, first, home) {
  if (a && typeof a.configDir === 'string' && a.configDir) return path.resolve(a.configDir);
  return first ? path.join(home, '.claude') : null;
}

function accountProblems(accounts, o) {
  o = o || {};
  const home = o.home || os.homedir();
  const exists = o.exists || fs.existsSync;
  const out = {};
  const dirs = new Map();
  const labels = new Map();
  Object.entries(accounts || {}).forEach(([id, a], i) => {
    if (!isPlainObject(a)) return;
    const p = [];
    const d = accountDir(a, i === 0, home);
    const key = d ? d.toLowerCase() : null;
    if (!d) p.push('dir missing, create + log in');
    else if (dirs.has(key)) p.push('same config dir as ' + dirs.get(key) + ' (one login)');
    else if (i > 0 && !exists(d)) p.push('dir missing, create + log in');
    if (key && !dirs.has(key)) dirs.set(key, id);
    const lb = String(a.label || id).trim().toLowerCase();
    if (labels.has(lb)) p.push('same label as ' + labels.get(lb));
    else labels.set(lb, id);
    if (p.length) out[id] = p.join('; ');
  });
  return out;
}

// The accounts other than `primaryId` that have a config dir of their own (no problem
// above): {id: {dir, label}}. The setup profile applies user-scope settings to each.
function extraAccountDirs(accounts, primaryId, o) {
  o = o || {};
  const home = o.home || os.homedir();
  const probs = accountProblems(accounts, o);
  const ids = Object.keys(accounts || {});
  const prim = accounts && accounts[primaryId] ? accountDir(accounts[primaryId], ids.indexOf(primaryId) === 0, home) : null;
  const out = {};
  ids.forEach((id, i) => {
    const a = accounts[id];
    if (id === primaryId || !isPlainObject(a) || probs[id]) return;
    const d = accountDir(a, i === 0, home);
    if (!d || (prim && d.toLowerCase() === prim.toLowerCase())) return;
    out[id] = { dir: d, label: a.label || id };
  });
  return out;
}

module.exports = { loadConfig, readJson, deepMerge, expandHome, accountProblems, extraAccountDirs, ROOT };
