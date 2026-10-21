'use strict';
// Network policy (CON-013 L3, addendum e.1). The console makes exactly two kinds of
// network call: the update check / download (GitHub releases) and calls the user starts
// (a page opened in the browser after a click). egress.json freezes the allowed hosts and
// the per-file baseline of network-capable code; L6's no-egress tests read both.
//   check(url, kind)  - throws unless url's host is allowed for kind ('update' |
//                       'browser' | 'credits'); loopback is always allowed for kind
//                       'loopback'. A host marked optIn (CON-API-PUBLIC: the credits
//                       reader's api.anthropic.com) is refused until setOptIn(kind, true).
//   setOptIn(kind, on) - the user's opt-in for an optIn host kind; off at load (fail
//                       closed), set by the server from console.local.json.
//   note(url, kind)   - one egress log line {at, host, kind, allowed} (no path, no query)
//                       into the in-memory ring and, after setLog(file), that file.
//   installGuard(o)   - test hook: wraps http/https.request+get, net.connect /
//                       createConnection, tls.connect, dgram.createSocket and global fetch
//                       to record every attempt and refuse a non-allowed one. Returns
//                       {attempts, restore()}.
//   scanText(text)    - static hits (module requires, fetch / WebSocket / XHR,
//                       PowerShell web cmdlets, URL literals) for the static test.
const fs = require('fs');
const path = require('path');

const POLICY_FILE = path.join(__dirname, 'egress.json');
let policyCache = null;
function policy() {
  if (!policyCache) policyCache = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
  return policyCache;
}

function hostOf(u) {
  if (u && typeof u === 'object' && !(u instanceof URL)) return String(u.hostname || u.host || 'localhost').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  try { return new URL(String(u)).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch (e) { return null; }
}

function isLoopback(host) { return !!host && (policy().loopback || []).includes(host); }

// Kinds the user turned on (optIn hosts only). Empty at load: an optIn host is refused.
const optIns = new Set();
function setOptIn(kind, on) { if (on) optIns.add(String(kind)); else optIns.delete(String(kind)); }

// kind: 'update' (the update check / download), 'browser' (opened after a click),
// 'credits' (opt-in API spend reader), 'loopback' (server, panes, the user's own
// headless proxy).
function allowed(url, kind) {
  const host = hostOf(url);
  if (!host) return false;
  if (isLoopback(host)) return kind === 'loopback' || kind === undefined;
  if (kind === 'update' && !/^https:/i.test(typeof url === 'string' ? url : String(url && url.href || 'https:'))) return false;
  return (policy().hosts || []).some((h) => h.host === host && h.kind === kind && (!h.optIn || optIns.has(kind)));
}

const ring = [];
let logFile = null;
function setLog(file) { logFile = file || null; }
function log() { return ring.slice(); }
function note(url, kind, ok) {
  const e = { at: new Date().toISOString(), host: hostOf(url), kind: kind || null, allowed: ok === undefined ? allowed(url, kind) : !!ok };
  ring.push(e);
  if (ring.length > 500) ring.shift();
  if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify(e) + '\n'); } catch (x) { /* best effort */ } }
  return e;
}

function check(url, kind) {
  const ok = allowed(url, kind);
  note(url, kind, ok);
  if (!ok) throw new Error('egress refused: ' + (hostOf(url) || '?') + ' is not an allowed ' + kind + ' host');
  return true;
}

// ------------------------------------------------------------------ runtime guard (tests)

function installGuard(o) {
  o = o || {};
  const http = require('http');
  const https = require('https');
  const net = require('net');
  const tls = require('tls');
  const dgram = require('dgram');
  const attempts = [];
  const saved = [];
  const permit = o.permit || ((host, via) => isLoopback(host) || (o.allowUpdate && allowed('https://' + host + '/', 'update')));
  const gate = (via, host) => {
    const ok = !!host && !!permit(host, via);
    attempts.push({ via, host, allowed: ok });
    if (!ok) throw new Error('egress refused by the test guard: ' + via + ' ' + host);
  };
  // One record per outward call: http.get -> http.request -> net.createConnection is one
  // attempt, so calls made while a guarded call runs pass straight through.
  let depth = 0;
  const wrap = (obj, name, hostFn) => {
    const orig = obj[name];
    saved.push([obj, name, orig]);
    obj[name] = function guarded(...args) {
      if (depth > 0) return orig.apply(this, args);
      gate(name, hostFn(args));
      depth++;
      try { return orig.apply(this, args); } finally { depth--; }
    };
  };
  const reqHost = (args) => (typeof args[0] === 'string' || args[0] instanceof URL ? hostOf(args[0]) : hostOf(args[0] || {}));
  wrap(http, 'request', reqHost);
  wrap(http, 'get', reqHost);
  wrap(https, 'request', reqHost);
  wrap(https, 'get', reqHost);
  const connHost = (args) => {
    const a = args[0];
    if (a && typeof a === 'object') return a.path ? 'localhost' : hostOf({ hostname: a.host || 'localhost' });
    if (typeof a === 'string' && !/^\d+$/.test(a)) return 'localhost'; // a named pipe / socket path
    return hostOf({ hostname: typeof args[1] === 'string' ? args[1] : 'localhost' });
  };
  wrap(net, 'connect', connHost);
  wrap(net, 'createConnection', connHost);
  wrap(tls, 'connect', connHost);
  wrap(dgram, 'createSocket', () => '(udp)');
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    saved.push([globalThis, 'fetch', origFetch]);
    globalThis.fetch = function guardedFetch(u, init) { gate('fetch', hostOf(typeof u === 'object' && u && u.url ? u.url : u)); return origFetch.call(this, u, init); };
  }
  return { attempts, restore() { for (const [obj, name, orig] of saved.reverse()) obj[name] = orig; saved.length = 0; } };
}

// ------------------------------------------------------------------ static scan

const SCAN = [
  ['module', /require\(\s*['"](http|https|net|tls|dgram)['"]\s*\)/g],
  ['fetch', /\bfetch\(/g],
  ['websocket', /\bnew\s+WebSocket\(/g],
  ['xhr', /\bXMLHttpRequest\b/g],
  ['ps-web', /\b(Invoke-WebRequest|Invoke-RestMethod|irm|curl(?:\.exe)?)\b/g],
  ['url', /\bhttps?:\/\/[A-Za-z0-9.-]+/g],
];

// [{kind, match, line}] for one file's text.
function scanText(text) {
  const out = [];
  const lines = String(text).split('\n');
  lines.forEach((l, i) => {
    for (const [kind, re] of SCAN) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l))) out.push({ kind, match: kind === 'module' ? m[1] : m[0], line: i + 1 });
    }
  });
  return out;
}

module.exports = { policy, hostOf, isLoopback, allowed, setOptIn, check, note, setLog, log, installGuard, scanText, POLICY_FILE };
