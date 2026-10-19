'use strict';
// CON-013 L3x: adopt an existing project, non-destructively (addendum b, replaces design
// c.4). Flow and invariants:
//   1. copy   - always; a full byte copy into <dataDir>/adopt/<id>/ (profile-copy.js);
//               the original is read only through a read-only view (I1)
//   2. scan   - on the pristine snapshot: every item's status (conforms / differs /
//               missing / conflicts / local-only) and every change it proposes
//   3. report - one section per rule (item id, profile order), one row per change: file,
//               line ranges in the ORIGINAL and in the copy, operation, unified diff
//               (3 lines of context), why, risk, predicted BREAK RISK (I2: relocations
//               carry the same hunk hash on both sides)
//   4. choose - yes / no per module and per change ("accept all for this module";
//               break-risk changes need a second confirm; high risk the typed phrase)
//   5. apply  - to the copy only, always from the pristine state (so a revert of one
//               change is "apply the rest"), then the ledger proves no byte was lost
//   6. check  - the project's own tests / build / start on both sides, side by side;
//               any WORSE blocks promotion and bisect names the change
//   7. works  - the user's typed confirmation, pinned to the copy's hash (I3)
//   8. promote / remove-original / revert - profile-promote.js (I4, I5); nothing ever
//               commits or pushes (I6)
// L5's server routes call openAdopt(); the CLI is cliAdopt(); both share every step.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const P = require('./profile');
const PL = require('./profile-plan');
const TX = require('./profile-tx');
const CP = require('./profile-copy');
const FC = require('./profile-funcheck');
const PR = require('./profile-promote');
const { stamp } = require('./paths');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d === undefined ? null : d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(t, f); };
const abs = (dir, rel) => path.join(dir, ...rel.split('/'));
const readBuf = (dir, rel) => { try { return fs.readFileSync(abs(dir, rel)); } catch (e) { return null; } };
const isBinary = (b) => !!b && b.subarray(0, 8000).includes(0);

const KB = 1024;
const BUDGETS = { 'CLAUDE.md': 40, 'ROADMAP.md': 60 };
const MD_KB = 40;
const ARCHIVE_DIR = 'docs/archive';
const CLAUDE_ARCHIVE = 'docs/claude-md-archive.md';
const STATUS_GLYPH = { conforms: '[+]', differs: '[!]', missing: '[ ]', conflicts: '[x]', local: '[-]', outside: '[-]', off: '[-]' };
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|cs|php|ps1|psm1|sh|bat|cmd|json|ya?ml|toml|ini|cfg|conf|html?|vue|svelte)$/i;
const TEST_FILE = /(^|\/)(tests?|spec|__tests__)\/|[._-]test\.|_spec\.|(^|\/)test_[^/]*\.py$/i;

// ------------------------------------------------------------------ text helpers

// Hunks of a line diff: [{o: [start, len], n: [start, len], removed: [...], added: [...]}],
// 1-based; a pure insertion has o[1] = 0 and o[0] = the line it goes after + 1.
function hunks(before, after) {
  const a = before == null ? [] : PL.splitLines(before.toString('latin1'));
  const b = after == null ? [] : PL.splitLines(after.toString('latin1'));
  let ops = PL.lcsDiff(a, b);
  if (!ops) ops = a.map((l) => ['-', l]).concat(b.map((l) => ['+', l]));
  const out = [];
  let i = 0;
  let j = 0;
  let cur = null;
  for (const [t, l] of ops) {
    if (t === ' ') { if (cur) { out.push(cur); cur = null; } i++; j++; continue; }
    if (!cur) cur = { o: [i + 1, 0], n: [j + 1, 0], removed: [], added: [] };
    if (t === '-') { cur.o[1]++; cur.removed.push(l); i++; } else { cur.n[1]++; cur.added.push(l); j++; }
  }
  if (cur) out.push(cur);
  return out;
}
const ranges = (hs, side) => hs.filter((h) => h[side][1] > 0).map((h) => [h[side][0], h[side][0] + h[side][1] - 1]);
const rangeText = (rs) => (rs.length ? rs.map(([s, e]) => (s === e ? String(s) : s + '-' + e)).join(', ') : '-');
const showCr = (t) => String(t).replace(/\r/g, '<CR>');

function fileDiff(rel, before, after) {
  if (isBinary(before) || isBinary(after)) return 'Binary ' + rel + '\n';
  return PL.udiff(before == null ? null : showCr(before.toString('latin1')), after == null ? null : showCr(after.toString('latin1')), rel);
}

function fileRecord(rel, before, after, role) {
  const hs = isBinary(before) || isBinary(after) ? [] : hunks(before, after);
  const rec = { file: rel, role: role || null, before: before == null ? null : sha(before), after: after == null ? null : sha(after),
    orig: ranges(hs, 'o'), copy: ranges(hs, 'n'), removedLines: hs.reduce((n, h) => n + h.o[1], 0), addedLines: hs.reduce((n, h) => n + h.n[1], 0), diff: fileDiff(rel, before, after) };
  return rec;
}

function globRe(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { s += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + s + '$');
}

// ------------------------------------------------------------------ scan context

function scanCtx(dir, o) {
  const entries = CP.walk(fs, dir, { skip: (r) => r === '.git' || r.startsWith('.git/') });
  const files = entries.filter((e) => e.type === 'file').map((e) => e.rel);
  const texts = new Map();
  const text = (rel) => {
    if (!texts.has(rel)) { const b = readBuf(dir, rel); texts.set(rel, b && !isBinary(b) ? b.toString('latin1') : null); }
    return texts.get(rel);
  };
  const isGit = fs.existsSync(path.join(dir, '.git'));
  return Object.assign({ dir, entries, files, text, isGit }, o || {});
}

// ------------------------------------------------------------------ break-risk heuristics

