'use strict';
// CON-USAGE: the top-bar usage strip's slot toggles, kept server side in
// data/usage.local.json so they survive restarts (the page caches them in browser
// storage only as a fallback). Booleans only; unknown keys are dropped.
const path = require('path');
const { readJson } = require('./config');

const USAGE_KEYS = ['w7d', 'w5h', 'fable', 'acc1', 'acc2', 'acc3', 'api', 'extra'];
// Acc 3 starts hidden: no third account is configured yet (it shows '--' when
// switched on), and the full strip then fits a 1366 px top bar.
const DEFAULT_USAGE_PREFS = Object.freeze(USAGE_KEYS.reduce((o, k) => { o[k] = k !== 'acc3'; return o; }, {}));

function sanitizeUsagePrefs(obj, base) {
  const out = Object.assign({}, DEFAULT_USAGE_PREFS, base || {});
  const src = obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  for (const k of USAGE_KEYS) if (typeof src[k] === 'boolean') out[k] = src[k];
  for (const k of Object.keys(out)) if (!USAGE_KEYS.includes(k)) delete out[k];
  return out;
}

function usageFile(dataDir) {
  return path.join(dataDir, 'usage.local.json');
}

function readUsagePrefs(dataDir) {
  const j = readJson(usageFile(dataDir), {}) || {};
  return sanitizeUsagePrefs(j.slots);
}

function writeUsagePrefs(dataDir, patch, writeJsonAtomic) {
  const next = sanitizeUsagePrefs(patch, readUsagePrefs(dataDir));
  writeJsonAtomic(usageFile(dataDir), { slots: next });
  return next;
}

module.exports = { USAGE_KEYS, DEFAULT_USAGE_PREFS, sanitizeUsagePrefs, readUsagePrefs, writeUsagePrefs, usageFile };
