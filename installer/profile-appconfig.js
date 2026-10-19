'use strict';
// CON-013 L9 (addendum a.3): the `app-config` contribution kind. Target: a detected app
// config file. Rules, each one a test in tests/machine-appconfig.test.js (L9) and in
// tests/profile-adapters.test.js (the L4 adapter surface):
//   - the parser is chosen by extension (xml / ini / json / vdf); a recipe may name it;
//   - it edits EXISTING keys only and refuses a new key, an ambiguous key, an object or
//     array target, or a changed type;
//   - it refuses while the owning process runs (never touch a running app or game);
//   - every change is opt-in: nothing is written without an accepted change id;
//   - pre-image as <file>.bak-<yyyy-mm-dd> beside the file (an existing same-day backup
//     is never overwritten: a second one the same day gets -2, -3 ...) AND in the
//     transaction's pre/ folder;
//   - only the value bytes change: encoding (UTF-8, UTF-8 BOM, UTF-16LE), line endings,
//     quoting and every other byte are kept (INTEGRATE-1: ported from L4);
//   - each key is read back; the first mismatch rolls every file of the run back;
//   - revert restores the byte-identical pre-image, refusing a file changed since.
// An edit: {id, kind: 'app-config', target: {file, key}, to, format?, processes?,
// requires?: [ids]}. The tx folder holds journal.json and pre/.
// Key syntax: json "a.b.c"; ini "Section.Key" ("Key" before any section; "Key value"
// and "key = value" lines); xml "tag", "tag@attr", "tag[attr=value]@attr2"; vdf "a/b/c".
//
// Three surfaces share one parser core:
//   plan / preview / apply / revert       - L9's edit-list API (machine advisors)
//   createAppConfigAdapter(opts)          - L4's adapter contract (profile-oscommon.js)
//   createAdapter(opts)                   - the engine adapter profile-tx.js calls
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXT = { '.xml': 'xml', '.ini': 'ini', '.json': 'json', '.vdf': 'vdf', '.acf': 'vdf' };
const PROC_RE = /^[A-Za-z0-9 ._-]{1,64}\.exe$/i;

function formatFor(file, named) {
  if (named) return ['ini', 'json', 'xml', 'vdf'].includes(named) ? named : null;
  return EXT[path.extname(String(file)).toLowerCase()] || null;
}

// L4 name; .acf is a vdf file too.
function formatOf(file) {
  return formatFor(file);
}

// ---------------------------------------------------------------- encodings

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.slice(2).toString('utf16le'), enc: 'utf16le' };
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.slice(3).toString('utf8'), enc: 'utf8bom' };
  return { text: buf.toString('utf8'), enc: 'utf8' };
}

