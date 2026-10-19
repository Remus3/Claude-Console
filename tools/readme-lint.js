'use strict';
// README lint for the public README (CON-013 f.6): every fact once. Fails on a repeated
// heading, a repeated paragraph or sentence (normalised text), a relative link or image
// that names no file, a missing fixed section, a long prose line, or a non-ASCII / CRLF
// byte. The public DENY scan runs separately (tools/console_export.py scan).
//
//   node tools/readme-lint.js [<export dir>]   # lints <dir>/README.md (default: this tree)
const fs = require('fs');
const path = require('path');

const SECTIONS = ['Requirements', 'Install', 'First run', 'Daily use', 'Setup profile', 'Privacy', 'Update',
  'If something breaks', 'Uninstall', 'Troubleshooting', 'License'];
const MAX_LINE = 100;
// Files the export generates next to the README (tools/console_export.py build_files).
const GENERATED = new Set(['LICENSE', 'NOTICE']);

const norm = (s) => s.toLowerCase().replace(/[`*_>[\]()!]/g, '').replace(/\s+/g, ' ').replace(/[.:;,]+$/, '').trim();

function blocks(text) {
  const out = [];
  let cur = [], fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fence = !fence; if (cur.length) { out.push(cur.join('\n')); cur = []; } continue; }
    if (fence) continue;
    if (!line.trim() || /^#/.test(line) || /^\|/.test(line)) { if (cur.length) { out.push(cur.join('\n')); cur = []; } continue; }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out;
}

// problems: [string]. root = the dir the README's relative links resolve against.
function lint(text, root) {
  const p = [];
  if (!/^[\x0a\x20-\x7e]*$/.test(text)) p.push('non-ASCII or CR byte');
  const heads = [...text.matchAll(/^(#{1,6}) (.+)$/gm)].map((m) => m[2].trim());
  const seenH = new Set();
  for (const h of heads) { const k = norm(h); if (seenH.has(k)) p.push('repeated heading: ' + h); seenH.add(k); }
  for (const s of SECTIONS) if (!heads.some((h) => h === s || h.startsWith(s + ' '))) p.push('missing section: ' + s);
  const paras = new Map(), sents = new Map();
  for (const b of blocks(text)) {
    const k = norm(b);
    if (k.length > 40) { if (paras.has(k)) p.push('repeated paragraph: ' + b.slice(0, 60)); paras.set(k, 1); }
    for (const s of b.replace(/\n/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const ks = norm(s);
      if (ks.split(' ').length < 6) continue;
      if (sents.has(ks)) p.push('repeated sentence: ' + s.slice(0, 80));
      sents.set(ks, 1);
    }
  }
  let fence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && !/^\|/.test(line) && line.length > MAX_LINE && !/\]\(/.test(line)) p.push('line ' + (i + 1) + ' longer than ' + MAX_LINE);
  });
  for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[2].split('#')[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    if (!GENERATED.has(target) && !fs.existsSync(path.join(root, target))) p.push((m[1] ? 'image' : 'link') + ' target missing: ' + target);
    else if (m[1] && !/\.(png|gif)$/i.test(target)) p.push('image is not png/gif: ' + target);
  }
  return p;
}

module.exports = { lint, SECTIONS };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const file = fs.existsSync(path.join(dir, 'release', 'README.md')) && !fs.existsSync(path.join(dir, 'LICENSE'))
    ? path.join(dir, 'release', 'README.md') : path.join(dir, 'README.md');
  const probs = lint(fs.readFileSync(file, 'utf8'), dir);
  for (const x of probs) console.log('README: ' + x);
  process.exit(probs.length ? 1 : 0);
}
