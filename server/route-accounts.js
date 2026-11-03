'use strict';
// KIT-ROUTE-ACCOUNTS (kit v26, kit ruling 2026-10-31):
// the headless route is an ordered list of 1 to 3 accounts. Pure helpers for the
// console's Headless picker (server side): map the console's own accounts to kit
// entries, build the ONE kit CLI argv (`route set --account ... --fallback|--no-fallback`),
// read the LIVE route file back to console account ids, and tell whether a list
// needs the v2 file (offered only while every live tree runs kit >= 26).
// A pin (proxy account uuid) and a config dir never leave the server: answers carry
// account ids, labels, positions and via only.
const fs = require('fs');
const path = require('path');

const MAX = 3;
const V2_FROM = 26;
const PIN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// One console account -> one kit entry. headlessProxy = the variable's own pin (bare
// proxy entry); headlessPin = a proxy pin by uuid (from data/console.local.json, never
// shown); otherwise the account's own config dir (allowed; shares the interactive
// login's token family, decision 6).
function entryOf(acct, dir) {
  if (acct && acct.headlessProxy === true) return { via: 'proxy' };
  if (acct && typeof acct.headlessPin === 'string' && PIN_RE.test(acct.headlessPin)) return { via: 'proxy', pin: acct.headlessPin.toLowerCase() };
  return { via: 'config', dir };
}

// ids (ordered) -> { entries, error }. Every id must be a configured account, no repeats,
// 1..MAX of them.
function entriesFor(ids, accounts, acctDir) {
  if (!Array.isArray(ids) || ids.length < 1) return { entries: [], error: 'choose the headless lane account first' };
  if (ids.length > MAX) return { entries: [], error: 'at most ' + MAX + ' headless accounts' };
  const own = (id) => typeof id === 'string' && !!accounts && Object.prototype.hasOwnProperty.call(accounts, id) && !!accounts[id];
  if (!ids.every(own)) return { entries: [], error: 'a headless account is not configured' };
  if (new Set(ids).size !== ids.length) return { entries: [], error: 'an account is listed twice' };
  const entries = ids.map((id) => entryOf(accounts[id], acctDir(id)));
  const keys = entries.map((e) => (e.via === 'proxy' ? 'p:' + (e.pin || '') : 'c:' + path.resolve(e.dir).toLowerCase()));
  if (new Set(keys).size !== keys.length) return { entries: [], error: 'two picks bill the same account' };
  return { entries, error: null };
}

// The kit writes version 1 whenever v1 can say it (one entry, or two of different via
// with no pin); anything else needs the v2 file.
function needsV2(entries) {
  if (entries.some((e) => e.pin)) return true;
  if (entries.length === 1) return false;
  if (entries.length === 2) return entries[0].via === entries[1].via;
  return true;
}

function argvFor(entries, armed) {
  const out = ['route', 'set'];
  for (const e of entries) out.push('--account', e.via === 'proxy' ? (e.pin ? 'proxy:' + e.pin : 'proxy') : 'config:' + e.dir);
  out.push(armed ? '--fallback' : '--no-fallback');
  return out;
}

// The live route file -> { version, entries: [{ via, pinned, id }], armed } with each entry
// mapped to the console account it bills (id null = outside the console list). Null when
// the file is missing or unreadable (the kit's route show says why).
function liveRoute(routeFile, accounts, acctDir) {
  let doc = null;
  try { const t = fs.readFileSync(routeFile, 'utf8'); if (t.length < 16384) doc = JSON.parse(t); } catch (e) { doc = null; }
  if (!doc || typeof doc !== 'object') return null;
  let raw = [];
  let armed = false;
  if (doc.version === 1) {
    raw.push(doc.mode === 'single' ? { via: 'config', config_dir: doc.config_dir } : { via: 'proxy' });
    if (doc.fallback && typeof doc.fallback === 'object') {
      raw.push(doc.fallback.mode === 'single' ? { via: 'config', config_dir: doc.fallback.config_dir } : { via: 'proxy' });
      armed = doc.fallback.armed === true;
    }
  } else if (doc.version === 2 && Array.isArray(doc.accounts)) {
    raw = doc.accounts.slice(0, MAX);
    armed = !!(doc.fallback && doc.fallback.armed === true);
  } else return null;
  const ids = Object.keys(accounts || {});
  const entries = raw.map((e) => {
    const x = e && typeof e === 'object' ? e : {};
    let id = null;
    if (x.via === 'config') id = ids.find((k) => samePath(acctDir(k), x.config_dir)) || null;
    else if (x.via === 'proxy' && typeof x.pin === 'string') id = ids.find((k) => accounts[k] && typeof accounts[k].headlessPin === 'string' && accounts[k].headlessPin.toLowerCase() === x.pin.toLowerCase()) || null;
    else if (x.via === 'proxy') id = ids.find((k) => accounts[k] && accounts[k].headlessProxy === true) || null;
    return { via: x.via === 'config' ? 'config' : 'proxy', pinned: typeof x.pin === 'string', id };
  });
  return { version: doc.version, entries, armed };
}

// Lowest vendored kit version over the live sibling trees of the supervisor's roster
// (ops/fleet_roster.json); null when unreadable (then v2 picks stay refused).
function fleetKitMin(mainRoot) {
  try {
    const roster = JSON.parse(fs.readFileSync(path.join(mainRoot, 'ops', 'fleet_roster.json'), 'utf8'));
    let min = null;
    for (const r of roster.repos || []) {
      if (!r || r.retired || samePath(r.root, mainRoot) || typeof r.root !== 'string') continue;
      const m = JSON.parse(fs.readFileSync(path.join(r.root, 'ops', 'fleet_kit', 'MANIFEST.json'), 'utf8'));
      const v = Number(m.version);
      if (!Number.isFinite(v)) return null;
      min = min === null ? v : Math.min(min, v);
    }
    return min;
  } catch (e) {
    return null;
  }
}

module.exports = { MAX, V2_FROM, PIN_RE, entryOf, entriesFor, needsV2, argvFor, liveRoute, fleetKitMin };