function encode(text, enc) {
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

function readText(file) {
  return decode(fs.readFileSync(file));
}

// ---------------------------------------------------------------- locators
// Each returns {hits: [{value, start, end, enc(v) -> replacement text, type?}]} with
// start/end spanning the value bytes only, or throws when the file does not parse.

function splitKey(k) {
  const i = String(k).indexOf('.');
  return i < 0 ? ['', String(k)] : [String(k).slice(0, i), String(k).slice(i + 1)];
}

function lineSpans(text) {
  const out = [];
  let s = 0;
  while (s <= text.length) {
    let e = text.indexOf('\n', s);
    if (e < 0) e = text.length;
    let body = e;
    if (body > s && text[body - 1] === '\r') body--;
    out.push({ s, line: text.slice(s, body) });
    if (e >= text.length) break;
    s = e + 1;
  }
  return out;
}

// ini: "Key value" (space separated, Civ VI style) and "key = value" lines under
// [Section] headers; ';' and '#' start comments; a "quoted" value keeps its quotes.
const INI_LINE = /^(\s*)([^;#[\s=][^=\s]*)(\s*=\s*|\s+)(.*?)(\s*)$/;

function iniHits(text, key) {
  const [sec, name] = splitKey(key);
  let cur = '';
  const hits = [];
  for (const l of lineSpans(text)) {
    const h = /^\s*\[([^\]]*)\]\s*$/.exec(l.line);
    if (h) { cur = h[1].trim(); continue; }
    const m = INI_LINE.exec(l.line);
    if (!m || cur.toLowerCase() !== sec.toLowerCase() || m[2].toLowerCase() !== name.toLowerCase()) continue;
    const start = l.s + m[1].length + m[2].length + m[3].length;
    const raw = m[4];
    const q = raw.length >= 2 && raw[0] === '"' && raw[raw.length - 1] === '"';
    hits.push({ value: q ? raw.slice(1, -1) : raw, start, end: start + raw.length, enc: (v) => (q ? '"' + String(v) + '"' : String(v)) });
  }
  return { hits };
}

function jsonHits(text, key) {
  const hits = [];
  let i = 0;
  const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const expect = (ch) => { ws(); if (text[i] !== ch) throw new Error('bad JSON at ' + i); i++; };
  const str = () => {
    const s = i;
    if (text[i] !== '"') throw new Error('bad JSON at ' + i);
    i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    i++;
    return { v: JSON.parse(text.slice(s, i)), s, e: i };
  };
  const value = (p) => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) { i++; } else {
        for (;;) {
          ws();
          if (c === '{') { const k = str().v; expect(':'); value(p === null ? null : (p ? p + '.' + k : k)); } else value(null);
          ws();
          if (text[i] === ',') { i++; continue; }
          expect(close);
          break;
        }
      }
      if (p === key) hits.push({ type: c === '{' ? 'object' : 'array' });
      return;
    }
    if (c === '"') {
      const t = str();
      if (p === key) hits.push({ value: t.v, type: 'string', start: t.s, end: t.e });
      return;
    }
    const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) throw new Error('bad JSON at ' + i);
    const s = i;
    i += m[0].length;
    const v = JSON.parse(m[0]);
    if (p === key) hits.push({ value: v, type: v === null ? 'null' : typeof v, start: s, end: i });
  };
  value('');
  ws();
  if (i < text.length) throw new Error('bad JSON at ' + i);
  for (const h of hits) h.enc = (v) => JSON.stringify(v);
  return { hits };
}

const xmlUnesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function xmlAttrs(attrText, base) {
  const out = {};
  const re = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(attrText))) {
    const q = m[3] !== undefined ? m[3] : m[4];
    const vs = base + m.index + m[0].length - 1 - q.length;
    out[m[1]] = { value: xmlUnesc(q), start: vs, end: vs + q.length };
  }
  return out;
}

function xmlHits(text, key) {
  const m = /^([\w:.-]+)(?:\[([\w:.-]+)=([^\]]*)\])?(?:@([\w:.-]+))?$/.exec(key);
  if (!m) return { hits: [], error: key + ' is not a valid selector' };
  const [, tagName, fAttr, fVal, attr] = m;
  const re = new RegExp('<' + reEsc(tagName) + '(?=[\\s/>])([^>]*?)(/?)>', 'g');
  const hits = [];
  let t;
  while ((t = re.exec(text))) {
    const attrs = xmlAttrs(t[1], t.index + 1 + tagName.length);
    if (fAttr && (!attrs[fAttr] || attrs[fAttr].value !== fVal)) continue;
    if (attr) {
      if (attrs[attr]) hits.push(Object.assign({ enc: xmlEsc }, attrs[attr]));
      continue;
    }
    if (t[2] === '/') continue;
    const start = t.index + t[0].length;
    const close = text.indexOf('<', start);
    if (close < 0 || text.slice(close, close + tagName.length + 3) !== '</' + tagName + '>') continue;
    hits.push({ value: xmlUnesc(text.slice(start, close)), start, end: close, enc: xmlEsc });
  }
  return { hits };
}

