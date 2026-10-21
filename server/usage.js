'use strict';
// CON-USAGE: the top-bar usage strip's slot toggles, kept server side in
// data/usage.local.json so they survive restarts (the page caches them in browser
// storage only as a fallback). Booleans only; unknown keys are dropped.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson } = require('./config');

const USAGE_KEYS = ['w7d', 'w5h', 'fable', 'acc1', 'acc2', 'acc3', 'api', 'extra'];
// FB-1021: a fresh strip shows the author's live slots only (7d window, Acc 1, Acc 2);
// the 5h and model windows, Acc 3, API spend and Extra Usage start hidden and are
// switched on from the strip menu. Acc 2 also starts hidden when no second account
// with its own config dir is configured (defaultsFor).
const DEFAULT_ON = ['w7d', 'acc1', 'acc2'];
const DEFAULT_USAGE_PREFS = Object.freeze(USAGE_KEYS.reduce((o, k) => { o[k] = DEFAULT_ON.includes(k); return o; }, {}));

// True when an account after the first has a config dir of its own that exists.
// configDir null means the default ~/.claude, so two null entries are one login.
function hasSecondAccount(accounts, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const exists = o.exists || fs.existsSync;
  const norm = (d) => path.resolve(d || path.join(home, '.claude')).toLowerCase();
  const list = Object.values(accounts || {}).filter((a) => a && typeof a === 'object');
  if (list.length < 2) return false;
  const seen = new Set([norm(list[0].configDir)]);
  for (const a of list.slice(1)) {
    const d = norm(a.configDir);
    if (!seen.has(d) && a.configDir && exists(d)) return true;
    seen.add(d);
  }
  return false;
}

function defaultsFor(accounts, opts) {
  const out = Object.assign({}, DEFAULT_USAGE_PREFS);
  if (accounts && !hasSecondAccount(accounts, opts)) out.acc2 = false;
  return out;
}

function sanitizeUsagePrefs(obj, base, defaults) {
  const out = Object.assign({}, defaults || DEFAULT_USAGE_PREFS, base || {});
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const k of USAGE_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k];
  for (const k of Object.keys(out)) if (!USAGE_KEYS.includes(k)) delete out[k];
  return out;
}

function usageFile(dataDir) {
  return path.join(dataDir, 'usage.local.json');
}

// accounts (optional): the configured accounts, so Acc 2 defaults off without a second login.
function readUsagePrefs(dataDir, accounts) {
  const j = readJson(usageFile(dataDir), {}) || {};
  return sanitizeUsagePrefs(j.slots, null, defaultsFor(accounts));
}

function writeUsagePrefs(dataDir, patch, writeJsonAtomic, accounts) {
  const next = sanitizeUsagePrefs(patch, readUsagePrefs(dataDir, accounts));
  writeJsonAtomic(usageFile(dataDir), { slots: next });
  return next;
}

module.exports = { USAGE_KEYS, DEFAULT_ON, DEFAULT_USAGE_PREFS, hasSecondAccount, defaultsFor, sanitizeUsagePrefs, readUsagePrefs, writeUsagePrefs, usageFile };
