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

module.exports = { loadConfig, readJson, deepMerge, expandHome, ROOT };