// vdf: "key" "value" pairs (bare tokens too) whose slash path equals key, any case.
function vdfHits(text, key) {
  const want = String(key).split('/').map((x) => x.toLowerCase());
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { toks.push({ t: c }); i++; continue; }
    if (c === '"') {
      const s = i + 1;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      toks.push({ t: 's', v: text.slice(s, i), s, e: i });
      i++;
      continue;
    }
    const s = i;
    while (i < text.length && !/[\s{}"]/.test(text[i])) i++;
    toks.push({ t: 's', v: text.slice(s, i), s, e: i, bare: true });
  }
  const stack = [];
  const hits = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t === '}') { stack.pop(); continue; }
    if (tk.t !== 's') continue;
    const nx = toks[k + 1];
    if (nx && nx.t === '{') { stack.push(tk.v); k++; continue; }
    if (nx && nx.t === 's') {
      const p = stack.concat([tk.v]);
      if (p.length === want.length && p.every((x, j) => x.toLowerCase() === want[j])) {
        const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        hits.push({ value: nx.v.replace(/\\(.)/g, '$1'), start: nx.s, end: nx.e, enc: nx.bare ? (v) => (/[\s{}"]/.test(String(v)) ? '"' + esc(v) + '"' : esc(v)) : esc });
      }
      k++;
    }
  }
  return { hits };
}

const LOCATORS = { json: jsonHits, ini: iniHits, xml: xmlHits, vdf: vdfHits };

// {hits, error?}; a parse failure is an error, never a throw.
function findAll(format, text, key) {
  if (!LOCATORS[format]) return { hits: [], error: 'no parser' };
  try { return LOCATORS[format](String(text), String(key)); } catch (e) { return { hits: [], error: 'the file does not parse as ' + format + ' (' + e.message + ')' }; }
}

// {value, count} or null when the key does not exist (or is not a single value).
function getValue(format, text, key) {
  const { hits } = findAll(format, text, key);
  if (!hits.length || hits[0].type === 'object' || hits[0].type === 'array') return null;
  return { value: hits[0].value, count: hits.length };
}

// Returns the new text, changing only the value bytes; throws when the key is missing,
// ambiguous or not a single value.
function setValue(format, text, key, to) {
  const s = String(text);
  const r = findAll(format, s, key);
  if (r.error && !r.hits.length) throw new Error(r.error);
  if (r.hits.length !== 1) throw new Error((r.hits.length ? 'ambiguous key ' : 'new key ') + key);
  const h = r.hits[0];
  if (h.type === 'object' || h.type === 'array') throw new Error(key + ' is not a single value');
  return s.slice(0, h.start) + h.enc(to) + s.slice(h.end);
}

// ---------------------------------------------------------------- types

function typeOf(v) {
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v !== 'string') return 'other';
  if (/^-?\d+$/.test(v)) return 'int';
  if (/^-?\d*\.\d+$/.test(v)) return 'float';
  if (/^(true|false)$/i.test(v)) return 'bool-text';
  return 'text';
}

function sameType(a, b) {
  return typeof a === typeof b && typeOf(a) === typeOf(b);
}

// L4's coarse type word for readKeys: number | boolean | string (json: its own type).
function classify(raw) {
  const s = String(raw);
  if (/^-?\d+(\.\d+)?$/.test(s)) return 'number';
  if (/^(true|false)$/i.test(s)) return 'boolean';
  return 'string';
}

// ---------------------------------------------------------------- shared helpers

function day(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// <file>.bak-<day>, then -2, -3 ... : an existing backup is never overwritten.
function besideBackup(file, ms) {
  const base = file + '.bak-' + day(ms);
  for (let n = 1; n < 100; n++) {
    const p = n === 1 ? base : base + '-' + n;
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('too many backups today');
}

function label(file, format, key) {
  if (format === 'ini') {
    const [sec, name] = splitKey(key);
    return path.basename(file) + (sec ? ' [' + sec + '] ' : ' ') + name;
  }
  return path.basename(file) + ' ' + key;
}

function atomicWrite(file, data) {
  const tmp = file + '.' + process.pid + '.cc-tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// tasklist names of running processes, through an injected runner when given.
function processChecker(runner) {
  return async (names) => {
    if (!names || !names.length) return [];
    const run = runner || require('./machine-scan').defaultRunner;
    const r = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], {});
    if (!r || r.code !== 0) return names.slice(); // unknown = treat as running (fail safe)
    const live = new Set(String(r.stdout).split(/\r?\n/).map((l) => (/^"([^"]+)"/.exec(l) || [])[1]).filter(Boolean).map((n) => n.toLowerCase()));
    return names.filter((n) => live.has(n.toLowerCase()));
  };
}

// ---------------------------------------------------------------- L9 edit-list API

// Read-only. One row per edit: status change | same | refused (+ reason).
function plan(edits) {
  return (edits || []).map((e) => {
    const file = e && e.target && e.target.file;
    const key = e && e.target && e.target.key;
    const format = formatFor(file || '', e && e.format);
    const row = { id: e && e.id, file, key, format, from: null, to: e ? e.to : null, status: 'refused', reason: null, label: file ? label(file, format, key) : String(e && e.id) };
    if (!file || !key) { row.reason = 'no target'; return row; }
    if (!format) { row.reason = 'no parser for ' + (path.extname(file) || 'this file'); return row; }
    let text;
    try { text = readText(file).text; } catch (err) { row.reason = 'file not found'; return row; }
    const found = findAll(format, text, key);
    if (found.error && !found.hits.length) { row.reason = found.error; return row; }
    if (!found.hits.length) { row.reason = 'new key ' + key + ': app-config edits existing keys only'; return row; }
    const h0 = found.hits[0];
    if (h0.type === 'object' || h0.type === 'array') { row.reason = key + ' is not a single value'; return row; }
    row.from = h0.value;
    if (found.hits.length !== 1) { row.reason = 'ambiguous key ' + key + ' (' + found.hits.length + ' matches)'; return row; }
    if (e.to === null || typeof e.to === 'object') { row.reason = key + ': only a single value can be set'; return row; }
    const to = format === 'json' ? e.to : String(e.to);
    row.to = to;
    if (format !== 'json' && /[\r\n]/.test(to)) { row.reason = key + ': one line only'; return row; }
    if (!sameType(h0.value, to)) { row.reason = 'type change for ' + key + ' (' + typeOf(h0.value) + ' -> ' + typeOf(to) + ')'; return row; }
    row.status = h0.value === to ? 'same' : 'change';
    return row;
  });
}

function preview(rows) {
  return rows.map((r) => {
    if (r.status === 'change') return r.label + ': ' + r.from + ' -> ' + r.to;
    if (r.status === 'same') return r.label + ': already ' + r.to;
    return r.label + ': refused - ' + r.reason;
  }).join('\n');
}

function writeJournal(txDir, j) {
  fs.mkdirSync(txDir, { recursive: true });
  fs.writeFileSync(path.join(txDir, 'journal.json'), JSON.stringify(j, null, 1) + '\n');
}

// opts: {accept: [ids], txDir, isRunning(names) -> running names, now, write(file, buf)}
async function apply(edits, opts) {
  opts = opts || {};
  edits = edits || [];
  const accept = new Set(opts.accept || []);
  const chosen = edits.filter((e) => e && accept.has(e.id));
  if (!chosen.length) return { ok: false, error: 'nothing accepted: every change is opt-in' };
  if (!opts.txDir) return { ok: false, error: 'no transaction folder' };
  const rows = plan(chosen);
  const bad = rows.find((r) => r.status === 'refused');
  if (bad) return { ok: false, error: bad.id + ': ' + bad.reason, rows };
  for (const e of chosen) {
    for (const q of e.requires || []) {
      if (accept.has(q)) continue;
      const dep = edits.find((x) => x && x.id === q);
      const st = dep ? plan([dep])[0].status : 'missing';
      if (st !== 'same') return { ok: false, error: e.id + ' needs ' + q + (dep ? ' (accept it too)' : ' (not offered)'), rows };
    }
  }
  const procs = [...new Set(chosen.flatMap((e) => e.processes || []))];
  const running = await (opts.isRunning || processChecker(opts.runner))(procs);
  if (running && running.length) return { ok: false, error: running[0] + ' is running: close it first (an app config is never edited while its app runs)', rows };
  const todo = chosen.filter((e, i) => rows[i].status === 'change');
  if (!todo.length) return { ok: true, applied: [], txDir: opts.txDir, rows };
  const now = opts.now ? opts.now() : Date.now();
  const write = opts.write || atomicWrite;
  const files = [];
  for (const e of todo) {
    let f = files.find((x) => x.file === e.target.file);
    if (!f) { f = { file: e.target.file, format: formatFor(e.target.file, e.format), edits: [] }; files.push(f); }
    f.edits.push(e);
  }
  const journal = { schema: 1, kind: 'app-config', started: new Date(now).toISOString(), status: 'pending', processes: procs, files: [] };
  fs.mkdirSync(path.join(opts.txDir, 'pre'), { recursive: true });
  files.forEach((f, i) => {
    f.pre = fs.readFileSync(f.file);
    const bak = besideBackup(f.file, now);
    fs.writeFileSync(bak, f.pre, { flag: 'wx' });
    const preRel = path.join('pre', i + '-' + path.basename(f.file));
    fs.writeFileSync(path.join(opts.txDir, preRel), f.pre);
    const d = decode(f.pre);
    let text = d.text;
    for (const e of f.edits) text = setValue(f.format, text, e.target.key, f.format === 'json' ? e.to : String(e.to));
    f.after = encode(text, d.enc);
    journal.files.push({ file: f.file, format: f.format, pre: preRel, backup: bak, sha_before: sha(f.pre), sha_after: sha(f.after), keys: f.edits.map((e) => ({ id: e.id, key: e.target.key, from: rows[chosen.indexOf(e)].from, to: f.format === 'json' ? e.to : String(e.to) })) });
  });
  writeJournal(opts.txDir, journal);
  const done = [];
  const rollback = () => { for (const f of done) fs.writeFileSync(f.file, f.pre); };
  for (const f of files) {
    try { write(f.file, f.after); } catch (err) { done.push(f); rollback(); journal.status = 'rolled-back'; writeJournal(opts.txDir, journal); return { ok: false, error: 'write failed for ' + path.basename(f.file) + ': ' + err.message, rows }; }
    done.push(f);
    const back = readText(f.file).text;
    for (const e of f.edits) {
      const want = f.format === 'json' ? e.to : String(e.to);
      const got = getValue(f.format, back, e.target.key);
      if (!got || got.value !== want) {
        rollback();
        journal.status = 'rolled-back';
        writeJournal(opts.txDir, journal);
        return { ok: false, error: 'read-back mismatch for ' + e.id + ' in ' + path.basename(f.file) + ' (rolled back)', rows };
      }
    }
  }
  journal.status = 'applied';
  writeJournal(opts.txDir, journal);
  return { ok: true, applied: todo.map((e) => e.id), txDir: opts.txDir, rows };
}

// Restore every file of one transaction to its pre-image. opts: {isRunning, force}.
async function revert(txDir, opts) {
  opts = opts || {};
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(txDir, 'journal.json'), 'utf8')); } catch (e) { return { ok: false, error: 'no journal in ' + txDir }; }
  if (j.status !== 'applied') return { ok: false, error: 'transaction is ' + j.status + ', nothing to revert' };
  const running = await (opts.isRunning || processChecker(opts.runner))(j.processes || []);
  if (running && running.length) return { ok: false, error: running[0] + ' is running: close it first' };
  for (const f of j.files) {
    let cur = null;
    try { cur = sha(fs.readFileSync(f.file)); } catch (e) { cur = null; }
    if (cur !== f.sha_after && !opts.force) return { ok: false, error: path.basename(f.file) + ' changed since the change was applied (the app may have rewritten it); revert with force to restore the pre-image anyway' };
  }
  for (const f of j.files) {
    const pre = fs.readFileSync(path.join(txDir, f.pre));
    fs.writeFileSync(f.file, pre);
    if (sha(fs.readFileSync(f.file)) !== f.sha_before) return { ok: false, error: 'read-back of the restored ' + path.basename(f.file) + ' failed' };
  }
  j.status = 'reverted';
  writeJournal(txDir, j);
  return { ok: true, reverted: j.files.map((f) => f.file) };
}

// ---------------------------------------------------------------- L4 adapter surface
// Contract: profile-oscommon.js. A contribution {file, process, set: {key: value}};
// opts.apply !== true = dry run; the journal holds key names and hashes, never values;
// every result asks the user to confirm the effect in the app (the read-back proves the
// file, not the effect: the recorded run had one key the client ignored).

function publicHit(r, key) {
  if (!r.hits.length) return r.error ? { found: false, error: r.error } : { found: false };
  if (r.hits.length > 1) return { found: false, error: key + ' is ambiguous (' + r.hits.length + ' matches)' };
  const h = r.hits[0];
  if (h.type === 'object' || h.type === 'array') return { found: true, value: undefined, type: h.type };
  return { found: true, value: h.value, type: h.type || classify(h.value) };
}

function readKeys(file, keys) {
  const fmt = formatOf(file);
  if (!fmt) throw new Error('unsupported config format: ' + path.extname(file));
  const { text } = readText(file);
  const out = {};
  for (const k of keys) out[k] = publicHit(findAll(fmt, text, k), k);
  return out;
}

function createAppConfigAdapter(opts) {
  opts = opts || {};
  const C = require('./profile-oscommon');
  const platform = opts.platform || process.platform;
  const now = opts.now || (() => Date.now());
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const writeFile = opts.writeFile || C.writeAtomic;
  const runner = opts.runner || C.realRunner;
  const isRunning = opts.isRunning || (async (image) => {
    const r = await runner('C:\\Windows\\System32\\tasklist.exe', ['/FI', 'IMAGENAME eq ' + image, '/FO', 'CSV', '/NH'], { timeoutMs: 15000 });
    return r.code === 0 && String(r.stdout).toLowerCase().includes('"' + image.toLowerCase() + '"');
  });

  async function adapterPlan(c) {
    const off = C.windowsOnly(platform);
    if (off) return Object.assign({ kind: 'app-config', ok: false, errors: [off.reason] }, off);
    const errors = [];
    if (!c || typeof c !== 'object') return { kind: 'app-config', ok: false, status: 'refused', errors: ['contribution required'], changes: [] };
    const fmt = formatOf(c.file);
    if (typeof c.file !== 'string' || !path.isAbsolute(c.file)) errors.push('config file must be an absolute path');
    else if (!fmt) errors.push('unsupported config format (json, ini, xml, vdf)');
    else if (!fs.existsSync(c.file)) errors.push('config file not found');
    if (typeof c.process !== 'string' || !PROC_RE.test(c.process)) errors.push('name the owning app process (image name, e.g. game.exe)');
    if (!c.set || typeof c.set !== 'object' || Array.isArray(c.set) || !Object.keys(c.set).length) errors.push('nothing to set');
    if (errors.length) return { kind: 'app-config', ok: false, status: 'refused', errors, changes: [] };
    if (await isRunning(c.process)) errors.push(c.process + ' is running: close the app first');
    const rows = plan(Object.entries(c.set).map(([key, to]) => ({ id: key, target: { file: c.file, key }, to })));
    const changes = [];
    for (const r of rows) {
      if (r.status === 'refused') {
        errors.push(/^new key/.test(r.reason) ? 'existing keys only: ' + r.key + ' is not in the file' : r.reason);
        continue;
      }
      if (r.status === 'change') changes.push({ key: r.key, from: r.from, to: r.to });
    }
    const ok = !errors.length;
    return { kind: 'app-config', ok, status: !ok ? 'refused' : changes.length ? 'differs' : 'same', errors, changes, file: c.file, format: fmt };
  }

  async function adapterApply(c, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    const p = await adapterPlan(c);
    if (!p.ok) return { status: 'refused', reason: p.errors.join('; '), plan: p };
    if (o.apply !== true) return { status: 'dry-run', plan: p };
    if (p.status === 'same') return { status: 'same', plan: p };
    const before = fs.readFileSync(c.file);
    const { text, enc } = decode(before);
    let next = text;
    for (const ch of p.changes) next = setValue(p.format, next, ch.key, ch.to);
    const after = encode(next, enc);
    const pre = C.preFile(o.txDir, 'appconfig', C.sha256(c.file).slice(0, 8) + '-' + path.basename(c.file));
    fs.writeFileSync(pre.abs, before);
    const beside = besideBackup(c.file, now());
    fs.writeFileSync(beside, before, { flag: 'wx' });
    const entry = C.journalWrite(o, { kind: 'app-config', file: c.file, format: p.format, keys: p.changes.map((x) => x.key), pre: pre.rel, backup: beside, preSha: C.sha256(before), appliedSha: C.sha256(after) });
    let bad = null;
    try {
      writeFile(c.file, after);
      const backText = readText(c.file).text;
      for (const ch of p.changes) {
        const got = getValue(p.format, backText, ch.key);
        if (!got || got.value !== ch.to) { bad = ch.key; break; }
      }
    } catch (e) { bad = 'write (' + e.message + ')'; }
    if (bad) {
      C.writeAtomic(c.file, before);
      const restored = C.sha256(fs.readFileSync(c.file)) === entry.preSha;
      log('app-config ' + path.basename(c.file) + ' failed, restored ' + restored);
      return { status: 'failed', reason: 'read-back of ' + bad + ' did not match; the pre-image was restored', rolledBack: restored, entry };
    }
    log('app-config ' + path.basename(c.file) + ' ' + p.changes.length + ' keys ok');
    return { status: 'applied', entry, backup: beside, changes: p.changes, note: 'Start the app and confirm the change took effect: the read-back proves the file, and an app may still ignore or rewrite a key.' };
  }

  async function adapterRevert(entry, o) {
    o = o || {};
    const off = C.windowsOnly(platform);
    if (off) return off;
    if (!entry || entry.kind !== 'app-config' || !entry.pre || !entry.file) return { status: 'refused', reason: 'not an app-config journal entry' };
    if (o.apply !== true) return { status: 'dry-run', action: 'restore ' + path.basename(entry.file) + ' from its pre-image' };
    const cur = fs.existsSync(entry.file) ? C.sha256(fs.readFileSync(entry.file)) : null;
    if (cur !== entry.appliedSha && o.force !== true) return { status: 'refused', reason: path.basename(entry.file) + ' changed since the apply; revert with force to restore the pre-image anyway' };
    C.writeAtomic(entry.file, fs.readFileSync(path.join(o.txDir, ...entry.pre.split('/'))));
    const ok = C.sha256(fs.readFileSync(entry.file)) === entry.preSha;
    log('app-config revert ' + path.basename(entry.file) + (ok ? ' ok' : ' failed'));
    return ok ? { status: 'reverted', file: entry.file } : { status: 'failed', reason: 'the restored file does not match its pre-image' };
  }

  return { plan: adapterPlan, apply: adapterApply, revert: adapterRevert };
}

// ---------------------------------------------------------------- engine adapter
// INTEGRATE-1: what installer/profile-tx.js and profile-plan.js call (deps.appConfig).
//   plan(c, vars)          sync, read-only: {status new|same|differs|unreadable|skipped,
//                          reason, display, file, key, to, format, processes}
//   apply(m, {preDir, seq})  runs the L9 apply in <preDir>/appconfig-<seq>/ (journal.json
//                          + pre/); returns {token} (null when nothing changed); throws
//                          with one line on a refusal or a rolled-back read-back
//   revert(token, {preDir})  restores that run's pre-images; throws when refused
// A contribution: {kind: 'app-config', target: {file, key}, to, format?, processes?};
// {placeholders} in target.file render from the plan variables.
function createAdapter(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  const isRunning = opts.isRunning || processChecker(opts.runner);

  function edit(c, vars) {
    const t = (c && c.target) || {};
    let file = t.file;
    if (typeof file === 'string' && vars && /\{[a-z_]+\}/.test(file)) {
      const r = require('./profile').renderText(file, vars);
      if (r.missing && r.missing.length) return { error: 'needs a variable: ' + r.missing.join(', ') };
      file = r.text;
    }
    return { id: 'app-config', target: { file, key: t.key }, to: c ? c.to : undefined, format: c && c.format, processes: (c && c.processes) || [] };
  }

  function enginePlan(c, vars) {
    const e = edit(c, vars);
    const display = e.target && e.target.file ? label(e.target.file, formatFor(e.target.file, e.format), e.target.key) : '-';
    const base = { display, file: e.target && e.target.file, key: e.target && e.target.key, to: e.to, format: e.format, processes: e.processes };
    if (platform !== 'win32') return Object.assign(base, { status: 'skipped', reason: 'Windows only' });
    if (e.error) return Object.assign(base, { status: 'unreadable', reason: e.error });
    const r = plan([e])[0];
    const status = r.status === 'change' ? 'differs' : r.status === 'same' ? 'same' : 'unreadable';
    return Object.assign(base, { status, reason: r.reason, format: r.format, to: r.to });
  }

  async function engineApply(m, o) {
    o = o || {};
    if (!m || m.status === 'same' || m.status === 'skipped') return { token: null };
    if (!o.preDir) throw new Error('app-config: no transaction folder');
    const e = { id: 'app-config', target: { file: m.file, key: m.key }, to: m.to, format: m.format, processes: m.processes || [] };
    const dir = 'appconfig-' + (o.seq === undefined ? 0 : o.seq);
    const r = await apply([e], { accept: [e.id], txDir: path.join(o.preDir, dir), isRunning, now: opts.now, write: opts.write });
    if (!r.ok) throw new Error('app-config ' + (m.display || m.key) + ': ' + r.error);
    return { token: r.applied.length ? dir : null };
  }

  async function engineRevert(token, o) {
    o = o || {};
    if (!token) return { ok: true, nothing: true };
    if (!o.preDir || !/^appconfig-\d+$/.test(String(token))) throw new Error('app-config: bad revert token');
    const r = await revert(path.join(o.preDir, String(token)), { isRunning, force: o.force === true });
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  return { plan: enginePlan, apply: engineApply, revert: engineRevert };
}

module.exports = {
  formatFor, getValue, setValue, typeOf, sameType, plan, preview, apply, revert, processChecker, day,
  createAppConfigAdapter, readKeys, formatOf, classify, decode, encode, createAdapter,
};
