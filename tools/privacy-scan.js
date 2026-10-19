#!/usr/bin/env node
'use strict';
// Privacy scan for the public repo: fails on personal data in any tracked-looking text
// file (emails, token shapes, real user-profile paths, private IP addresses, artifact
// ids, UUID-shaped ids). Run by CI on every push and pull request:
//
//   node tools/privacy-scan.js [dir]      exit 0 = clean, 1 = hits (listed), 2 = error
//
// The documented placeholders pass: C:\Users\you, %USERPROFILE%, example.com,
// *.invalid and GitHub noreply addresses. Exceptions are listed in ALLOW with a reason.

const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'run', 'drops']);
const BINARY_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2', '.ttf', '.zip']);
const EMAIL_OK = /@(example\.(com|org|net)|[a-z0-9.-]+\.invalid|users\.noreply\.github\.com)$/i;

const RULES = [
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
  ['token', new RegExp('sk-ant-[A-Za-z0-9_-]{8,}|\\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
    + '|\\bAKIA[0-9A-Z]{16}\\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\\bxox[abprs]-[A-Za-z0-9-]{10,}', 'g')],
  ['user-path', /\b[A-Za-z]:(?:\\{1,4}|\/)Users(?:\\{1,4}|\/)(?!(?:you|Public|Default|All Users)\b)[A-Za-z0-9._-]+/gi],
  ['private-ip', /\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/g],
  ['artifact-url', /claude\.ai\/(?:code\/)?artifact\/(?!<)[A-Za-z0-9-]+/g],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
];

// [term, file regex, line regex or null, reason]
const ALLOW = [
  ['email', /^package-lock\.json$/, null, 'npm scoped package names, not emails'],
  ['email', /./, /@xterm\/|@[0-9]+\.[0-9]+/, 'npm scope or version, not an email'],
  ['email', /^tests\/(fixtures\/adopt-demo\/|profile-adopt\.test\.js$)/, /\b[a-z]+-[a-z0-9-]+@/, 'adopt change ids <item>@<file>, not emails'],
  ['uuid', /^package-lock\.json$/, null, 'npm integrity data'],
  // The fixture ids are joined at run time so this file holds no UUID-shaped literal.
  ['uuid', /^tests\//, new RegExp('\\b(0{8}|1{8})-|' + [
    ['0b5c2a3e', '1f2d', '4c3b', '9a8e', '7d6c5b4a3f21'], ['0f0e0d0c', '0b0a', '4908', '8706', '050403020100'],
    ['99999999', '2222', '3333', '4444', '555555555555'], ['123e4567', 'e89b', '12d3', 'a456', '426614174000'],
  ].map((p) => p.join('-')).join('|'), 'i'), 'made-up or RFC-example UUID fixture'],
  ['artifact-url', /^tests\/boards\.test\.js$/, null, 'made-up board ids for the board-link validator'],
  ['artifact-url', /^server\/boards\.js$/, null, 'the accepted URL shape (comment), no id'],
  ['token', /^tests\/installer\.test\.js$/, new RegExp('sk-ant-' + 'abcdefghijklmnop'), 'fake token proving the contribute scrubber removes it'],
  ['token', /^installer\/contribute\.js$/, null, 'the scrubber\'s own token pattern'],
  ['user-path', /^tests\//, /Users[\\/]+(x|u|test|someone|me)\b/i, 'made-up user name in a path test'],
];

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), base, out);
    } else if (e.isFile()) {
      out.push(path.relative(base, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

function scanText(rel, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [term, rx] of RULES) {
      rx.lastIndex = 0;
      let m;
      while ((m = rx.exec(line)) !== null) {
        if (term === 'email' && EMAIL_OK.test(m[0])) continue;
        const ok = ALLOW.some(([t, f, l]) => t === term && f.test(rel) && (!l || l.test(line)));
        if (!ok) hits.push({ term, file: rel, line: i + 1, text: m[0] });
      }
    }
  });
  return hits;
}

function scanDir(dir) {
  const hits = [];
  for (const rel of walk(dir, dir, []).sort()) {
    if (BINARY_EXT.has(path.extname(rel).toLowerCase())) continue;
    const buf = fs.readFileSync(path.join(dir, rel));
    if (buf.includes(0)) continue;
    hits.push(...scanText(rel, buf.toString('utf8')));
  }
  return hits;
}

module.exports = { scanDir, scanText, RULES, ALLOW };

if (require.main === module) {
  try {
    const dir = path.resolve(process.argv[2] || '.');
    const hits = scanDir(dir);
    for (const h of hits) console.log(h.file + ':' + h.line + ': ' + h.term + ': ' + h.text);
    console.log('privacy scan: ' + hits.length + ' hits');
    process.exitCode = hits.length ? 1 : 0;
  } catch (e) {
    console.error('privacy scan failed: ' + e.message);
    process.exitCode = 2;
  }
}
