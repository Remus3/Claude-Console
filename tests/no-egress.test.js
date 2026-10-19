'use strict';
// Privacy guarantee, static half (CON-013 addendum e.1): every network-capable call or URL
// literal in a shipped .js / .ps1 / .cmd / .vbs file must be in the egress policy
// (installer/egress.json, read through installer/egress.js scanText / policy): the file
// listed, every non-loopback host named for that file, and a loopback-class file never
// naming an outside host. A new hit, a new host or a loopback file going out fails.
// No analytics or crash-upload package, ever.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const egress = require('../installer/egress');

const ROOT = path.resolve(__dirname, '..');
const SHIPPED_EXT = new Set(['.js', '.ps1', '.cmd', '.vbs']);
const SKIP_DIRS = new Set(['node_modules', 'tests', 'data', 'run', 'drops', '.git', 'docs']);
// Build-time copies (tools/console_export.py): checked against their source's entry.
// XML namespace identifiers, never fetched (createElementNS('http://www.w3.org/2000/svg')).
const NAMESPACE_HOSTS = new Set(['www.w3.org']);
const ALIASES = { 'release/recover.ps1': 'installer/recover.ps1' };
const MAIN_ONLY = new Set();

function shippedFiles(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) shippedFiles(path.join(dir, e.name), r, out);
    } else if (SHIPPED_EXT.has(path.extname(e.name).toLowerCase()) && !MAIN_ONLY.has(r)) {
      out.push(r);
    }
  }
  return out;
}

// problems for {file: text} against a policy {loopback, hosts, files}.
function check(texts, pol) {
  const problems = [];
  const loop = new Set(pol.loopback || []);
  const known = new Set((pol.hosts || []).map((h) => h.host));
  const byFile = new Map((pol.files || []).map((f) => [f.file, f]));
  for (const [file, text] of Object.entries(texts)) {
    const hits = egress.scanText(text);
    if (!hits.length) continue;
    const entry = byFile.get(ALIASES[file] || file);
    if (!entry) { problems.push('unlisted file ' + file + ': ' + [...new Set(hits.map((h) => h.kind + ' ' + h.match))].join(', ')); continue; }
    for (const h of hits) {
      if (h.kind !== 'url') continue;
      const host = h.match.replace(/^https?:\/\//i, '').toLowerCase();
      if (loop.has(host) || NAMESPACE_HOSTS.has(host)) continue;
      if (entry.class === 'loopback') problems.push('loopback file ' + file + ' names ' + host);
      else if (!(entry.hosts || []).includes(host)) problems.push('new host ' + host + ' in ' + file);
      else if (!known.has(host) && entry.class !== 'shown-text' && entry.class !== 'user-initiated') problems.push('host ' + host + ' in ' + file + ' is not an allowed host');
    }
  }
  return problems;
}

const ANALYTICS = /analytics|telemetry|sentry|segment|mixpanel|amplitude|posthog|bugsnag|datadog|newrelic|new-relic|rollbar|honeybadger|appinsights|applicationinsights|crashpad|raygun|logrocket|fullstory/i;

test('every shipped network call and URL is in the egress policy', () => {
  const files = shippedFiles(ROOT, '', []);
  assert.ok(files.includes('server/server.js') && files.includes('release/install.ps1'), 'scans the shipped tree');
  const texts = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')]));
  assert.deepStrictEqual(check(texts, egress.policy()), []);
});

test('the check catches a planted call, a new host and a loopback file going out', () => {
  const pol = { loopback: ['127.0.0.1'], hosts: [{ host: 'api.github.com', kind: 'update' }],
    files: [{ file: 'server/a.js', class: 'loopback', hosts: ['127.0.0.1'] }, { file: 'installer/r.js', class: 'update', hosts: ['api.github.com'] }] };
  assert.deepStrictEqual(check({ 'server/a.js': "require('http'); x('http://127.0.0.1:1/')" }, pol), []);
  assert.ok(check({ 'server/b.js': "fetch('https://stats.example.net/c')" }, pol).some((p) => /unlisted file server\/b\.js/.test(p)));
  assert.ok(check({ 'installer/r.js': "x('https://stats.example.net/c')" }, pol).some((p) => /new host stats\.example\.net/.test(p)));
  assert.ok(check({ 'server/a.js': "x('https://api.github.com/x')" }, pol).some((p) => /loopback file server\/a\.js names api\.github\.com/.test(p)));
  assert.ok(check({ 'release/x.ps1': 'Invoke-WebRequest -Uri $u' }, pol).some((p) => /unlisted file release\/x\.ps1/.test(p)));
});

test('the release copy of recover.ps1 is checked as installer/recover.ps1', () => {
  const pol = egress.policy();
  const text = fs.readFileSync(path.join(ROOT, 'installer', 'recover.ps1'), 'utf8');
  assert.deepStrictEqual(check({ 'release/recover.ps1': text }, pol), []);
});

test('no analytics or crash-upload package, ever', () => {
  const pj = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys(Object.assign({}, pj.dependencies, pj.devDependencies, pj.optionalDependencies));
  assert.deepStrictEqual(deps.filter((d) => ANALYTICS.test(d)), []);
  assert.ok(ANALYTICS.test('@sentry/node') && ANALYTICS.test('posthog-node'), 'the pattern bites');
});