function gitattributesCrlf(ctx) {
  const t = ctx.text('.gitattributes') || '';
  return t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && /\beol=crlf\b/.test(l)).map((l) => globRe(l.split(/\s+/)[0].replace(/^\//, '')));
}

function crlfRequired(rel, ctx) {
  const reasons = [];
  if (/\.(bat|cmd|sln|vcxproj|vcproj|filters)$/i.test(rel)) reasons.push('Windows batch / solution file (cmd.exe and Visual Studio expect CRLF)');
  for (const re of gitattributesCrlf(ctx)) if (re.test(rel) || re.test(path.posix.basename(rel))) { reasons.push('.gitattributes pins eol=crlf'); break; }
  if (/(^|\/)tests?\/(.*\/)?fixtures\//i.test(rel)) reasons.push('a test fixture (its bytes may be the expected value)');
  const base = path.posix.basename(rel);
  for (const f of ctx.files) {
    if (f === rel || !TEST_FILE.test(f)) continue;
    const t = ctx.text(f);
    if (!t || !t.includes(base)) continue;
    if (/sha\d*|hash|checksum|digest|byteLength|\bbytes\b/i.test(t)) { reasons.push('bytes asserted by ' + f); break; }
  }
  if (/(^|\/)data\/[^/]+\.(csv|tsv|dat|txt)$/i.test(rel)) reasons.push('a data file');
  for (const f of ctx.files) {
    if (f === rel || !CODE_EXT.test(f)) continue;
    const t = ctx.text(f);
    if (t && t.includes(base) && /\\r\\n/.test(t)) { reasons.push('read by ' + f + ' which splits on \\r\\n'); break; }
  }
  return reasons;
}

// Static reference scan: every line of a code / config file that names the path.
function importers(rel, ctx) {
  const out = [];
  const base = path.posix.basename(rel);
  const variants = [rel, rel.replace(/\//g, '\\\\'), rel.replace(/\//g, '\\')];
  const quoted = new RegExp('[\'"`]([^\'"`\\n]*[\\\\/])?' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&') + '[\'"`]');
  for (const f of ctx.files) {
    if (f === rel || !CODE_EXT.test(f)) continue;
    const t = ctx.text(f);
    if (!t || !t.includes(base)) continue;
    t.split('\n').forEach((line, i) => { if (variants.some((v) => line.includes(v)) || quoted.test(line)) out.push(f + ':' + (i + 1)); });
  }
  return out;
}

// ------------------------------------------------------------------ built-in rules
// Each scan returns proposals {op, file, dest?, why, breakRisk?, notes?}; the bytes are
// computed by transform() against whatever the dir holds when the change is applied.

const SECRET_SHAPES = [
  ['openai-style key', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['github token', /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['aws access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack token', /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['key assignment', /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?([^\s'"]{12,})/i],
];
const mask = (s) => s.slice(0, 4) + '... (' + s.length + ' chars)';

const RULES = {
  'rule-encoding-ascii-lf': {
    scan(ctx) {
      const out = [];
      for (const rel of ctx.files) {
        const t = ctx.text(rel);
        if (t === null || !t.includes('\r')) continue;
        const lines = t.split('\n');
        const crlf = lines.filter((l) => l.endsWith('\r')).length;
        const lf = lines.length - 1 - crlf;
        const reasons = crlfRequired(rel, ctx);
        out.push({ op: 'normalise', file: rel, why: 'LF only: ' + crlf + ' CRLF line(s)' + (lf > 0 && crlf > 0 ? ' mixed with ' + lf + ' LF line(s)' : '') + ' become LF.',
          breakRisk: reasons.length ? { class: 'crlf-required', reasons } : null });
      }
      return out;
    },
    transform(dir, ch) {
      const b = readBuf(dir, ch.file);
      if (b === null) return null;
      return [{ rel: ch.file, after: Buffer.from(b.toString('latin1').replace(/\r\n?/g, '\n'), 'latin1') }];
    },
  },
  'conv-gitattributes-lf': {
    contributesTo: '.gitattributes',
    want: (ctx) => ['* text=auto eol=lf'].concat(ctx.files.some((f) => /\.(bat|cmd)$/i.test(f)) ? ['*.bat text eol=crlf', '*.cmd text eol=crlf'] : []),
    scan(ctx) {
      const cur = ctx.text('.gitattributes');
      const want = this.want(ctx);
      const have = new Set((cur || '').split('\n').map((l) => l.trim()));
      const add = want.filter((l) => !have.has(l));
      if (!add.length) return [];
      return [{ op: cur === null ? 'create' : 'insert', file: '.gitattributes', lines: add, why: cur === null ? 'Pins LF in git (and CRLF for .bat / .cmd) so the working tree stays LF.' : 'Adds the LF pin to the existing .gitattributes.' }];
    },
    transform(dir, ch) {
      const b = readBuf(dir, '.gitattributes');
      const t = b === null ? '' : b.toString('latin1');
      const have = new Set(t.split('\n').map((l) => l.trim()));
      const add = ch.lines.filter((l) => !have.has(l));
      if (!add.length) return [];
      return [{ rel: '.gitattributes', after: Buffer.from((t && !t.endsWith('\n') ? t + '\n' : t) + add.join('\n') + '\n', 'latin1') }];
    },
  },
  'conv-doc-size-budget': {
    scan(ctx) {
      const out = [];
      for (const rel of ctx.files) {
        const base = path.posix.basename(rel);
        if (!/\.md$/i.test(rel) || rel.startsWith(ARCHIVE_DIR + '/') || rel === CLAUDE_ARCHIVE) continue;
        const limit = (BUDGETS[base] || MD_KB) * KB;
        const b = readBuf(ctx.dir, rel);
        if (!b || b.length <= limit) continue;
        const kb = Math.round(b.length / KB);
        if (base === 'CLAUDE.md') {
          const split = splitSections(b.toString('latin1'), limit);
          if (!split) continue;
          out.push({ op: 'relocate', mode: 'sections', file: rel, dest: CLAUDE_ARCHIVE, why: rel + ' is ' + kb + ' KB (budget ' + (limit / KB) + ' KB): ' + split.moved.length + ' later section(s) move to ' + CLAUDE_ARCHIVE + ' with a pointer line; relocated, never deleted.' });
          continue;
        }
        const dest = ARCHIVE_DIR + '/' + rel.replace(/^docs\//, '');
        const imp = importers(rel, ctx);
        const conflict = ctx.files.includes(dest);
        out.push({ op: 'relocate', mode: 'whole', file: rel, dest, why: rel + ' is ' + kb + ' KB (budget ' + (limit / KB) + ' KB): it moves to ' + dest + ' and a one-line pointer stays; relocated, never deleted.',
          breakRisk: imp.length ? { class: 'read-by-path', reasons: imp.map((x) => 'read by path at ' + x), importers: imp } : null, conflict: conflict ? dest + ' already exists' : null });
      }
      return out;
    },
    transform(dir, ch) {
      const b = readBuf(dir, ch.file);
      if (b === null) return null;
      const t = b.toString('latin1');
      if (ch.mode === 'sections') {
        const split = splitSections(t, (BUDGETS['CLAUDE.md'] || MD_KB) * KB);
        if (!split) return [];
        const prev = readBuf(dir, ch.dest);
        const head = prev === null ? '# CLAUDE.md archive\n\nSections relocated from CLAUDE.md by the size budget (relocate, do not delete).\n\n' : prev.toString('latin1').replace(/\n*$/, '\n\n');
        return [
          { rel: ch.file, after: Buffer.from(split.keep + '\n' + 'Relocated sections (size budget): see ' + ch.dest + '\n', 'latin1') },
          { rel: ch.dest, after: Buffer.from(head + split.moved.join(''), 'latin1') },
        ];
      }
      if (readBuf(dir, ch.dest) !== null) throw new Error(ch.dest + ' already exists');
      const title = (/^#\s+(.+)$/m.exec(t) || [])[1] || path.posix.basename(ch.file);
      return [
        { rel: ch.dest, after: b },
        { rel: ch.file, after: Buffer.from('# ' + title.trim() + '\n\nMoved to ' + ch.dest + ' (size budget: relocate, do not delete).\n', 'latin1') },
      ];
    },
  },
  'sc-scratch-area': {
    scan(ctx) {
      const out = [];
      const top = ctx.entries.filter((e) => !e.rel.includes('/'));
      for (const e of top) {
        const n = e.rel;
        const stray = e.type === 'dir' ? /^(scratch|tmp|temp)([_-][A-Za-z0-9]*)?$/i.test(n) : /\.(log|tmp|bak)$|\(copy\)|^~\$/i.test(n);
        if (!stray) continue;
        const imp = importers(n, ctx).filter((x) => !x.startsWith('.gitignore'));
        out.push({ op: 'move', file: n, kind: e.type, why: (e.type === 'dir' ? 'Stray scratch folder' : 'Stray file') + ' at the repo root: it moves to the adoption archive (outside the repo), byte for byte; nothing is deleted.',
          breakRisk: imp.length ? { class: 'read-by-path', reasons: imp.map((x) => 'named at ' + x), importers: imp } : null });
      }
      return out;
    },
  },
  'floor-secrets-never-echoed': {
    report(ctx) {
      const rows = [];
      for (const rel of ctx.files) {
        const t = ctx.text(rel);
        if (t === null) continue;
        t.split('\n').forEach((line, i) => {
          for (const [shape, re] of SECRET_SHAPES) {
            const m = re.exec(line);
            if (!m) continue;
            const hit = m[2] || m[1] || m[0];
            rows.push({ file: rel, line: i + 1, shape, masked: mask(hit) });
            break;
          }
        });
      }
      return rows.map((r) => ({ op: 'report', file: r.file, lines: [[r.line, r.line]], shape: r.shape, masked: r.masked,
        why: 'A ' + r.shape + '-shaped string (' + r.masked + '). Reported only, never rewritten: move it to a secret store and reference it.' }));
    },
  },
  'floor-no-ai-attribution': {
    report(ctx) {
      if (!ctx.isGit) return [];
      const r = spawnSync('git', ['-C', ctx.dir, 'log', '--format=%H%x1f%B%x1e'], { encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) return [];
      const out = [];
      for (const rec of String(r.stdout).split('\x1e')) {
        const [h, body] = rec.split('\x1f');
        if (!h || !body) continue;
        const m = /^co-authored-by:\s*([^<\n]+)/im.exec(body);
        if (m) out.push({ op: 'report', file: 'git:' + h.trim().slice(0, 10), commit: h.trim().slice(0, 10), why: 'Commit ' + h.trim().slice(0, 10) + ' carries a co-author trailer (' + m[1].trim() + '). Reported only: adopt never rewrites history.' });
      }
      return out;
    },
  },
};

// CLAUDE.md over budget: keep the head and whole sections ("## ") while under 90% of the
// budget; the rest moves. null when it cannot be split (one huge section).
function splitSections(text, limit) {
  const parts = text.split(/(?=^## )/m);
  if (parts.length < 2) return null;
  let keep = parts[0];
  let i = 1;
  while (i < parts.length && Buffer.byteLength(keep + parts[i], 'latin1') <= limit * 0.9) keep += parts[i++];
  if (i >= parts.length) return null;
  return { keep: keep.replace(/\n*$/, '\n'), moved: parts.slice(i).map((p) => p.replace(/\n*$/, '\n\n')) };
}

// ------------------------------------------------------------------ the repo-side model

// Adopt works on the project only: contributions to the user's Claude config, env vars,
// scheduled tasks and app configs are listed as "outside the project" and left to
// `profile apply`. git config contributions stay when the project is a git repo.
function repoModel(model, isGit) {
  const isRepo = (c) => (['file', 'block', 'json-merge'].includes(c.kind) ? /^repo:/.test(String(c.target)) : c.kind === 'kit' ? !c.target || /^repo:/.test(String(c.target)) : c.kind === 'git' ? isGit : false);
  const outside = new Map();
  const items = new Map();
  const modules = model.modules.map((m) => {
    const m2 = Object.assign({}, m);
    m2.items = (m.items || []).map((it) => {
      const keep = [];
      const out = [];
      for (const c of it.contributes || []) (isRepo(c) ? keep : out).push(c);
      if (out.length) outside.set(it.id, out);
      return Object.assign({}, it, { contributes: keep });
    });
    return m2;
  });
  for (const m of modules) for (const it of m.items) items.set(it.id, { item: it, module: m });
  return Object.assign({}, model, { modules, items, order: model.order.filter((id) => items.has(id)), outside });
}

function selectionOn(model, ids) {
  const sel = P.normaliseSelection({}, model);
  for (const id of ids.concat(P.dependencyClosure(model, ids))) sel.items[id] = 'on';
  return sel;
}

function gitFor() { return TX.gitAdapter(); }

function planIn(ad, ctx, dir, ids, stateDir, resolve) {
  const rm = ctx.rmodel;
  return PL.plan({ model: rm, selection: selectionOn(rm, ids), only: ids, target: { repo: dir, configDir: null }, dataDir: stateDir, values: ad.values || {},
    deps: { git: ctx.git || gitFor() }, platform: ctx.platform, ctx: { detect: ctx.detect }, resolve: resolve || {} });
}

// ------------------------------------------------------------------ detect (status)

function detectHits(item, sctx, vars) {
  const hits = [];
  for (const d of item.detect || []) {
    const k = ['file', 'text', 'json', 'git', 'env'].find((x) => d[x] !== undefined);
    if (k === 'env') continue;
    if (k === 'git') {
      if (!sctx.isGit) continue;
      const r = spawnSync('git', ['-C', sctx.dir, 'config', '--get', d.git], { encoding: 'utf8', windowsHide: true });
      if (r.status === 0) hits.push('git ' + d.git);
      continue;
    }
    const m = /^repo:(.+)$/.exec(String(d[k]));
    if (!m) continue;
    const rel = P.renderText(m[1], vars).text;
    const re = globRe(rel);
    const matched = sctx.files.filter((f) => re.test(f));
    if (k === 'file' && matched.length) hits.push(rel);
    if (k === 'text') { const rx = new RegExp(d.regex); if (matched.some((f) => rx.test(sctx.text(f) || ''))) hits.push(rel + ' ~ /' + d.regex + '/'); }
    if (k === 'json') { for (const f of matched) { try { let o = JSON.parse(sctx.text(f)); for (const p of d.key.split('.')) o = o[p]; if (o !== undefined) hits.push(rel + '#' + d.key); } catch (e) { /* no */ } } }
  }
  return hits;
}

// ------------------------------------------------------------------ scan + report

// Builds the conformance report from the pristine snapshot. Pure apart from the plans'
// reads and `git log` / `git config --get` in the snapshot.
function scan(ad, ctx) {
  const sctx = scanCtx(ad.baseDir);
  const rm = repoModel(ctx.model, sctx.isGit);
  ctx.rmodel = rm;
  const sel = ctx.selection || P.normaliseSelection({}, ctx.model);
  const state = P.effectiveState(ctx.model, sel);
  const vr = P.resolveVariables(ctx.model, ad.values || {}, { repoRoot: ad.baseDir, detect: ctx.detect });
  const stateDir = path.join(ad.dir, 'state-scan');
  const changes = [];
  const items = [];
  for (const id of rm.order) {
    const { item, module: mod } = rm.items.get(id);
    const on = state.get(id) ? state.get(id).on : false;
    const row = { item: id, module: mod.id, title: item.title, risk: item.risk, on, status: null, changes: [], notes: [], detect: detectHits(item, sctx, vr.vars) };
    if (!on) {
      row.status = 'off';
      row.notes.push('off in your selection; enable it (profile enable ' + id + ') to adopt it');
      items.push(row);
      continue;
    }
    const outside = rm.outside.get(id);
    if (outside) row.notes.push('outside the project (not part of adopt; profile apply sets it): ' + outside.map((c) => c.kind + ' ' + (c.name || c.target || c.key || '')).join(', '));
    const rule = RULES[id];
    const engineContrib = (item.contributes || []).length > 0;
    let props = [];
    let reports = [];
    if (rule && rule.scan && !(rule.contributesTo && (item.contributes || []).some((c) => String(c.target || '').endsWith(':' + rule.contributesTo)))) props = rule.scan(sctx);
    if (rule && rule.report) reports = rule.report(sctx);
    // Engine contributions (planned alone against the snapshot).
    let ep = null;
    if (engineContrib) {
      fs.mkdirSync(stateDir, { recursive: true });
      const p = planIn(ad, ctx, ad.baseDir, [id], stateDir);
      const v = PL.planVerdict(p);
      const mine = p.files.filter((f) => f.items.includes(id) && ['new', 'differs', 'removed', 'conflict'].includes(f.status));
      const rows = p.rows.filter((r) => r.item === id && r.status !== 'skipped');
      const git = p.machine.filter((m) => m.kind === 'git' && m.item === id && m.op === 'set');
      const conflict = rows.some((r) => r.status === 'conflict');
      const blocked = p.missing.length ? 'needs {' + p.missing.map((m) => m.name).join('}, {') + '} (--var name=value)' : v.code === 1 ? v.line.replace(/^refused: /, '') : null;
      ep = { rows, conflict, blocked, allNew: rows.length > 0 && rows.every((r) => r.status === 'new'), allSame: rows.length > 0 && rows.every((r) => r.status === 'same'), deps: p.depsAdded };
      if (mine.length || git.length || blocked) {
        const files = mine.map((f) => fileRecord(f.rel, f.before, f.after));
        for (const g of git) files.push({ file: 'git:' + g.key, before: null, after: null, orig: [], copy: [], removedLines: 0, addedLines: 0, diff: 'git config --local ' + g.key + ' ' + g.value + '\n', git: true });
        props.unshift({ op: 'profile', engine: true, file: null, files, conflict: conflict ? 'a different file or value is already there; accepting replaces it' : null, blocked,
          why: item.does + (ep.deps.length ? ' (also needs: ' + ep.deps.join(', ') + ')' : ''), deps: ep.deps });
      }
    }
    for (const pr of props) {
      const cid = pr.engine ? id + '@profile' : id + '@' + pr.file;
      let files = pr.files;
      if (!files) {
        // Preview against the snapshot, this change alone.
        try { files = previewRule(ad.baseDir, rule, pr, ad); } catch (e) { files = [{ file: pr.file, orig: [], copy: [], diff: '' }]; pr.blocked = pr.conflict || String(e.message || e).slice(0, 160); }
      }
      const ch = { id: cid, item: id, module: mod.id, op: pr.op, mode: pr.mode || null, file: pr.file, dest: pr.dest || null, lines: pr.lines || null, kind: pr.kind || null,
        files, why: pr.why, risk: item.risk, breakRisk: pr.breakRisk || null, conflict: pr.conflict || null, blocked: pr.blocked || null, deps: pr.deps || [], engine: !!pr.engine, on };
      if (ch.op === 'relocate') {
        const moved = files.find((f) => f.role === 'to');
        ch.hunkHash = moved ? moved.movedHash : null;
      }
      row.changes.push(ch);
      changes.push(ch);
    }
    for (const r of reports) {
      const ch = { id: id + '@' + r.file + (r.lines ? ':' + r.lines[0][0] : ''), item: id, module: mod.id, op: 'report', file: r.file, files: [{ file: r.file, orig: r.lines || [], copy: [], diff: '' }],
        why: r.why, risk: item.risk, breakRisk: null, reportOnly: true, shape: r.shape || null, masked: r.masked || null, commit: r.commit || null, on };
      row.changes.push(ch);
      changes.push(ch);
    }
    // Status.
    const real = row.changes.filter((c) => !c.reportOnly);
    const hasReport = row.changes.some((c) => c.reportOnly);
    if (!engineContrib && !rule && outside) row.status = 'outside';
    else if (!real.length && !hasReport) row.status = 'conforms';
    else if (!real.length) row.status = 'differs';
    else if (real.every((c) => (c.engine ? ep && ep.allNew && !row.detect.length : c.op === 'create'))) row.status = 'missing';
    else row.status = 'differs';
    items.push(row);
  }
  // conflicts_with: an item whose clashing item is present in the project.
  const present = new Set(items.filter((r) => r.status === 'conforms' || (r.detect.length && r.status === 'differs')).map((r) => r.item));
  for (const r of items) {
    const it = rm.items.get(r.item).item;
    const clash = (it.conflicts_with || []).filter((c) => present.has(c));
    if (clash.length && r.status !== 'conforms') { r.status = 'conflicts'; r.notes.push('clashes with ' + clash.join(', ') + ' (present in the project); both explanations are shown, pick one'); }
  }
  // Defaults per change (design c.4 step 3 + addendum b.4).
  for (const ch of changes) {
    const r = items.find((x) => x.item === ch.item);
    ch.status = r.status;
    ch.needsPhrase = ch.risk === 'high' && !ch.reportOnly ? 'apply ' + ch.item : null;
    ch.safe = !ch.reportOnly && !ch.blocked && !ch.conflict && !ch.breakRisk && ch.risk === 'low' && r.status === 'missing' && ch.on;
    ch.default = ch.safe;
  }
  // Local-only: top-level project content no change touches and no item detects.
  const touched = new Set();
  for (const ch of changes) for (const f of ch.files || []) if (f.file && !String(f.file).startsWith('git:')) touched.add(String(f.file).split('/')[0]);
  for (const r of items) for (const d of r.detect) touched.add(String(d).split('/')[0]);
  const local = sctx.entries.filter((e) => !e.rel.includes('/') && !touched.has(e.rel)).map((e) => e.rel);
  const counts = { conforms: 0, differs: 0, missing: 0, conflicts: 0, off: 0, outside: 0, local: local.length };
  for (const r of items) if (counts[r.status] !== undefined) counts[r.status]++;
  const modules = rm.modules.map((m) => ({ id: m.id, title: m.title, items: items.filter((r) => r.module === m.id) })).filter((m) => m.items.length);
  return { schema: 1, adoption: ad.id, project: path.basename(ad.original), generated: new Date().toISOString(), counts, modules, local, changes };
}

// Bytes a rule change would write, previewed against `dir` (no write): file records.
function previewRule(dir, rule, pr, ad) {
  if (pr.op === 'move') {
    const recs = [];
    const src = abs(dir, pr.file);
    const st = fs.statSync(src);
    const list = st.isDirectory() ? CP.walk(fs, src).filter((e) => e.type === 'file').map((e) => pr.file + '/' + e.rel) : [pr.file];
    for (const rel of list) {
      const b = readBuf(dir, rel);
      const r = fileRecord(rel, b, null, 'from');
      r.diff = 'moved out of the repo to the adoption archive: ' + rel + ' (' + b.length + ' bytes, sha256 ' + sha(b).slice(0, 12) + ')\n';
      r.movedTo = 'archive/stray/' + rel;
      recs.push(r);
    }
    return recs;
  }
  const writes = rule.transform(dir, pr) || [];
  const recs = [];
  for (const w of writes) {
    const before = readBuf(dir, w.rel);
    const role = pr.op === 'relocate' ? (w.rel === pr.file ? 'from' : 'to') : null;
    const r = fileRecord(w.rel, before, w.after, role);
    recs.push(r);
  }
  if (pr.op === 'relocate') {
    // The same hunk hash on both sides proves the text moved, not vanished (I2).
    const from = recs.find((r) => r.role === 'from');
    const to = recs.find((r) => r.role === 'to');
    if (from && to) {
      const before = readBuf(dir, pr.file).toString('latin1');
      const movedText = pr.mode === 'whole' ? before : splitSections(before, (BUDGETS['CLAUDE.md'] || MD_KB) * KB).moved.join('');
      const hh = sha(Buffer.from(movedText.replace(/\n+$/, ''), 'latin1'));
      from.movedHash = hh;
      to.movedHash = hh;
    }
  }
  return recs;
}

function reportText(rep, o) {
  o = o || {};
  const L = [];
  L.push('Adoption ' + rep.adoption + ' of ' + rep.project + ' - conformance report (the original is not touched; changes apply to the copy only)');
  const c = rep.counts;
  L.push('counts: conforms ' + c.conforms + ', differs ' + c.differs + ', missing ' + c.missing + ', conflicts ' + c.conflicts + ', local ' + c.local);
  for (const m of rep.modules) {
    L.push('');
    L.push('Module ' + m.id + ' - ' + m.title);
    for (const r of m.items) {
      L.push('  ' + (STATUS_GLYPH[r.status] || '[?]') + ' ' + r.status.padEnd(9) + ' ' + r.item + (r.on ? '' : ' (off in your selection)') + ' - ' + r.title);
      for (const n of r.notes) L.push('      note: ' + n);
      for (const ch of r.changes) {
        const box = ch.reportOnly ? '   ' : ch.default ? '[x]' : '[ ]';
        const files = (ch.files || []).filter((f) => f.file);
        const where = ch.reportOnly ? ch.file + (ch.files[0].orig.length ? ':' + rangeText(ch.files[0].orig) : '') : files.map((f) => f.file + (f.orig.length ? ' lines ' + rangeText(f.orig) : '') + (f.copy.length ? ' -> ' + rangeText(f.copy) : '')).join('; ');
        L.push('      ' + box + ' ' + ch.id + '  ' + ch.op + (ch.dest ? ' -> ' + ch.dest : '') + '  ' + (ch.reportOnly ? 'report only' : ch.risk + ' risk'));
        L.push('          where: ' + where);
        L.push('          why: ' + ch.why);
        if (ch.breakRisk) L.push('          BREAK RISK ' + ch.breakRisk.class + ': ' + ch.breakRisk.reasons.join('; '));
        if (ch.conflict) L.push('          conflict: ' + ch.conflict);
        if (ch.blocked) L.push('          blocked: ' + ch.blocked);
        if (ch.needsPhrase) L.push('          high risk: needs the typed phrase "' + ch.needsPhrase + '" (--ack ' + ch.item + ')');
        if (ch.hunkHash) L.push('          moved text hash: ' + ch.hunkHash.slice(0, 16) + ' (same on both sides)');
        if (o.diffs) for (const f of files) if (f.diff) L.push(f.diff.replace(/\n$/, '').split('\n').map((x) => '          | ' + x).join('\n'));
      }
    }
  }
  if (rep.local.length) { L.push(''); L.push('Local project content no rule claims (always kept):'); for (const x of rep.local) L.push('  [-] local ' + x); }
  return L.join('\n') + '\n';
}

// ------------------------------------------------------------------ adoptions on disk

function adoptRoot(dataDir, deps) { return (deps && deps.adoptRoot) || path.join(dataDir, 'adopt'); }
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,60}-\d{8}-\d{6}(-\d{1,3})?$/;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';

function adoptionFile(dir) { return path.join(dir, 'adoption.json'); }
function loadAdoption(root, id) {
  if (!ID_RE.test(String(id))) return null;
  const dir = path.join(root, id);
  const j = readJson(adoptionFile(dir));
  if (!isObj(j)) return null;
  return Object.assign(j, { dir, baseDir: path.join(dir, 'base'), copyDir: path.join(dir, 'copy'), promote: readJson(path.join(dir, 'promote.json')), removed: readJson(path.join(dir, 'removed.json')) });
}
function saveAdoption(ad) {
  const o = Object.assign({}, ad);
  for (const k of ['dir', 'baseDir', 'copyDir', 'promote', 'removed']) delete o[k];
  writeJson(adoptionFile(ad.dir), o);
}
function listAdoptions(root) {
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => ID_RE.test(n)).sort(); } catch (e) { return []; }
  return names.map((n) => loadAdoption(root, n)).filter(Boolean).map((a) => ({ id: a.id, project: path.basename(a.original), status: statusOf(a), created: a.created }));
}
function statusOf(ad) {
  if (ad.removed) return 'original-removed';
  if (ad.promote) return 'promoted';
  if (readJson(path.join(ad.dir, 'confirm.json'))) return 'confirmed';
  if (ad.lastCheck) return ad.lastCheck.verdict === 'passed' ? 'checked' : 'check-failed';
  if (ad.applied) return 'applied';
  return 'scanned';
}

// ------------------------------------------------------------------ choose

// specs: 'all' | 'all-safe' | 'module:<id>' | '<item>' | '<item>@<file>' | '<item>@profile'
// acks: item ids whose typed phrase "apply <id>" was given. Returns {ids, skipped: [{id, why}], added: [...]}.
function resolveAccept(rep, specs, acks, o) {
  o = o || {};
  const ackSet = new Set(acks || []);
  const real = rep.changes.filter((c) => !c.reportOnly);
  const pick = new Map();
  const skipped = [];
  const want = (c, explicit, how) => { if (!pick.has(c.id)) pick.set(c.id, { c, explicit, how }); else if (explicit) pick.get(c.id).explicit = true; };
  for (const s of specs || []) {
    if (s === 'all') { for (const c of real) want(c, true, 'all'); continue; }
    if (s === 'all-safe') { for (const c of real) if (c.safe) want(c, false, 'all-safe'); continue; }
    if (s.startsWith('module:')) { const m = s.slice(7); const list = real.filter((c) => c.module === m); if (!list.length) skipped.push({ id: s, why: 'no changes in module ' + m }); for (const c of list) want(c, false, s); continue; }
    const exact = real.find((c) => c.id === s);
    if (exact) { want(exact, true, 'id'); continue; }
    const byItem = real.filter((c) => c.item === s);
    if (byItem.length) { for (const c of byItem) want(c, false, 'item'); continue; }
    skipped.push({ id: s, why: 'no such change' });
  }
  const ids = [];
  for (const { c, explicit, how } of pick.values()) {
    if (c.blocked) { skipped.push({ id: c.id, why: 'blocked: ' + c.blocked }); continue; }
    if (c.breakRisk && !explicit && !o.breakConfirmed) { skipped.push({ id: c.id, why: 'break risk (' + c.breakRisk.class + '): accept it by its id or confirm the module\'s break-risk list', breakRisk: true }); continue; }
    if (c.needsPhrase && !ackSet.has(c.item)) { skipped.push({ id: c.id, why: 'high risk: needs the typed phrase "' + c.needsPhrase + '" (--ack ' + c.item + ')', phrase: true }); continue; }
    ids.push(c.id);
    void how;
  }
  // Dependencies of accepted engine items come along (named).
  const added = [];
  for (const id of ids.slice()) {
    const c = real.find((x) => x.id === id);
    for (const d of c.deps || []) {
      const dc = real.find((x) => x.id === d + '@profile');
      if (dc && !ids.includes(dc.id)) { ids.push(dc.id); added.push(dc.id); }
    }
  }
  const order = real.map((c) => c.id);
  return { ids: order.filter((x) => ids.includes(x)), skipped, added };
}

// ------------------------------------------------------------------ apply

// Applies `ids` (a subset of the report's changes) to dir, from whatever dir holds now
// (the pristine state in practice): rule changes first in profile order, then the
// engine items through one profile transaction. o: {journalDir, strayRoot, stateDir,
// trash, acks}. Returns {tx, writes: [{change, rel, ...}]}.
async function applyChanges(ad, ctx, dir, ids, o) {
  const rep = ctx.report;
  const byId = new Map(rep.changes.map((c) => [c.id, c]));
  const chosen = rep.changes.filter((c) => ids.includes(c.id) && !c.reportOnly);
  const journal = o.journalDir ? path.join(o.journalDir, 'journal.jsonl') : null;
  const preDir = o.journalDir ? path.join(o.journalDir, 'pre') : null;
  if (preDir) fs.mkdirSync(preDir, { recursive: true });
  let seq = 0;
  const log = (e) => { if (journal) fs.appendFileSync(journal, JSON.stringify(e) + '\n'); };
  const writes = [];
  for (const ch of chosen.filter((c) => !c.engine)) {
    const rule = RULES[ch.item];
    if (ch.op === 'move') {
      const src = abs(dir, ch.file);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(o.strayRoot, ...ch.file.split('/'));
      if (fs.existsSync(dest)) throw new Error('stray archive target exists: ' + ch.file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const e = { seq: ++seq, change: ch.id, op: 'move', rel: ch.file, dest, hash: fs.statSync(src).isDirectory() ? CP.treeHash(src) : sha(fs.readFileSync(src)) };
      log(e);
      fs.renameSync(src, dest);
      log({ seq: e.seq, done: true });
      writes.push({ change: ch.id, op: 'move', rel: ch.file, dest });
      continue;
    }
    const ws = rule.transform(dir, ch) || [];
    for (const w of ws) {
      const target = abs(dir, w.rel);
      const before = readBuf(dir, w.rel);
      if (before !== null && Buffer.compare(before, w.after) === 0) continue;
      const e = { seq: ++seq, change: ch.id, op: 'write', rel: w.rel, created: before === null, pre: null, beforeSha: before ? sha(before) : null, afterSha: sha(w.after), dirs: [] };
      if (before !== null && preDir) { e.pre = String(e.seq); fs.writeFileSync(path.join(preDir, e.pre), before); }
      let d = path.dirname(target);
      while (!fs.existsSync(d)) { e.dirs.push(d); d = path.dirname(d); }
      log(e);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.' + process.pid + '.adopt.tmp';
      fs.writeFileSync(tmp, w.after);
      fs.renameSync(tmp, target);
      if (sha(fs.readFileSync(target)) !== e.afterSha) throw new Error('read-back mismatch: ' + w.rel);
      log({ seq: e.seq, done: true });
      writes.push({ change: ch.id, op: 'write', rel: w.rel, created: e.created });
    }
  }
  // Engine items: one transaction on dir.
  const items = chosen.filter((c) => c.engine).map((c) => c.item);
  let tx = null;
  if (items.length) {
    const resolve = {};
    for (const c of chosen) if (c.engine && c.conflict) resolve[c.item] = 'replace';
    const p = planIn(ad, ctx, dir, items, o.stateDir, resolve);
    const v = PL.planVerdict(p);
    if (v.code) throw new Error('profile items cannot apply: ' + v.line);
    const highRisk = p.highRisk.concat(p.needsAck);
    const res = await TX.applyPlan(p, { model: ctx.rmodel, dataDir: o.stateDir, deps: { git: ctx.git || gitFor(), recycle: o.trash }, confirm: true, acks: highRisk.filter((h) => (o.acks || []).includes(h)) });
    if (!res.ok) throw new Error('profile items: ' + res.line);
    tx = res.tx;
    const owner = items.map((i) => i + '@profile').join(',');
    for (const wr of res.written || []) {
      if (wr.startsWith('repo:')) writes.push({ change: owner, op: 'profile', rel: wr.slice(5) });
      else if (wr.startsWith('git:')) writes.push({ change: owner, op: 'git-config', rel: '.git/config', key: wr.slice(4) });
    }
  }
  void byId;
  return { tx, writes };
}

// A trash "recycle" for files the engine created inside a copy or a probe dir: a move
// into the adoption's trash folder, never an unlink.
function trashFor(ad) {
  let n = 0;
  return async (p) => {
    const d = path.join(ad.dir, 'trash', String(process.pid) + '-' + (n++));
    fs.mkdirSync(d, { recursive: true });
    fs.renameSync(p, path.join(d, path.basename(p)));
    return true;
  };
}

// Undo the working copy's last apply: the engine transaction, then the rule journal in
// reverse (each file must still hold the bytes adopt wrote; anything else stops with the
// list), then prove the pristine tree hash (I5).
async function resetCopy(ad, ctx) {
  if (!ad.applied) return { ok: true, line: 'nothing applied' };
  const a = ad.applied;
  const problems = [];
  if (a.tx) {
    const r = await TX.revertTx(path.join(ad.dir, 'state'), a.tx, { deps: { git: ctx.git || gitFor(), recycle: trashFor(ad) }, confirm: true });
    if (!r.ok || (r.flagged && r.flagged.length)) problems.push('profile items: ' + (r.flagged || []).join('; ') + (r.ok ? '' : ' ' + r.line));
  }
  const jdir = path.join(ad.dir, 'applies', String(a.seq));
  const lines = (() => { try { return fs.readFileSync(path.join(jdir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (e) { return []; } })();
  const done = new Set(lines.filter((l) => l.done).map((l) => l.seq));
  const entries = lines.filter((l) => l.op && done.has(l.seq)).reverse();
  const trash = trashFor(ad);
  for (const e of entries) {
    if (e.op === 'move') {
      if (!fs.existsSync(e.dest)) { problems.push(e.rel + ': archived copy missing'); continue; }
      fs.mkdirSync(path.dirname(abs(ad.copyDir, e.rel)), { recursive: true });
      fs.renameSync(e.dest, abs(ad.copyDir, e.rel));
      continue;
    }
    const cur = readBuf(ad.copyDir, e.rel);
    if (cur === null || sha(cur) !== e.afterSha) { problems.push(e.rel + ': changed after adopt wrote it; kept'); continue; }
    if (e.pre) fs.writeFileSync(abs(ad.copyDir, e.rel), fs.readFileSync(path.join(jdir, 'pre', e.pre)));
    else await trash(abs(ad.copyDir, e.rel));
    for (const d of e.dirs || []) { try { fs.rmdirSync(d); } catch (x) { /* not empty */ } }
  }
  const now = CP.manifest(ad.copyDir);
  ad.applied = null;
  ad.lastCheck = null;
  saveAdoption(ad);
  if (now.hash !== ad.copyHash) {
    const man = readJson(path.join(ad.dir, 'copy-manifest.json')) || { files: {} };
    const diff = [];
    for (const [rel, f] of Object.entries(now.files)) if (!man.files[rel] || man.files[rel].sha !== f.sha) diff.push(rel);
    for (const rel of Object.keys(man.files)) if (!now.files[rel]) diff.push(rel + ' (missing)');
    problems.push('the copy is not back at its pristine state: ' + diff.slice(0, 8).join(', ') + (diff.length > 8 ? ', ...' : '') + (diff.length ? '' : ' (dirs differ)'));
  }
  return { ok: problems.length === 0, problems, line: problems.length ? 'reset of the copy stopped: ' + problems[0] : 'the copy is back at its pristine state (tree hash ' + ad.copyHash.slice(0, 12) + ')' };
}

// The ledger (I2): for every original file, its sha before and in the copy, and for a
// changed / moved file every removed line range, the change that did it and the place its
// bytes went. verifyLedger() recomputes it from both trees.
function buildLedger(ad, writes) {
  const man = readJson(path.join(ad.dir, 'copy-manifest.json'));
  const files = {};
  const owner = new Map();
  for (const w of writes) if (!owner.has(w.rel)) owner.set(w.rel, w);
  for (const [rel, f] of Object.entries(man.files)) {
    const now = readBuf(ad.copyDir, rel);
    const nowSha = now ? sha(now) : null;
    if (nowSha === f.sha) continue;
    const before = readBuf(ad.baseDir, rel);
    const moved = writes.find((w) => w.op === 'move' && (rel === w.rel || rel.startsWith(w.rel + '/')));
    const rec = { before: f.sha, after: nowSha, change: moved ? moved.change : owner.has(rel) ? owner.get(rel).change : null };
    if (moved) { rec.movedTo = path.join(moved.dest, ...rel.slice(moved.rel.length).split('/').filter(Boolean)); rec.movedSha = (() => { const b = fs.existsSync(rec.movedTo) ? fs.readFileSync(rec.movedTo) : null; return b ? sha(b) : null; })(); }
    else if (now) { const hs = hunks(before, now); rec.hunks = hs.map((h) => ({ o: h.o, n: h.n, removed: h.removed.length, hash: sha(Buffer.from(h.removed.join('\n'), 'latin1')) })); }
    files[rel] = rec;
  }
  const added = [];
  const nowMan = CP.manifest(ad.copyDir);
  for (const rel of Object.keys(nowMan.files)) if (!man.files[rel]) added.push({ file: rel, change: owner.has(rel) ? owner.get(rel).change : null });
  return { schema: 1, adoption: ad.id, at: new Date().toISOString(), files, added };
}

function verifyLedger(ad) {
  const L = readJson(path.join(ad.dir, 'adopt-ledger.json'));
  const man = readJson(path.join(ad.dir, 'copy-manifest.json'));
  const problems = [];
  if (!L || !man) return { ok: false, problems: ['no ledger'] };
  for (const [rel, f] of Object.entries(man.files)) {
    const now = readBuf(ad.copyDir, rel);
    const nowSha = now ? sha(now) : null;
    if (nowSha === f.sha) { if (L.files[rel]) problems.push(rel + ': ledger says changed, copy says unchanged'); continue; }
    const rec = L.files[rel];
    if (!rec) { problems.push(rel + ': changed in the copy but not in the change report'); continue; }
    if (!rec.change) problems.push(rel + ': changed by no accepted change');
    const before = readBuf(ad.baseDir, rel);
    if (!before || sha(before) !== f.sha) problems.push(rel + ': the pristine snapshot lost its bytes');
    if (rec.movedTo) { if (rec.movedSha !== f.sha || !fs.existsSync(rec.movedTo) || sha(fs.readFileSync(rec.movedTo)) !== f.sha) problems.push(rel + ': moved bytes not found at ' + rec.movedTo); continue; }
    if (!now) { problems.push(rel + ': missing from the copy and not recorded as moved'); continue; }
    const hs = hunks(before, now);
    const want = hs.map((h) => ({ o: h.o, n: h.n, removed: h.removed.length, hash: sha(Buffer.from(h.removed.join('\n'), 'latin1')) }));
    if (JSON.stringify(want) !== JSON.stringify(rec.hunks || [])) problems.push(rel + ': the recorded line ranges do not match the copy');
  }
  return { ok: problems.length === 0, problems };
}

// ------------------------------------------------------------------ the facade

// One API for the CLI and the server routes (L5). o: {engine, dataDir, deps: {git,
// recycle, runCheck, zip, unzip, adoptRoot, detect, now}, platform}.
function openAdopt(o) {
  const engine = o.engine;
  const deps = o.deps || {};
  const root = adoptRoot(o.dataDir, deps);
  const ctxFor = (ad, extra) => Object.assign({ model: engine.model, selection: extra && extra.selection ? extra.selection : engine.selection(), detect: deps.detect, git: deps.git && deps.git.get ? deps.git : null, platform: o.platform }, extra || {});
  const reportOf = (ad) => readJson(path.join(ad.dir, 'adopt-report.json'));
  const load = (id) => {
    if (id === 'last') { const l = listAdoptions(root); return l.length ? loadAdoption(root, l[l.length - 1].id) : null; }
    return loadAdoption(root, id);
  };
  const withReport = (ad, extra) => { const ctx = ctxFor(ad, extra); ctx.report = reportOf(ad); ctx.rmodel = repoModel(engine.model, fs.existsSync(path.join(ad.baseDir, '.git'))); return ctx; };

  const api = {
    root,
    list: () => listAdoptions(root),
    load,
    status: (ad) => statusOf(ad),
    sizePreview: (original) => CP.sizePreview(path.resolve(original)),

    // 1-3. Copy and scan; writes only under the adoption dir.
    async start(original, a) {
      a = a || {};
      original = path.resolve(original);
      if (!fs.existsSync(original) || !fs.statSync(original).isDirectory()) return { ok: false, code: 1, line: 'refused: no such project folder' };
      const r = path.resolve(root);
      if (r === original || r.startsWith(original + path.sep)) return { ok: false, code: 1, line: 'refused: the adoption folder would be inside the project' };
      if (original.startsWith(r + path.sep)) return { ok: false, code: 1, line: 'refused: that folder is an adoption copy' };
      const now = a.now || deps.now || new Date();
      let id = slug(path.basename(original)) + '-' + stamp(now);
      for (let i = 1; fs.existsSync(path.join(root, id)); i++) id = slug(path.basename(original)) + '-' + stamp(now) + '-' + i;
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      const c = CP.makeCopy(original, dir, { exclude: a.exclude || [] });
      writeJson(path.join(dir, 'copy-manifest.json'), c.manifest);
      const head = fs.existsSync(path.join(c.baseDir, '.git')) ? spawnSync('git', ['-C', c.baseDir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }) : null;
      const ad = { schema: 1, id, original, created: now.toISOString(), method: 'copy', exclude: a.exclude || [], excludedPresent: c.manifest.excluded, origHash: c.origHash, copyHash: c.copyHash,
        origHead: head && head.status === 0 ? head.stdout.trim() : null, values: a.values || {}, preset: a.preset || null, accepted: [], acks: [], applied: null, checks: null, lastCheck: null, runs: [] };
      Object.assign(ad, { dir, baseDir: c.baseDir, copyDir: c.copyDir, promote: null, removed: null });
      // The user's template overrides are read (never written) into the scan state.
      const ov = path.join(P.profileStateDir(o.dataDir), 'overrides');
      for (const s of ['state', 'state-scan']) if (fs.existsSync(ov)) CP.copyTree(fs, ov, path.join(dir, s, 'profile', 'overrides'));
      const ctx = ctxFor(ad, { selection: a.selection });
      const rep = scan(ad, ctx);
      writeJson(path.join(dir, 'adopt-report.json'), rep);
      fs.writeFileSync(path.join(dir, 'adopt-report.txt'), reportText(rep, { diffs: true }));
      saveAdoption(ad);
      return { ok: true, code: 0, adoption: ad, report: rep, line: 'adoption ' + id + ': copy made (' + Object.keys(c.manifest.files).length + ' files, ' + Math.round(c.manifest.bytes / KB) + ' KB), ' + rep.changes.filter((x) => !x.reportOnly).length + ' change(s) proposed' };
    },
    report: (ad) => reportOf(ad),
    reportText: (ad, a) => reportText(reportOf(ad), a),

    // 4. Choose (saved; nothing written to the copy).
    choose(ad, a) {
      a = a || {};
      const rep = reportOf(ad);
      const r = resolveAccept(rep, a.accept || [], a.acks || [], { breakConfirmed: a.breakConfirmed === true });
      ad.accepted = r.ids;
      ad.acks = (a.acks || []).slice();
      writeJson(path.join(ad.dir, 'selection.json'), { accepted: r.ids, acks: ad.acks, skipped: r.skipped, at: new Date().toISOString() });
      saveAdoption(ad);
      return Object.assign({ ok: true, code: 0, line: r.ids.length + ' change(s) chosen' + (r.skipped.length ? ', ' + r.skipped.length + ' not taken' : '') }, r);
    },

    // 5. Apply the chosen changes to the copy, always from its pristine state.
    async apply(ad, a) {
      a = a || {};
      if (ad.promote) return { ok: false, code: 1, line: 'refused: already promoted; start a new adoption for more changes' };
      if (a.confirm !== true) return { ok: true, code: 0, dryRun: true, line: 'dry run: would apply ' + ad.accepted.length + ' change(s) to the copy (add --apply --yes)' };
      const ctx = withReport(ad);
      if (ad.applied) { const rs = await resetCopy(ad, ctx); if (!rs.ok) return { ok: false, code: 1, line: 'refused: ' + rs.line }; }
      const seq = (ad.runs || []).length + 1;
      const jdir = path.join(ad.dir, 'applies', String(seq));
      fs.mkdirSync(jdir, { recursive: true });
      let res;
      try {
        res = await applyChanges(ad, ctx, ad.copyDir, ad.accepted, { journalDir: jdir, strayRoot: path.join(ad.dir, 'archive', 'stray-' + seq), stateDir: path.join(ad.dir, 'state'), trash: trashFor(ad), acks: ad.acks });
      } catch (e) {
        ad.applied = { seq, tx: null, partial: true };
        const tj = TX.listTx(path.join(ad.dir, 'state'));
        const last = tj.length ? tj[tj.length - 1] : null;
        if (last && last.ok && !last.reverted) ad.applied.tx = last.id;
        const rs = await resetCopy(ad, ctx);
        return { ok: false, code: 1, line: 'failed: ' + String(e.message || e).slice(0, 200) + (rs.ok ? ' - the copy is back at its pristine state' : ' - ' + rs.line) };
      }
      ad.applied = { seq, tx: res.tx, at: new Date().toISOString(), ids: ad.accepted.slice() };
      ad.runs = (ad.runs || []).concat([{ seq, ids: ad.accepted.slice(), at: ad.applied.at }]);
      ad.lastCheck = null;
      const ledger = buildLedger(ad, res.writes);
      writeJson(path.join(ad.dir, 'adopt-ledger.json'), ledger);
      const v = verifyLedger(ad);
      saveAdoption(ad);
      if (!v.ok) return { ok: false, code: 1, line: 'failed: the no-byte-lost check did not hold: ' + v.problems[0], problems: v.problems };
      return { ok: true, code: 0, applied: ad.applied, ledger, line: 'applied ' + ad.accepted.length + ' change(s) to the copy (' + Object.keys(ledger.files).length + ' file(s) changed or moved, ' + ledger.added.length + ' added); no byte lost (ledger verified)' };
    },
    verifyLedger: (ad) => verifyLedger(ad),

    // 6. Function check.
    detectChecks: (ad) => FC.detectChecks(ad.baseDir, { platform: o.platform }),
    setChecks(ad, a) {
      a = a || {};
      const base = ad.checks && ad.checks.list ? ad.checks.list : FC.detectChecks(ad.baseDir, { platform: o.platform }).checks;
      const list = FC.editChecks(base, a.edits || []);
      ad.checks = { list, confirmed: a.confirm === true, at: new Date().toISOString() };
      saveAdoption(ad);
      return { ok: true, code: 0, checks: ad.checks, line: list.length + ' check(s)' + (ad.checks.confirmed ? ' confirmed' : ' proposed (confirm with --confirm)') };
    },
    async check(ad, a) {
      a = a || {};
      if (!ad.applied) return { ok: false, code: 1, line: 'refused: apply the chosen changes to the copy first' };
      if (!ad.checks || !ad.checks.confirmed) return { ok: false, code: 1, line: 'refused: confirm the checks first (profile adopt checks ' + ad.id + ' --confirm)' };
      const ctx = withReport(ad);
      const run = deps.runCheck || FC.defaultRun;
      const sbs = await FC.sideBySide({ adoptDir: ad.dir, checks: ad.checks.list, run,
        prepareOriginal: (d) => CP.copyTree(fs, ad.baseDir, d), prepareCopy: (d) => CP.copyTree(fs, ad.copyDir, d) });
      const result = { hash: PR.confirmHash(ad.copyDir), at: new Date().toISOString(), verdict: sbs.verdict, rows: sbs.rows.map(slimRow), bisect: [] };
      if (sbs.verdict === 'FAILED' && a.bisect !== false && ad.accepted.length) {
        for (const row of sbs.rows.filter((x) => x.verdict === 'WORSE')) {
          const check = ad.checks.list.find((c) => c.id === row.id);
          const history = [];
          const probe = async (subset) => {
            const s = await FC.runIn(ad.dir, 'probe', async (d) => {
              CP.copyTree(fs, ad.baseDir, d);
              const sd = d + '.state';
              await applyChanges(ad, ctx, d, subset, { strayRoot: d + '.stray', stateDir: sd, trash: async (p) => { fs.renameSync(p, p + '.adopt-trash'); return true; }, acks: ad.acks });
            }, check, run);
            const cmp = FC.compare(row.original, s);
            history.push({ subset, worse: cmp.verdict === 'WORSE', newlyFailing: cmp.newlyFailing });
            return cmp.verdict === 'WORSE';
          };
          const b = await FC.bisect(ad.accepted.slice(), probe, { knownWorse: true });
          for (const c of b.culprits) { const h = history.find((x) => x.worse && x.subset[x.subset.length - 1] === c.id); c.newlyFailing = h ? h.newlyFailing : []; }
          result.bisect.push({ check: row.id, culprits: b.culprits, probes: b.probes, limitPerCulprit: Math.ceil(Math.log2(Math.max(2, ad.accepted.length))) + 1 });
          cleanProbeSide(ad);
        }
      }
      ad.lastCheck = result;
      saveAdoption(ad);
      return { ok: true, code: sbs.verdict === 'FAILED' ? 1 : 0, result, line: sbs.verdict === 'FAILED' ? 'function check FAILED: promotion is blocked' : 'function check passed: ' + sbs.rows.length + ' check(s) same or better' };
    },

    // Revert before promote: one change, a module, or all (pristine, byte-identical).
    async revert(ad, a) {
      a = a || {};
      if (ad.promote) {
        if (!a.all) return { ok: false, code: 1, line: 'refused: after promote only --all reverts (it puts the original back)' };
        return PR.unpromote(ad, { confirm: a.confirm, now: a.now });
      }
      const rep = reportOf(ad);
      let keep = ad.accepted.slice();
      if (a.all) keep = [];
      else if (a.change) { if (!keep.includes(a.change)) return { ok: false, code: 1, line: 'refused: change ' + a.change + ' is not applied' }; keep = keep.filter((x) => x !== a.change); }
      else if (a.module) { const ids = rep.changes.filter((c) => c.module === a.module).map((c) => c.id); if (!keep.some((x) => ids.includes(x))) return { ok: false, code: 1, line: 'refused: nothing of module ' + a.module + ' is applied' }; keep = keep.filter((x) => !ids.includes(x)); }
      else return { ok: false, code: 1, line: 'revert needs --change <id>, --module <id> or --all' };
      if (a.confirm !== true) return { ok: true, code: 0, dryRun: true, line: 'dry run: the copy would keep ' + keep.length + ' of ' + ad.accepted.length + ' change(s) (add --apply --yes)' };
      const ctx = withReport(ad);
      const rs = await resetCopy(ad, ctx);
      if (!rs.ok) return { ok: false, code: 1, line: 'refused: ' + rs.line };
      // A "works" confirmation is for one copy state: it is set aside (kept) on any revert.
      const cf = path.join(ad.dir, 'confirm.json');
      if (fs.existsSync(cf)) fs.renameSync(cf, path.join(ad.dir, 'confirm-superseded-' + Date.now() + '.json'));
      ad.accepted = keep;
      saveAdoption(ad);
      if (!keep.length) {
        const h = CP.manifest(ad.copyDir).hash;
        return { ok: h === ad.copyHash, code: h === ad.copyHash ? 0 : 1, line: 'reverted all: the copy is byte-identical to the original (tree hash ' + h.slice(0, 12) + ')' };
      }
      const r = await api.apply(ad, { confirm: true });
      return Object.assign(r, { line: (r.ok ? 'reverted ' + (a.change || 'module ' + a.module) + '; ' : '') + r.line });
    },

    // 7. "works": the typed word, pinned to the copy's hash.
    works(ad, a) {
      a = a || {};
      if (a.word !== 'works') return { ok: false, code: 1, line: 'refused: type the word works to confirm (--type works)' };
      if (!ad.applied) return { ok: false, code: 1, line: 'refused: nothing applied to the copy' };
      const h = PR.confirmHash(ad.copyDir);
      if (!ad.lastCheck || ad.lastCheck.hash !== h) return { ok: false, code: 1, line: 'refused: run the function check on this copy state first' };
      if (ad.lastCheck.verdict !== 'passed') return { ok: false, code: 1, line: 'refused: the function check FAILED on this copy state; revert the change bisect named first' };
      const rec = { hash: h, at: (a.now || new Date()).toISOString(), check: ad.lastCheck.verdict, changes: ad.accepted.length };
      writeJson(path.join(ad.dir, 'confirm.json'), rec);
      return { ok: true, code: 0, confirm: rec, line: 'confirmed: the copy works (state ' + h.slice(0, 12) + ')' };
    },
    diffStat(ad) {
      const L = readJson(path.join(ad.dir, 'adopt-ledger.json')) || { files: {}, added: [] };
      return { changed: Object.keys(L.files).length, added: L.added.length, files: Object.keys(L.files).concat(L.added.map((x) => x.file)) };
    },

    // 8. Promote / re-check / remove the original.
    async promote(ad, a) {
      a = a || {};
      const r = PR.promote(ad, { method: a.method, confirm: a.confirm, runId: a.runId, now: a.now });
      if (!r.ok || r.dryRun) return r;
      ad.promote = r.promote;
      if (a.recheck === false || !ad.checks || !ad.checks.list.length) return r;
      // Re-run the function check once on the promoted project; WORSE = automatic un-promote.
      const run = deps.runCheck || FC.defaultRun;
      const sbs = await FC.sideBySide({ adoptDir: ad.dir, checks: ad.checks.list, run, prepareOriginal: (d) => CP.copyTree(fs, ad.baseDir, d), prepareCopy: (d) => CP.copyTree(fs, ad.original, d, { skip: (x) => CP.isExcluded(x, ad.excludedPresent || []) }) });
      if (sbs.verdict === 'FAILED') {
        const u = PR.unpromote(ad, { confirm: true });
        ad.promote = null;
        return { ok: false, code: 1, line: 'promoted, but the re-check on the promoted project was WORSE: automatically un-promoted (' + u.line + ')', recheck: sbs.rows.map(slimRow) };
      }
      return Object.assign(r, { recheck: sbs.rows.map(slimRow), line: r.line + '; re-check on the promoted project passed' });
    },
    unpromote: (ad, a) => PR.unpromote(ad, a || {}),
    removeOriginal: (ad, a) => PR.removeOriginal(ad, Object.assign({}, a || {}, { deps: Object.assign({ recycle: deps.recycle, zip: deps.zip, unzip: deps.unzip }, (a && a.deps) || {}) })),
  };
  return api;
}

function slimRow(r) {
  const s = (x) => ({ code: x.code, ok: x.ok, ms: x.ms, timedOut: x.timedOut, counts: x.counts });
  return { id: r.id, kind: r.kind, cmd: r.cmd, original: s(r.original), copy: s(r.copy), verdict: r.verdict, why: r.why, newlyFailing: r.newlyFailing, firstDiff: r.firstDiff, originalLines: r.original.lines.slice(-40), copyLines: r.copy.lines.slice(-40) };
}

// Probe dirs leave .state / .stray siblings in runs/: cleared with the run dirs.
function cleanProbeSide(ad) {
  const root = FC.runsRoot(ad.dir);
  for (const n of (() => { try { return fs.readdirSync(root); } catch (e) { return []; } })()) {
    if (/\.(state|stray)$/.test(n)) { try { FC.clearRunDir(ad.dir, path.join(root, n)); } catch (e) { /* next prune */ } }
  }
}

// ------------------------------------------------------------------ CLI

function sideBySideText(result) {
  const L = [];
  const cell = (x) => (x.timedOut ? 'timed out' : 'exit ' + x.code) + (x.counts && x.counts.passed !== null ? ', ' + x.counts.passed + ' pass / ' + x.counts.failed + ' fail / ' + x.counts.skipped + ' skip' : '') + ', ' + (x.ms / 1000).toFixed(1) + 's';
  L.push('check'.padEnd(16) + ' ' + 'original'.padEnd(40) + ' ' + 'conformed copy'.padEnd(40) + ' verdict');
  for (const r of result.rows) {
    L.push((r.id + ' (' + r.cmd + ')').slice(0, 16).padEnd(16) + ' ' + cell(r.original).padEnd(40) + ' ' + cell(r.copy).padEnd(40) + ' ' + r.verdict);
    if (r.verdict !== 'same') for (const w of r.why) L.push('    ' + w);
    if (r.firstDiff && r.verdict === 'WORSE') L.push('    first difference: original "' + (r.firstDiff.original || '') + '" / copy "' + (r.firstDiff.copy || '') + '"');
  }
  for (const b of result.bisect || []) {
    for (const c of b.culprits) L.push('bisect: ' + b.check + ' is WORSE because of ' + c.id + ' (' + c.probes + ' re-run(s), limit ' + b.limitPerCulprit + ')' + (c.newlyFailing && c.newlyFailing.length ? ' - breaks: ' + c.newlyFailing.join(', ') : ''));
  }
  return L;
}

const SUBS = new Set(['list', 'status', 'report', 'choose', 'apply', 'checks', 'check', 'revert', 'works', 'promote', 'remove-original', 'unpromote']);

function makeAsk(deps) {
  if (typeof deps.ask === 'function') return deps.ask;
  if (!process.stdin.isTTY) return null;
  return (q) => new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q + ' ', (ans) => { rl.close(); resolve(String(ans || '').trim()); });
  });
}

function parseVars(list) {
  const o = {};
  for (const v of list || []) { const i = String(v).indexOf('='); if (i > 0) o[String(v).slice(0, i)] = String(v).slice(i + 1); }
  return o;
}

// `claude-console profile adopt ...`. a: parsed args (a._[0] === 'adopt'); x: {engine,
// out, deps, dataDir, configDir}. Exit codes: 0 ok, 1 refused / failed / check FAILED.
async function cliAdopt(a, x) {
  const out = x.out || ((s) => process.stdout.write(s + '\n'));
  const deps = x.deps || {};
  const json = (o) => out(JSON.stringify(o));
  const ad0 = openAdopt({ engine: x.engine, dataDir: x.dataDir, deps, platform: deps.platform });
  const sub = SUBS.has(a._[1]) ? a._[1] : null;
  const runId = deps.runId || (process.pid + '-' + Date.now());
  const yes = a.apply === true && a.yes === true;
  const say = (r) => { if (a.json) json(r); else out(r.line); return r.code === undefined ? (r.ok ? 0 : 1) : r.code; };
  const getAd = () => {
    const id = a.last ? 'last' : a._[2];
    if (!id) { out('name the adoption id (profile adopt list) or --last'); return null; }
    const ad = ad0.load(id);
    if (!ad) { out('refused: no adoption ' + id); return null; }
    return ad;
  };
  const accSpecs = a.accept || [];

  if (!sub) {
    const dir = a._[1];
    if (!dir) { out('usage: profile adopt <project-dir> [--report] | list | status|report|choose|apply|checks|check|revert|works|promote|remove-original <id>'); return 1; }
    const values = Object.assign({}, x.engine.selection().variables, parseVars(a.var));
    let selection;
    if (typeof a.preset === 'string') { const ps = x.engine.presetSelection(a.preset, { values }); if (!ps.ok) { out('refused: ' + ps.reason); return 1; } selection = ps.selection; }
    const pv = ad0.sizePreview(dir);
    if (!a.json) out('copy first: ' + pv.files + ' file(s), ' + Math.round(pv.bytes / 1024) + ' KB' + (pv.largest.length ? ' (largest: ' + pv.largest.slice(0, 3).map((l) => l.name + ' ' + Math.round(l.bytes / 1024) + ' KB').join(', ') + ')' : '') + (a.exclude.length ? '; excluded: ' + a.exclude.join(', ') : '') + '. The original is never written.');
    const st = await ad0.start(dir, { exclude: a.exclude, values, selection, preset: a.preset || null });
    if (!st.ok) return say(st);
    const ad = st.adoption;
    if (a.json && (a.report || !(yes || makeAsk(deps)))) { json({ adoption: ad.id, report: st.report }); return 0; }
    out(st.line);
    out(reportText(st.report, { diffs: a.diff === true }).replace(/\n$/, ''));
    out('full report with every diff: ' + path.join(ad.dir, 'adopt-report.txt'));
    if (a.report) return 0;
    if (accSpecs.length || yes) return nonInteractive(ad0, ad, a, out, runId);
    const ask = makeAsk(deps);
    if (!ask) { out('next: profile adopt choose ' + ad.id + ' --accept all-safe|module:<id>|<change-id>, then apply ' + ad.id + ' --apply --yes'); return 0; }
    return interactive(ad0, ad, ask, out, runId, a);
  }

  if (sub === 'list') { const l = ad0.list(); if (a.json) json(l); else if (!l.length) out('no adoptions'); else l.forEach((r) => out(r.id + '  ' + r.status + '  ' + r.project)); return 0; }
  const ad = getAd();
  if (!ad) return 1;
  if (sub === 'status') { const s = { id: ad.id, project: path.basename(ad.original), status: ad0.status(ad), accepted: ad.accepted.length, applied: !!ad.applied, check: ad.lastCheck ? ad.lastCheck.verdict : null, promote: ad.promote ? ad.promote.method : null, removed: ad.removed ? ad.removed.method : null }; if (a.json) json(s); else out(Object.entries(s).map(([k, v]) => k + ': ' + v).join('\n')); return 0; }
  if (sub === 'report') { out(ad0.reportText(ad, { diffs: a.diff === true }).replace(/\n$/, '')); return 0; }
  if (sub === 'choose') { const r = ad0.choose(ad, { accept: accSpecs, acks: a.ack, breakConfirmed: a['break-ok'] === true }); if (!a.json) { out(r.line); r.skipped.forEach((s) => out('  not taken: ' + s.id + ' - ' + s.why)); r.added.forEach((s) => out('  also (needed): ' + s)); } else json(r); return 0; }
  if (sub === 'apply') {
    if (accSpecs.length) { const r = ad0.choose(ad, { accept: accSpecs, acks: a.ack, breakConfirmed: a['break-ok'] === true }); r.skipped.forEach((s) => out('  not taken: ' + s.id + ' - ' + s.why)); }
    return say(await ad0.apply(ad, { confirm: yes }));
  }
  if (sub === 'checks') {
    const r = ad0.setChecks(ad, { edits: a.check, confirm: a.confirm === true });
    if (a.json) { json(r); return 0; }
    for (const c of r.checks.list) out('  ' + c.id.padEnd(6) + ' ' + c.cmd + '  (from ' + c.source + ')');
    out(r.line);
    return 0;
  }
  if (sub === 'check') {
    const r = await ad0.check(ad, {});
    if (a.json) { json(r); return r.code; }
    if (r.result) sideBySideText(r.result).forEach(out);
    out(r.line);
    if (r.result && r.result.bisect) for (const b of r.result.bisect) for (const c of b.culprits) out('revert it with: claude-console profile adopt revert ' + ad.id + ' --change ' + c.id + ' --apply --yes');
    return r.code;
  }
  if (sub === 'revert') return say(await ad0.revert(ad, { change: typeof a.change === 'string' ? a.change : null, module: typeof a.module === 'string' ? a.module : null, all: a.all === true, confirm: yes }));
  if (sub === 'works') {
    const r = ad0.works(ad, { word: typeof a.type === 'string' ? a.type : null });
    if (r.ok && !a.json) { const d = ad0.diffStat(ad); out('copy vs original: ' + d.changed + ' file(s) changed or moved, ' + d.added + ' added (full diff: ' + path.join(ad.dir, 'adopt-report.txt') + ')'); }
    return say(r);
  }
  if (sub === 'promote') return say(await ad0.promote(ad, { method: typeof a.method === 'string' ? a.method : 'swap', confirm: yes, runId }));
  if (sub === 'unpromote') return say(ad0.unpromote(ad, { confirm: yes }));
  if (sub === 'remove-original') return say(await ad0.removeOriginal(ad, { method: typeof a.method === 'string' ? a.method : 'recycle', phrase: typeof a.confirm === 'string' ? a.confirm : null, runId, confirm: yes, minAgeHours: a['min-age-hours'] !== undefined && a['min-age-hours'] !== true ? +a['min-age-hours'] : undefined }));
  return 1;
}

async function nonInteractive(api, ad, a, out, runId) {
  const r = api.choose(ad, { accept: a.accept, acks: a.ack, breakConfirmed: a['break-ok'] === true });
  out(r.line);
  r.skipped.forEach((s) => out('  not taken: ' + s.id + ' - ' + s.why));
  if (!(a.apply === true && a.yes === true)) { out('apply with: claude-console profile adopt apply ' + ad.id + ' --apply --yes'); return 0; }
  const ap = await api.apply(ad, { confirm: true });
  out(ap.line);
  if (!ap.ok) return 1;
  const ck = api.setChecks(ad, { edits: a.check, confirm: a['checks-ok'] === true });
  for (const c of ck.checks.list) out('  check ' + c.id + ': ' + c.cmd + ' (from ' + c.source + ')');
  if (a['checks-ok'] !== true) { out('confirm the checks: claude-console profile adopt checks ' + ad.id + ' --confirm [--check kind=command], then: profile adopt check ' + ad.id); return 0; }
  const k = await api.check(api.load(ad.id), {});
  if (k.result) sideBySideText(k.result).forEach(out);
  out(k.line);
  if (k.result) for (const b of k.result.bisect || []) for (const c of b.culprits) out('revert it with: claude-console profile adopt revert ' + ad.id + ' --change ' + c.id + ' --apply --yes');
  void runId;
  return k.code;
}

const yesNo = (s) => /^(y|yes)$/i.test(String(s || '').trim());

async function interactive(api, ad, ask, out, runId, a) {
  const rep = api.report(ad);
  const real = rep.changes.filter((c) => !c.reportOnly && !c.blocked);
  const accepted = [];
  const acks = [];
  const breakOk = new Set();
  for (const m of rep.modules) {
    const list = real.filter((c) => c.module === m.id);
    if (!list.length) continue;
    const ans = String(await ask('Module ' + m.id + ' (' + m.title + '): ' + list.length + ' change(s). [a] accept all for this module, [c] choose each, [n] none?')).toLowerCase();
    let take = [];
    if (ans === 'a' || ans === 'all') {
      take = list.slice();
      const risky = take.filter((c) => c.breakRisk);
      if (risky.length) {
        out('These changes may break the project: ' + risky.map((c) => c.id + ' (' + c.breakRisk.reasons[0] + ')').join('; '));
        if (yesNo(await ask('Include them too? [y/n]'))) risky.forEach((c) => breakOk.add(c.id)); else take = take.filter((c) => !c.breakRisk);
      }
    } else if (ans === 'c') {
      for (const c of list) {
        const head = c.id + ' - ' + c.op + (c.breakRisk ? ' - BREAK RISK: ' + c.breakRisk.reasons[0] : '') + ' - ' + c.why;
        if (yesNo(await ask(head + ' [y/n]'))) { take.push(c); if (c.breakRisk) breakOk.add(c.id); }
      }
    }
    for (const c of take) {
      if (c.needsPhrase && !acks.includes(c.item)) {
        const ph = await ask('High risk: type "' + c.needsPhrase + '" to include ' + c.item + ':');
        if (ph !== c.needsPhrase) { out('  not taken: ' + c.id); continue; }
        acks.push(c.item);
      }
      accepted.push(c.id);
    }
  }
  const ch = api.choose(ad, { accept: accepted, acks, breakConfirmed: true });
  out(ch.line);
  if (!ch.ids.length) { out('nothing chosen; the copy stays as the original. Remove it with the adoption folder when you like.'); return 0; }
  const ap = await api.apply(ad, { confirm: true });
  out(ap.line);
  if (!ap.ok) return 1;
  const det = api.setChecks(ad, { edits: a.check || [], confirm: false });
  out('The project\'s own checks (they run on the original and on the copy, each in a throwaway folder):');
  for (const c of det.checks.list) out('  ' + c.id + ': ' + c.cmd + '  (from ' + c.source + ')');
  let edits = [];
  for (;;) {
    const ans = String(await ask('Use these checks? [y] yes, [e] edit one, [n] skip the function check')).toLowerCase();
    if (ans === 'y' || ans === 'yes') break;
    if (ans === 'n') { out('no function check: promotion stays blocked until a check passes'); return 0; }
    if (ans === 'e') { const e = await ask('kind=command (e.g. test=npm test; empty command drops it):'); edits = edits.concat([e]); const r = api.setChecks(ad, { edits, confirm: false }); for (const c of r.checks.list) out('  ' + c.id + ': ' + c.cmd); }
  }
  api.setChecks(ad, { edits, confirm: true });
  for (;;) {
    const fresh = api.load(ad.id);
    Object.assign(ad, fresh);
    const r = await api.check(ad, {});
    if (r.result) sideBySideText(r.result).forEach(out);
    out(r.line);
    if (!r.ok && !r.result) return 1;
    if (r.result.verdict !== 'FAILED') break;
    const culprits = (r.result.bisect || []).flatMap((b) => b.culprits.map((c) => c.id));
    if (!culprits.length) { out('bisect could not name one change; revert changes with profile adopt revert ' + ad.id + ' --change <id>'); return 1; }
    let reverted = false;
    for (const c of [...new Set(culprits)]) {
      if (yesNo(await ask('Revert change ' + c + ' and run the checks again? [y/n]'))) {
        const rv = await api.revert(api.load(ad.id), { change: c, confirm: true });
        out(rv.line);
        if (!rv.ok) return 1;
        reverted = true;
      }
    }
    if (!reverted) { out('promotion stays blocked while a check is WORSE'); return 1; }
  }
  const cur = api.load(ad.id);
  const d = api.diffStat(cur);
  out('copy vs original: ' + d.changed + ' file(s) changed or moved, ' + d.added + ' added (full diff: ' + path.join(cur.dir, 'adopt-report.txt') + ')');
  const w = await ask('Type works to confirm the copy works (state ' + PR.confirmHash(cur.copyDir).slice(0, 12) + '):');
  const wr = api.works(cur, { word: w });
  out(wr.line);
  if (!wr.ok) return 1;
  const p = await ask('Type promote to make the conformed copy your project (the original is kept beside it), or press Enter to stop here:');
  if (p !== 'promote') { out('not promoted; later: claude-console profile adopt promote ' + cur.id + ' --apply --yes'); return 0; }
  const pr = await api.promote(api.load(cur.id), { method: 'swap', confirm: true, runId });
  out(pr.line);
  if (pr.ok) out('removing the original is a separate step for a later run: claude-console profile adopt remove-original ' + cur.id + ' --method recycle|zip --confirm "remove original ' + path.basename(cur.original) + '" --apply --yes');
  return pr.ok ? 0 : 1;
}

module.exports = {
  cliAdopt, openAdopt, scan, reportText, resolveAccept, applyChanges, resetCopy, buildLedger, verifyLedger, repoModel,
  hunks, crlfRequired, importers, splitSections, RULES, listAdoptions, loadAdoption, sideBySideText, ID_RE,
};
