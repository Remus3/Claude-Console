/* Claude Console UI. Plain browser JS, no build step. */

// ---------- claude CLI bottom chrome (pure; also loaded by tests/chrome.test.js) ----------
// The claude TUI ends every frame with its own input box: a rule line (often labelled
// with the tree name), the "> " prompt row(s), a closing rule, then status / permission
// / background-agent rows. Composer-only panes hide that block: findChrome() locates it
// in the visible rows, summarize() keeps what matters for the pane header, planCrop()
// says how many bottom pty rows to push out of view.
(function (root) {
  'use strict';
  const RULE = '\u2500';
  function isRule(line) {
    const s = String(line || '').trim();
    if (s.length < 8) return false;
    if (/^[\u256d\u2570]\u2500{3,}/.test(s)) return true; // boxed input (older CLI)
    if (s[0] !== RULE) return false;
    let n = 0;
    for (const ch of s) if (ch === RULE) n++;
    return n >= Math.min(20, Math.ceil(s.length * 0.5));
  }
  function isPrompt(line) {
    const s = String(line || '').replace(/^\s*\u2502?\s*/, '');
    return /^[>\u276f](\s|$)/.test(s) && !/^[>\u276f]\s*\d+[.)]\s/.test(s);
  }
  // lines: the visible terminal rows, top to bottom. Returns null when there is no
  // input box (permission dialogs, menus, plain shells): nothing is hidden then.
  function findChrome(lines, maxScan) {
    let end = lines.length - 1;
    while (end >= 0 && !String(lines[end] || '').trim()) end--;
    if (end < 2) return null;
    const lo = Math.max(0, end - (maxScan || 80));
    for (let y = end - 1; y >= lo; y--) {
      if (!isRule(lines[y]) || !isPrompt(lines[y + 1])) continue;
      let close = -1;
      for (let k = y + 2; k <= Math.min(end, y + 40); k++) {
        if (isRule(lines[k])) { close = k; break; }
      }
      if (close < 0) continue;
      const status = lines.slice(close + 1, end + 1).map((l) => String(l || '').replace(/\s+$/, '')).filter((l) => l.trim());
      return { start: y, close, end, rows: lines.length, status };
    }
    return null;
  }
  // The text in claude's input box (rows between the upper rule and the closing rule),
  // prompt glyph and box borders stripped, rows joined by a space. '' = empty box.
  function inputText(lines, ch) {
    if (!ch) return null;
    const out = [];
    for (let y = ch.start + 1; y < ch.close; y++) {
      const s = String(lines[y] || '').replace(/^\s*\u2502?\s*/, '').replace(/\s*\u2502?\s*$/, '');
      const t = (y === ch.start + 1 ? s.replace(/^[>\u276f]\s?/, '') : s).trim();
      if (t) out.push(t);
    }
    return out.join(' ');
  }
  function summarize(status) {
    const lines = status || [];
    const mainAt = lines.findIndex((l) => /^\s*\S?\s*main\s*$/.test(l));
    const head = (mainAt >= 0 ? lines.slice(0, mainAt) : lines).join('\n');
    const num = (re) => { const m = re.exec(head); return m ? parseInt(m[1], 10) : 0; };
    let agents = num(/(\d+)\s+(?:background\s+)?agents?\b/i);
    if (mainAt >= 0) agents = Math.max(agents, lines.length - mainAt - 1);
    const ctx = /\bctx\s+(\d+)\s*%/i.exec(head);
    let mode = null;
    if (/bypass permissions on/i.test(head)) mode = 'bypass';
    else if (/accept edits on/i.test(head)) mode = 'accept edits';
    else if (/plan mode on/i.test(head)) mode = 'plan';
    return { agents, shells: num(/(\d+)\s+(?:background\s+)?shells?\b/i), monitors: num(/(\d+)\s+monitors?\b/i), ctx: ctx ? parseInt(ctx[1], 10) : null, mode };
  }
  function label(sum) {
    if (!sum) return '';
    const parts = [];
    const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    if (sum.agents) parts.push(plural(sum.agents, 'agent'));
    if (sum.shells) parts.push(plural(sum.shells, 'shell'));
    if (sum.monitors) parts.push(plural(sum.monitors, 'monitor'));
    if (sum.ctx !== null && sum.ctx !== undefined) parts.push('ctx ' + sum.ctx + '%');
    return parts.join(' \u00b7 ');
  }
  // How many bottom pty rows to hide. ch: findChrome() over all pty rows (visible rows +
  // the current crop). The block sits at the bottom once the transcript fills the
  // screen; until then (fresh session, after /clear) it floats under the text and the
  // crop is left alone (a mask covers the block instead).
  function planCrop(ch, cur, maxCrop) {
    if (!ch) return 0;
    if (ch.rows - 1 - ch.end > 1) return cur;
    return Math.max(0, Math.min(ch.rows - ch.start, maxCrop === undefined ? 40 : maxCrop));
  }
  // R6 line classes: one claude transcript line -> 'tool' | 'agent' | 'error' | null.
  // Leans on claude TUI glyphs (U+23FA / U+25CF call bullet, U+23BF result), so it
  // fails open: anything unrecognised stays unmarked (assistant text, plain results).
  const CALL_RE = /^\s*[\u23fa\u25cf]\s*((?:mcp__)?[A-Za-z][\w.-]*)\(/;
  function classifyLine(text) {
    const t = String(text || '');
    const m = CALL_RE.exec(t);
    if (m) return /^(Agent|Task)$/.test(m[1]) ? 'agent' : 'tool';
    if (/^\s*\u23bf/.test(t) && /\b(Error|failed|exit code [1-9])/i.test(t)) return 'error';
    return null;
  }
  // R5: tool name as the header shows it (MCP tools by their last segment).
  function toolLabel(name) {
    const s = String(name || '');
    const parts = s.startsWith('mcp__') ? s.split('__').filter(Boolean) : [s];
    return parts[parts.length - 1].slice(0, 16);
  }
  // Minutes-only age (P3: no per-second ticker): '' under a minute, '2m', '3h'.
  function age(ms) {
    if (!(ms > 0)) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return '';
    return m < 120 ? m + 'm' : Math.floor(m / 60) + 'h';
  }
  // Header state word: running claude panes say which tool runs or 'thinking', plus
  // the stretch age; every other state is its vocabulary word.
  function paneWord(vs, word, p, now) {
    if (vs !== 'running' || !p) return word;
    if (p.tool) return (toolLabel(p.tool) + ' ' + age(now - (p.toolSince || now))).trim();
    const base = p.kind === 'claude' ? 'thinking' : 'running';
    return (base + ' ' + age(now - (p.busySince || now))).trim();
  }
  const api = { isRule, isPrompt, findChrome, inputText, summarize, label, planCrop, classifyLine, toolLabel, age, paneWord };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CCChrome = api;
})(this);

// ---------- workflow rows (pure; also loaded by tests/flow.test.js) ----------
// UI/UX standard section 4 / console-audit 7.2: one fixed row per task, updated in
// place. Rows come from the item-12 progress files; a checklist holds REMAINING tasks
// only, so every id seen is remembered and an id that leaves the list turns done in
// place (failed if the file failed). Rows never reorder and never vanish; the strip
// height only grows (max seen, cap 6) and the window slides to keep the running row.
// CON-UX-PANEROWS: opts { cap, show } from Settings - the row count (0 hides the strip)
// and the states shown. A hidden state leaves the VIEW only (flow.rows keeps every row
// in order); no opts = cap 6, every state shown.
(function (root) {
  'use strict';
  const CAP = 6;
  const GLYPH = { pending: '[ ]', running: '[>]', done: '[+]', failed: '[x]', stale: '[!]', idle: '[-]' };
  const STATES = ['running', 'stale', 'failed', 'pending', 'idle', 'done'];
  const DEFAULT_OPTS = { cap: CAP, show: { running: true, stale: true, failed: true, pending: true, idle: true, done: false } };
  const ALL = { cap: CAP, show: { running: true, stale: true, failed: true, pending: true, idle: true, done: true } };
  // settings { flowRows, flowStates } -> opts (same rules as server/uiprefs.js)
  function normalizeOpts(s) {
    const n = s && typeof s.flowRows === 'number' && Number.isFinite(s.flowRows) ? Math.round(s.flowRows) : CAP;
    const fs = s && s.flowStates && typeof s.flowStates === 'object' ? s.flowStates : {};
    const show = {};
    for (const k of STATES) show[k] = typeof fs[k] === 'boolean' ? fs[k] : DEFAULT_OPTS.show[k];
    return { cap: Math.max(0, Math.min(12, n)), show };
  }
  function visible(flow, opts) {
    const o = opts || ALL;
    return flow.rows.filter((r) => o.show[r.state] !== false);
  }
  // o.strict (CON-UX-CLEAR, a strip restarted by /clear): a file joins only when it was
  // written after `since`; without it a live running file joins whatever its age.
  function create(since, o) {
    return { since: since || 0, strict: !!(o && o.strict), rows: [], byKey: new Map(), files: new Map(), height: 0 };
  }
  function fileState(it) {
    if (it.stale) return 'stale';
    if (it.status === 'running') return 'running';
    if (it.status === 'done') return 'done';
    if (it.status === 'failed' || it.status === 'unreadable') return 'failed';
    return 'pending';
  }
  function put(flow, key, file, fields) {
    let r = flow.byKey.get(key);
    if (!r) {
      r = { key, file, label: '', state: 'pending', pct: null, eta_s: null, step: '' };
      flow.byKey.set(key, r);
      flow.rows.push(r);
    }
    Object.assign(r, fields);
    return r;
  }
  // items: the project's normalized progress items (server/status.js readProgress).
  function update(flow, items, opts) {
    for (const it of items || []) {
      const fkey = it.dir ? it.dir + '/' + it.file : it.file;
      const known = flow.files.has(fkey);
      // A file joins the strip when it runs, or when it moved after the strip began.
      if (!known && !((!flow.strict && it.status === 'running' && !it.stale) || (it.updated || 0) >= flow.since)) continue;
      const fs = fileState(it);
      const list = (it.checklist || []).filter((c) => c && (c.id || c.task));
      const rec = flow.files.get(fkey) || { keys: new Set(), listed: false };
      flow.files.set(fkey, rec);
      if (!list.length && !rec.listed) {
        const k = fkey;
        rec.keys.add(k);
        put(flow, k, fkey, { label: it.task, state: fs, pct: it.pct, eta_s: fs === 'running' ? it.eta_s : null, step: it.step || '', started: fs === 'running' ? it.started || null : null, updated: it.updated || null });
        continue;
      }
      rec.listed = rec.listed || list.length > 0;
      const now = new Set();
      for (const c of list) {
        const k = fkey + '#' + (c.id || c.task);
        now.add(k);
        rec.keys.add(k);
        const runs = /running/i.test(c.state || '');
        let st = fs === 'done' ? 'done' : runs ? (fs === 'stale' ? 'stale' : fs === 'failed' ? 'failed' : 'running') : 'pending';
        const own = (v, d) => (v !== null && v !== undefined ? v : d);
        put(flow, k, fkey, { label: (c.id ? c.id + ' ' : '') + (c.task || ''), state: st, pct: runs ? own(c.pct, it.pct) : null, eta_s: runs ? c.eta_s : null, step: runs ? it.step || '' : '', started: runs ? own(c.started, it.started) || null : null, updated: it.updated || null });
      }
      for (const k of rec.keys) {
        if (now.has(k) || k === fkey) continue;
        const r = flow.byKey.get(k);
        if (r && r.state !== 'done' && r.state !== 'failed') Object.assign(r, { state: fs === 'failed' ? 'failed' : 'done', pct: null, eta_s: null, step: '' });
      }
    }
    // grows to min(cap, visible rows), never shrinks mid-task; a lower cap shrinks it
    const cap = (opts || ALL).cap;
    flow.height = Math.min(cap, Math.max(flow.height, visible(flow, opts).length));
    return flow;
  }
  // The rows to draw: the shown ones up to cap, else cap rows sliding to keep the first
  // unfinished row in view (the running one when there is one).
  function view(flow, opts) {
    const rows = visible(flow, opts);
    const cap = (opts || ALL).cap;
    if (rows.length <= cap) return rows.slice();
    if (cap <= 0) return [];
    let i = rows.findIndex((r) => r.state === 'running' || r.state === 'stale');
    if (i < 0) i = rows.findIndex((r) => r.state === 'pending');
    if (i < 0) i = rows.length - 1;
    const start = Math.max(0, Math.min(rows.length - cap, i - 1));
    return rows.slice(start, start + cap);
  }
  function fmtEta(s) {
    if (s === null || s === undefined) return '';
    if (s < 120) return '~' + Math.round(s) + 's';
    if (s < 7200) return '~' + Math.round(s / 60) + 'm';
    return '~' + Math.round(s / 3600) + 'h';
  }
  // CONETA (kit v20 CHECKLIST-ETA-CLOCK): `<pct>% ~<rem>m of <total>m [h:mmAM/PM]` for a
  // running item whose progress carries "started". Mirrors fleet_checklist.eta_clock /
  // fleet_statusline.js etaClock: rem and total round UP to 0.5 min, total = elapsed / pct
  // (eta_s while pct is 0), the bracket is the local finish time fixed at the last update.
  function fmtHalfMin(sec) {
    const n = Math.max(0, Math.ceil((Math.max(0, Number(sec) || 0) - 0.5) / 30));
    return (n % 2 ? Math.floor(n / 2) + '.5' : String(n / 2)) + 'm';
  }
  function fmtClock(ms) {
    const t = new Date(Math.ceil(ms / 1000 - 1e-6) * 1000);
    if (t.getSeconds()) t.setSeconds(60, 0);
    const h = t.getHours();
    return (h % 12 || 12) + ':' + String(t.getMinutes()).padStart(2, '0') + (h < 12 ? 'AM' : 'PM');
  }
  function etaClock(pct, etaS, startedMs, nowMs, updatedMs) {
    pct = typeof pct === 'number' && isFinite(pct) ? Math.max(0, Math.min(100, Math.trunc(pct))) : 0;
    const start = typeof startedMs === 'number' && startedMs > 0 ? startedMs : null;
    const ref = typeof updatedMs === 'number' && updatedMs > 0 ? updatedMs : nowMs;
    let total;
    let finish;
    if (pct > 0 && start !== null && ref > start) {
      total = (ref - start) * 100 / pct;
      finish = start + total;
    } else if (typeof etaS === 'number' && isFinite(etaS)) {
      finish = ref + Math.max(0, Math.trunc(etaS)) * 1000;
      if (start !== null && start <= ref) total = finish - start;
      else total = pct < 100 ? (finish - ref) * 100 / (100 - pct) : finish - ref;
    } else {
      return '';
    }
    const rem = Math.max(0, finish - nowMs);
    return pct + '% ~' + fmtHalfMin(rem / 1000) + ' of ' + fmtHalfMin(total / 1000) + ' [' + fmtClock(finish) + ']';
  }
  // The clock text of a running row with "started", else ''.
  function clockOf(r, now) {
    if (!r || r.state !== 'running' || !r.started) return '';
    return etaClock(r.pct === null || r.pct === undefined ? 0 : r.pct, r.eta_s, r.started, now || Date.now(), r.updated);
  }
  // Fixed columns: glyph, label, pct, eta, step. A clock row puts the whole clock text
  // in the pct slot and leaves the eta slot empty (drawn as one wider cell, .frow.clk).
  function cells(r, now) {
    const clk = clockOf(r, now);
    if (clk) return [GLYPH[r.state] || '[ ]', r.label, clk, '', r.step];
    return [GLYPH[r.state] || '[ ]', r.label, r.pct !== null && r.pct !== undefined && r.state === 'running' ? Math.round(r.pct) + '%' : '', r.state === 'running' ? fmtEta(r.eta_s) : r.state === 'stale' ? 'STALE' : '', r.step];
  }
  // R8: the project's top running item for the pane header: '<id> 45% ~5m' (fixed slot);
  // the clock form rides in the tooltip.
  function top(items, now) {
    const list = items || [];
    const it = list.find((x) => x.status === 'running' && !x.stale) || list.find((x) => x.stale);
    if (!it) return null;
    if (it.stale) return { text: 'STALE', cls: 'stale', title: (it.task || it.file || 'progress') + ': progress file stale' };
    const run = (it.checklist || []).find((c) => c && /running/i.test(c.state || ''));
    const id = run && run.id ? String(run.id).slice(0, 6) + ' ' : '';
    const pct = it.pct !== null && it.pct !== undefined ? Math.round(it.pct) + '%' : '';
    const eta = fmtEta(run && run.eta_s !== undefined && run.eta_s !== null ? run.eta_s : it.eta_s);
    const text = (id + pct + ' ' + eta).replace(/\s+/g, ' ').trim() || 'running';
    const own = (v, d) => (v !== null && v !== undefined ? v : d);
    const clk = clockOf({ state: 'running', pct: own(run && run.pct, it.pct), eta_s: own(run && run.eta_s, it.eta_s), started: own(run && run.started, it.started), updated: it.updated }, now);
    return { text, cls: 'on', title: (it.task || it.file || 'progress') + (it.step ? ': ' + it.step : '') + (run && run.task ? '\n' + (run.id ? run.id + ' ' : '') + run.task : '') + (clk ? '\n' + clk : '') };
  }
  const api = { CAP, GLYPH, STATES, DEFAULT_OPTS, normalizeOpts, create, update, view, cells, clockOf, etaClock, fmtHalfMin, fmtClock, fileState, top };
  if (typeof module === 'object' && module.exports) module.exports.Flow = api;
  else root.CCFlow = api;
})(this);

// ---------- type scale (CON-UX-TYPESCALE; pure, also loaded by tests/typescale.test.js) ----------
// One base size plus a per-level offset (px, half-pixel steps) -> six CSS custom
// properties that app.css reads for every UI font size. Defaults equal server/uiprefs.js.
(function (root) {
  'use strict';
  const LEVELS = ['header', 'sub', 'body', 'secondary', 'mono', 'badge'];
  const LABELS = { header: 'Header (top bar)', sub: 'Subheader (titles)', body: 'Body', secondary: 'Nested / secondary', mono: 'Mono (rows, paths)', badge: 'Badges / meters' };
  const DEFAULTS = { base: 15, header: 1, sub: 0, body: 0, secondary: -2, mono: -3, badge: -3.5 };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const half = (v) => Math.round(v * 2) / 2;
  function normalize(v) {
    const s = v && typeof v === 'object' ? v : {};
    const b = num(s.base);
    const out = { base: b === null ? DEFAULTS.base : Math.max(10, Math.min(24, half(b))) };
    for (const lv of LEVELS) {
      const o = num(s[lv]);
      out[lv] = o === null ? DEFAULTS[lv] : Math.max(-8, Math.min(8, half(o)));
    }
    return out;
  }
  function vars(scale) {
    const s = normalize(scale);
    const out = {};
    for (const lv of LEVELS) out['--fs-' + lv] = Math.max(8, s.base + s[lv]) + 'px';
    return out;
  }
  const api = { LEVELS, LABELS, DEFAULTS, normalize, vars };
  if (typeof module === 'object' && module.exports) module.exports.Type = api;
  else root.CCType = api;
})(this);

// ---------- sidebar sub-categories (CON-UX-SUBCAT; pure, also loaded by tests/subcat.test.js) ----------
// A project's child rows come in kinds: pins (local model + chat), stack (service
// rows), tools (status board link + tools). Nothing shows while the project is
// collapsed; with one kind the rows are a flat list; with several each kind gets a
// header row and its items show only while that header is open.
(function (root) {
  'use strict';
  const ORDER = ['pins', 'stack', 'tools'];
  const LABEL = { pins: 'Local model + chat', stack: 'Stack', tools: 'Tools' };
  function cats(has) {
    return ORDER.filter((c) => has && has[c]);
  }
  function plan(list, projOpen, subOpen) {
    if (!projOpen || !list.length) return [];
    if (list.length === 1) return [{ kind: 'items', cat: list[0] }];
    const out = [];
    for (const c of list) {
      const open = subOpen.has(c);
      out.push({ kind: 'head', cat: c, open });
      if (open) out.push({ kind: 'items', cat: c });
    }
    return out;
  }
  const api = { ORDER, LABEL, cats, plan };
  if (typeof module === 'object' && module.exports) module.exports.Side = api;
  else root.CCSide = api;
})(this);

// ---------- pane key strip + quick chips (CON-UX-KEYS; pure, also loaded by tests/keys.test.js) ----------
// seq: the key events a button sends, one pty write each (a chord needs two events).
// Ctrl-X: the installed claude.exe keymap has no bare Ctrl-X action; Ctrl-X starts a
// chord and "ctrl+x ctrl+s" is chat:sendNow, so the button sends that chord.
(function (root) {
  'use strict';
  const KEYS = [
    { id: 'esc', label: 'Esc', seq: ['\x1b'], title: 'Send Escape (interrupt claude)' },
    { id: 'ctrlc', label: '^C', seq: ['\x03'], title: 'Send Ctrl+C' },
    { id: 'enter', label: 'Enter', seq: ['\r'], title: 'Send Enter' },
    { id: 'ctrlx', label: '^X^S', seq: ['\x18', '\x13'], title: 'Send Ctrl+X Ctrl+S (claude: send the typed or queued message now)' },
    { id: 'stab', label: 'S-Tab', seq: ['\x1b[Z'], title: 'Send Shift+Tab (cycle claude permission mode)' },
    { id: 'up', label: '\u2191', seq: ['\x1b[A'], title: 'Send arrow Up' },
    { id: 'down', label: '\u2193', seq: ['\x1b[B'], title: 'Send arrow Down' },
    { id: 'left', label: '\u2190', seq: ['\x1b[D'], title: 'Send arrow Left' },
    { id: 'right', label: '\u2192', seq: ['\x1b[C'], title: 'Send arrow Right' },
  ];
  const DEFAULT_CHIPS = [{ text: 'continue', on: true }, { text: '/done', on: true }, { text: '/clear', on: true }];
  function normalizeStrip(v) {
    const s = v && typeof v === 'object' ? v : {};
    const out = {};
    for (const k of KEYS) out[k.id] = typeof s[k.id] === 'boolean' ? s[k.id] : true;
    return out;
  }
  // Same rules as server/uiprefs.js sanitizeChips; strings (the old format) migrate.
  function normalizeChips(v) {
    if (v === undefined) return DEFAULT_CHIPS.map((c) => Object.assign({}, c));
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const c of v) {
      const raw = typeof c === 'string' ? c : c && typeof c === 'object' && typeof c.text === 'string' ? c.text : null;
      if (raw === null) continue;
      const text = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200);
      if (!text) continue;
      out.push({ text, on: typeof c === 'object' ? c.on !== false : true });
      if (out.length >= 12) break;
    }
    return out;
  }
  const api = { KEYS, normalizeStrip, normalizeChips };
  if (typeof module === 'object' && module.exports) module.exports.Keys = api;
  else root.CCKeys = api;
})(this);

// ---------- status card text (CON-UX-STATUSPANEL; pure, also loaded by tests/statuspanel.test.js) ----------
(function (root) {
  'use strict';
  const HEAD_RE = /^\s*(THE\s+SINGLE\s+)?NEXT\s+ACTION\s*:?\s*$/i;
  const RULE_RE = /^[=\-*#_~+]{3,}$/;
  // The hand-off's next-action block -> its first sentence on one line ('' = none).
  // A sentence ends at . ! or ? followed by an upper-case start or the end, so
  // "e.g. the" and "v1.2" do not cut it.
  function nextLine(block) {
    const lines = nextBlock(block);
    if (!lines.length) return '';
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    const m = /^(.*?[.!?])(?=\s+[A-Z0-9"'(\[]|$)/.exec(text);
    return m ? m[1] : text;
  }
  // The block without its heading line and rule lines ('====='), each line trimmed
  // (the open Next line + hover).
  function nextBlock(block) {
    if (!Array.isArray(block)) return [];
    const lines = block.map((l) => String(l || '').trim()).filter((l) => l && !RULE_RE.test(l));
    if (lines.length && HEAD_RE.test(lines[0])) lines.shift();
    else if (lines.length) lines[0] = lines[0].replace(/^next\s+action\s*:\s*/i, '');
    return lines.filter(Boolean);
  }
  // kv inbox part: 'inbox M new' (since the last /done, else 24 h), newest note's kind +
  // subject on hover; null when nothing is new.
  function inboxLine(inbox) {
    if (!inbox || !(inbox.fresh > 0)) return null;
    const n = inbox.newestNote;
    const lines = [inbox.fresh + ' new ' + (inbox.freshBasis === 'done' ? 'since the last /done' : 'in the last 24 h')];
    if (n) lines.push('newest: ' + ((n.kind ? n.kind + ' ' : '') + (n.subject || '')).trim());
    lines.push(inbox.total + ' notes in the inbox');
    return { text: 'inbox ' + inbox.fresh + ' new', title: lines.join('\n') };
  }
  const api = { nextLine, nextBlock, inboxLine };
  if (typeof module === 'object' && module.exports) module.exports.Card = api;
  else root.CCCard = api;
})(this);

// ---------- usage strip model (CON-USAGE; pure, testable under node) ----------
// Turns the status snapshot's quota numbers into fixed slots: Acc 1..3 x (7d, 5h,
// Fable) as "used% : time to reset", then API credits and Extra Usage in $. A value
// with no source is '--'; widths come from CSS, so text never moves the layout.
(function (root) {
  'use strict';
  const ACCS = ['acc1', 'acc2', 'acc3'];
  const WINS = [
    { key: 'w7d', label: '7d', frac: 'unified7d', reset: 'unified7dReset' },
    { key: 'w5h', label: '5h', frac: 'unified5h', reset: 'unified5hReset' },
    { key: 'fable', label: 'Fable', frac: 'unified7dFable', reset: 'unified7dFableReset' },
  ];
  const TOGGLES = [['w7d', '7d'], ['w5h', '5h'], ['fable', 'Fable'], ['acc1', 'Acc 1'], ['acc2', 'Acc 2'], ['acc3', 'Acc 3'], ['api', 'API'], ['extra', 'Extra Usage']];
  const NA = '--';
  const num = (v) => typeof v === 'number' && isFinite(v);
  function pct(frac) { return num(frac) ? Math.round(Math.max(0, frac) * 100) + '%' : NA; }
  function left(resetMs, now) {
    if (!num(resetMs) || resetMs <= 0) return NA;
    const d = Math.max(0, resetMs - now);
    const mins = Math.floor(d / 60000);
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    if (h < 24) return h + 'h' + String(mins % 60).padStart(2, '0') + 'm';
    return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
  }
  function usd(v) { return num(v) ? '$' + v.toFixed(2) : NA; }
  function band(frac) { return !num(frac) ? '' : frac >= 0.9 ? 'bad' : frac >= 0.7 ? 'warn' : ''; }
  // accounts: the configured accounts in order ({id}); slot n = the nth one.
  function model(quota, accounts, now, extras) {
    const qa = (quota && Array.isArray(quota.accounts)) ? quota.accounts : [];
    const cfg = Array.isArray(accounts) ? accounts : [];
    const accs = ACCS.map((slot, i) => {
      const a = cfg[i];
      const q = a ? qa.find((x) => x && x.id === a.id) : null;
      const src = (q && q.quota) || {};
      const st = typeof src.unifiedStatus === 'string' ? src.unifiedStatus : null;
      return {
        slot, label: 'Acc ' + (i + 1), present: !!q, status: st && st !== 'allowed' ? st : null,
        wins: WINS.map((w) => ({ key: w.key, label: w.label, frac: num(src[w.frac]) ? src[w.frac] : null, pct: pct(src[w.frac]), left: left(src[w.reset], now), band: band(src[w.frac]) })),
      };
    });
    const ex = extras || {};
    const extra = num(ex.extraSpent) && num(ex.extraLimit) ? usd(ex.extraSpent) + '/' + usd(ex.extraLimit) : NA;
    return { accs, api: usd(ex.apiCredits), extra };
  }
  // Compact (phone) summary: the highest used % among the visible windows.
  // Slot toggles: on unless switched off; Acc 3 (no third account yet) off unless switched on.
  function isOn(prefs, k) { const v = (prefs || {})[k]; return k === 'acc3' ? v === true : v !== false; }
  function summary(m, prefs) {
    let best = null;
    for (const a of m.accs) {
      if (!isOn(prefs, a.slot)) continue;
      for (const w of a.wins) if (isOn(prefs, w.key) && w.frac !== null && (best === null || w.frac > best)) best = w.frac;
    }
    return best === null ? NA : pct(best);
  }
  const api = { ACCS, WINS, TOGGLES, NA, pct, left, usd, band, model, summary, isOn };
  if (typeof module === 'object' && module.exports) module.exports.Usage = api;
  else root.CCUsage = api;
})(this);


// ---------- resource readout model (CON-RES; pure, tests/resources.test.js) ----------
// Turns the server's {t: 'res'} snapshot into fixed top-bar items, Task Manager
// semantics: CPU RAM GPU, one item per existing drive C..F (active time; capacity
// used in the tooltip), NET (percent of link speed). A missing metric is '--'.
// Bands colour the number: low (calm teal), ok (green), mid (amber), high (red).
(function (root) {
  'use strict';
  const NA = '--';
  // fewest-first drop order when the top bar is too narrow (CPU stays longest)
  const DROP = ['F', 'E', 'D', 'net', 'C', 'gpu', 'ram', 'cpu'];
  // reserved before the usage strip decides on its compact summary (CON-RES ruling C)
  const CORE = ['cpu', 'ram', 'gpu'];
  function band(p) {
    if (typeof p !== 'number' || !isFinite(p)) return 'na';
    if (p >= 85) return 'high';
    if (p >= 60) return 'mid';
    if (p >= 25) return 'ok';
    return 'low';
  }
  function txt(p) { return typeof p === 'number' && isFinite(p) ? Math.round(p) + '%' : NA; }
  function bytes(n) {
    if (typeof n !== 'number' || !isFinite(n) || n < 0) return NA;
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n >= 100 ? 0 : 1) : String(Math.round(n))) + ' ' + u[i];
  }
  function bits(bps) {
    if (typeof bps !== 'number' || !isFinite(bps) || bps < 0) return NA;
    const u = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    let i = 0;
    while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++; }
    return (i ? bps.toFixed(bps >= 100 ? 0 : 1) : String(Math.round(bps))) + ' ' + u[i];
  }
  function item(key, label, p, title) { return { key, label, pct: typeof p === 'number' && isFinite(p) ? p : null, text: txt(p), band: band(p), title }; }
  function items(s) {
    s = s && typeof s === 'object' ? s : {};
    const out = [];
    out.push(item('cpu', 'CPU', s.cpu, 'CPU: total processor utility (as Task Manager)' + (s.cpu === null || s.cpu === undefined ? ', not available' : '')));
    const ramTitle = typeof s.ram === 'number' && typeof s.ramTotalBytes === 'number'
      ? 'RAM: ' + bytes(s.ramTotalBytes * s.ram / 100) + ' of ' + bytes(s.ramTotalBytes) + ' in use'
      : 'RAM: physical memory in use, not available';
    out.push(item('ram', 'RAM', s.ram, ramTitle));
    out.push(item('gpu', 'GPU', s.gpu, 'GPU: busiest engine (as Task Manager)' + (s.gpu === null || s.gpu === undefined ? ', not available' : '')));
    for (const d of Array.isArray(s.drives) ? s.drives : []) {
      if (!d || !/^[C-F]$/.test(String(d.letter))) continue;
      const cap = typeof d.used === 'number' ? 'capacity ' + d.used + '% used' + (typeof d.totalBytes === 'number' && typeof d.freeBytes === 'number' ? ' (' + bytes(d.totalBytes - d.freeBytes) + ' of ' + bytes(d.totalBytes) + ')' : '') : 'capacity not available';
      out.push(item(d.letter, d.letter + ':', d.active, d.letter + ': disk active time ' + txt(d.active) + ', ' + cap));
    }
    const n = s.net && typeof s.net === 'object' ? s.net : null;
    const netTitle = n
      ? 'NET: busiest adapter, ' + txt(n.pct) + ' of link ' + bits(n.bw) + '; send ' + bits(typeof n.tx === 'number' ? n.tx * 8 : null) + ', receive ' + bits(typeof n.rx === 'number' ? n.rx * 8 : null)
      : 'NET: throughput as percent of link speed, not available';
    out.push(item('net', 'NET', n ? n.pct : null, netTitle));
    return out;
  }
  const api = { NA, DROP, CORE, band, txt, bytes, bits, items };
  if (typeof module === 'object' && module.exports) module.exports.Res = api;
  else root.CCRes = api;
})(this);


// ---------- where a new pane goes (CON-PANE-VANISH; pure, tests/panevanish.test.js) ----------
// A pane another client opened (an agent's API call, another console page) used to be
// tiled straight into this page's grid: every such open re-tiled the grid (1 -> 2
// columns), moving pane headers and their X buttons under the operator's pointer, and
// the close dialog focuses its danger button, so a click plus Enter meant to reach the
// operator's own pane closed the new one. S30: three agent-opened claude panes got a
// DELETE within 5 s of opening, and nothing but a page's close sends one. Only panes
// this page asked for are tiled; any other new pane arrives as a minimized chip.
(function (root) {
  'use strict';
  function newClientId(rand) {
    const r = typeof rand === 'function' ? rand : Math.random;
    let s = 'c';
    while (s.length < 13) s += Math.floor(r() * 36).toString(36);
    return s;
  }
  function placement(info, clientId) {
    return info && clientId && info.openedBy === clientId ? 'tile' : 'minimized';
  }
  const api = { newClientId, placement };
  if (typeof module === 'object' && module.exports) module.exports.Place = api;
  else root.CCPlace = api;
})(this);

// ---------- HEALTH (order 2026-10-18 "v19.1" A; pure, also loaded by tests/health.test.js) ----------
// Text for the Health & cleanup confirmation dialog and its live progress: step cost
// ($0 / 0 tokens for deterministic steps, a range from past runs for the LLM step),
// totals of the ticked steps, per-step progress percent, report lines. Also the
// headless-route line under the two account dropdowns (v19.1 B).
(function (root) {
  'use strict';
  const usd = (v) => '$' + (Math.round(v * 100) / 100).toFixed(2);
  const tok = (v) => (v >= 1e6 ? (Math.round(v / 1e5) / 10) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v)));
  function isLlm(step) { return !!(step && (step.llm || (step.cost && step.cost.usd && typeof step.cost.usd === 'object') || (step.cost && step.cost.basis))); }
  function costText(step) {
    const c = step && step.cost;
    if (!isLlm(step)) return '$0 / 0 tokens';
    if (!c || !c.usd || typeof c.usd !== 'object') return 'cost unknown (no past runs)';
    const range = c.usd.lo === c.usd.hi ? usd(c.usd.median) : usd(c.usd.lo) + '-' + usd(c.usd.hi);
    const tr = c.tokens ? (c.tokens.lo === c.tokens.hi ? tok(c.tokens.median) : tok(c.tokens.lo) + '-' + tok(c.tokens.hi)) + ' tokens' : '? tokens';
    return range + ' / ' + tr + ' (median ' + usd(c.usd.median) + ' of ' + c.n + ' past ' + (c.basis || 'runs') + ')';
  }
  function totals(steps, ticked) {
    const sel = (steps || []).filter((s) => ticked.has(s.id));
    let eta = 0; let lo = 0; let hi = 0; let unknown = false; let deletes = 0;
    for (const s of sel) {
      eta += s.eta_s || 0;
      if (s.deletes) deletes++;
      const c = s.cost;
      if (c && c.usd && typeof c.usd === 'object') { lo += c.usd.lo; hi += c.usd.hi; } else if (isLlm(s)) unknown = true;
    }
    const cost = hi > 0 ? (lo === hi ? usd(lo) : usd(lo) + '-' + usd(hi)) + (unknown ? ' + unknown' : '') : unknown ? 'cost unknown' : '$0 / 0 tokens';
    return { count: sel.length, eta, cost, deletes };
  }
  function stepPct(step, now) {
    if (!step) return 0;
    if (step.status === 'done' || step.status === 'failed') return 100;
    if (step.status !== 'running' || typeof step.startedAt !== 'number') return 0;
    const eta = Math.max(1, step.eta_s || 1) * 1000;
    return Math.max(2, Math.min(95, Math.round(((now - step.startedAt) / eta) * 100)));
  }
  function runPct(run, now) {
    if (!run || !Array.isArray(run.steps) || !run.steps.length) return 0;
    const tot = run.steps.reduce((a, s) => a + Math.max(1, s.eta_s || 1), 0);
    const got = run.steps.reduce((a, s) => a + (Math.max(1, s.eta_s || 1) * stepPct(s, now)) / 100, 0);
    return Math.round((got / tot) * 100);
  }
  function lastLine(run) {
    if (!run) return 'No health check run yet.';
    if (!run.endedAt) return 'Health check running (' + (run.steps || []).length + ' steps).';
    const n = (run.steps || []).length;
    const failed = (run.steps || []).filter((s) => s.status === 'failed').length;
    return 'Last run ' + new Date(run.endedAt).toLocaleString() + ': ' + n + ' step' + (n === 1 ? '' : 's') + ', ' + (failed ? failed + ' failed, ' : '') + (run.findings || 0) + ' finding' + (run.findings === 1 ? '' : 's') + ', ' + (run.deleted || 0) + ' removed.';
  }
  // Route line: the kit route against what the two dropdowns ask for.
  // proxyLabel: the account the proxy pin bills; split onto any other account is refused.
  function routeText(r, mainLabel, headlessLabel, proxyLabel) {
    if (mainLabel && headlessLabel && mainLabel !== headlessLabel && headlessLabel !== proxyLabel) return 'Not allowed: split sends headless runs through the proxy, which bills ' + (proxyLabel || 'no configured account') + '. Pick that account or the main account.';
    const want = mainLabel && headlessLabel ? (mainLabel === headlessLabel ? 'single (both on ' + mainLabel + ')' : 'split (' + mainLabel + ' interactive, ' + headlessLabel + ' headless through the proxy)') : '';
    if (!r) return want ? 'Asks for: ' + want + '.' : '';
    if (!r.plugin) return 'Asks for: ' + want + '. Stored only (no plugin applies the kit route).';
    const k = r.kit || {};
    if (!k.supported) return 'Asks for: ' + want + '. Kit route not applied: ' + (k.reason || 'unsupported') + '.';
    if (!k.mode || !k.valid) return 'Asks for: ' + want + '. Kit route NOT SET: every headless run refuses until it is applied (Save applies it).';
    if (k.mode !== r.desired) return 'Asks for: ' + want + '. Kit route is ' + k.mode + ': Save applies the change.';
    return 'Kit route: ' + k.mode + (k.mode === 'single' ? ' (headless runs bill the main account)' : ' (headless runs through the proxy)') + '.';
  }
  const api = { costText, totals, stepPct, runPct, lastLine, routeText, isLlm };
  if (typeof module === 'object' && module.exports) module.exports.Health = api;
  else root.CCHealth = api;
})(this);

// ---------- UPDATES BADGE (MERGE-CON G5; pure, also loaded by tests/updbadge.test.js) ----------
// The header "Update available vX" badge from GET /api/updates. Hidden (null) while
// updates.repo is unset: no repo means no release check, so any version is stale.
(function (root) {
  'use strict';
  function badge(s) {
    if (!s || !s.settings || !s.settings.repo) return null;
    const c = s.lastCheck;
    const a = s.auto || {};
    const v = c && c.available && c.latest ? c.latest.version : a.available || null;
    if (!v) return null;
    const cur = s.installed ? 'v' + s.installed.version + ' installed' : 'v' + s.version + ' running';
    const review = a.review ? ' v' + a.review.version + ' needs review: ' + a.review.conflicts.length + ' conflicting file' + (a.review.conflicts.length === 1 ? '' : 's') + '.' : '';
    return { text: 'Update available v' + v, title: cur + '; v' + v + ' is available.' + review + ' Opens Settings > Updates & repair.' };
  }
  const api = { badge };
  if (typeof module === 'object' && module.exports) module.exports.Upd = api;
  else root.CCUpd = api;
})(this);

// ---------- G3 SCREENS (MERGE-CON; pure, also loaded by tests/g3ui.test.js) ----------
// Text and shape for the three screens G3 shipped server-only: the task-scheduler
// viewport (CON-SCHEDULER, /api/scheduler*), the health schedule (CON-HEALTH-SCHED,
// /api/health/schedule) and the OBSERVE-ONLY watchdog (CON-WATCHDOG, /api/watchdog).
// Statuspanel convention: one line per item, the detail on hover; no account names.
// The watchdog view shows readings only: the server's threshold candidates are never read.
(function (root) {
  'use strict';
  const NA = '--';
  const KINDS = ['once', 'daily', 'weekly', 'logon', 'boot'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

  // ISO 8601 duration (PT5S, PT1H30M, P1D) -> '5s', '1h30m', '1d'; '' when unreadable.
  function dur(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
    if (!m || !(m[1] || m[2] || m[3] || m[4])) return '';
    return (m[1] ? m[1] + 'd' : '') + (m[2] ? m[2] + 'h' : '') + (m[3] ? m[3] + 'm' : '') + (m[4] ? m[4] + 's' : '');
  }
  function durSec(iso) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(iso || ''));
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }
  const hhmm = (s) => { const m = /T(\d{2}:\d{2})/.exec(String(s || '')); return m ? m[1] : ''; };
  const ymd = (s) => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(s || '')); return m ? m[1] : ''; };
  // Task Scheduler local time ('s' format) -> 'yyyy-mm-dd hh:mm'; the never-run sentinel
  // (1999-11-30) and null are '--'.
  function when(s) {
    const d = ymd(s);
    if (!d || +d.slice(0, 4) < 2000) return NA;
    return d + (hhmm(s) ? ' ' + hhmm(s) : '');
  }
  function triggerText(t) {
    if (!t) return NA;
    let s = String(t.kind || 'other');
    if (t.kind === 'once' && ymd(t.start)) s += ' ' + ymd(t.start);
    if ((t.kind === 'once' || t.kind === 'daily' || t.kind === 'weekly') && hhmm(t.start)) s += ' ' + hhmm(t.start);
    if (dur(t.delay)) s += ' +' + dur(t.delay);
    if (dur(t.interval)) s += ', every ' + dur(t.interval);
    if (t.enabled === false) s += ' (off)';
    return s;
  }
  function triggersText(task) {
    const ts = (task && task.triggers) || [];
    return ts.length ? ts.map(triggerText).join('; ') : 'no trigger';
  }
  const isBoot = (task) => ((task && task.triggers) || []).some((t) => t && (t.kind === 'boot' || t.kind === 'logon'));
  const failing = (task) => !!(task && task.result && task.result.ok === false);
  // One display row. Never carries the task author (an account name).
  function row(task) {
    let word = 'ready';
    let cls = 'v-done';
    if (task.enabled === false || task.state === 'Disabled') { word = 'disabled'; cls = 'v-idle'; }
    else if (failing(task)) { word = task.result.text; cls = 'v-failed'; }
    else if (task.state === 'Running') { word = 'running'; cls = 'v-running'; }
    else if (task.result && task.result.text === 'never run') { word = 'never run'; cls = 'v-pending'; }
    const acts = (task.actions || []).map((a) => [a.exe, a.args].filter(Boolean).join(' ') + (a.workdir ? ' (in ' + a.workdir + ')' : ''));
    const title = [
      task.full || ((task.path || '\\') + task.name),
      'trigger ' + triggersText(task),
      'last ' + when(task.lastRun) + ' (' + ((task.result && task.result.text) || 'unknown') + '), next ' + when(task.nextRun),
    ].concat(acts.map((a) => 'runs ' + a), task.description ? [task.description] : [], task.notes || []).join('\n');
    return { key: task.full || ((task.path || '\\') + task.name), path: task.path || '\\', name: task.name, enabled: task.enabled !== false && task.state !== 'Disabled', trigger: triggersText(task), next: when(task.nextRun), word, cls, boot: isBoot(task), title };
  }
  // Groups: the console first, then repos (by label), then tasks that map to no repo.
  function groups(list, projects, filter) {
    if (!list || !list.available) return [];
    const label = new Map((projects || []).map((p) => [p.id, p.name || p.id]));
    label.set('console', 'Console');
    const by = new Map();
    for (const t of list.tasks || []) {
      const id = t.owner || '';
      if (filter && id !== filter) continue;
      if (!by.has(id)) by.set(id, []);
      by.get(id).push(row(t));
    }
    const lab = (id) => (id === '' ? 'Not in a repo' : label.get(id) || id);
    const rank = (id) => (id === 'console' ? 0 : id === '' ? 2 : 1);
    return [...by.keys()].sort((a, b) => rank(a) - rank(b) || lab(a).localeCompare(lab(b))).map((id) => ({ id, label: lab(id), rows: by.get(id) }));
  }
  function summary(list) {
    if (!list) return 'Task scheduler unavailable.';
    if (!list.available) return 'Task scheduler unavailable' + (list.error ? ': ' + list.error : '') + '.';
    const ts = list.tasks || [];
    return plural(ts.length, 'task') + ', ' + ts.filter(isBoot).length + ' at boot/logon, ' + ts.filter(failing).length + ' failing';
  }
  function intOrEmpty(v, what) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return { ok: true, v: null };
    if (!/^\d+$/.test(s)) return { ok: false, error: what + ' must be a whole number' };
    return { ok: true, v: +s };
  }
  // Trigger form values -> the API trigger object (the server validates again).
  function triggerBody(f) {
    const kind = String(f.kind || '');
    if (!KINDS.includes(kind)) return { ok: false, error: 'trigger kind must be one of ' + KINDS.join(', ') };
    const t = { kind };
    if (kind === 'once' || kind === 'daily' || kind === 'weekly') {
      if (!HHMM.test(String(f.at || ''))) return { ok: false, error: 'trigger time must be HH:MM' };
      t.at = f.at;
    }
    if (kind === 'once' && f.date) t.date = String(f.date);
    if (kind === 'weekly') {
      const days = (f.days || []).filter((d) => DAYS.includes(d));
      if (!days.length) return { ok: false, error: 'weekly needs at least one day' };
      t.days = days;
    }
    if (kind === 'logon' || kind === 'boot') {
      const d = intOrEmpty(f.delaySeconds, 'delay');
      if (!d.ok) return d;
      if (d.v !== null) t.delaySeconds = d.v;
    }
    const e = intOrEmpty(f.everyMinutes, 'repeat');
    if (!e.ok) return e;
    if (e.v !== null) t.everyMinutes = e.v;
    return { ok: true, trigger: t };
  }
  function addBody(f) {
    f = f || {};
    const name = String(f.name || '').trim();
    if (!name) return { ok: false, error: 'task name required' };
    const exe = String(f.exe || '').trim();
    if (!exe) return { ok: false, error: 'program (full path) required' };
    const t = triggerBody(f);
    if (!t.ok) return t;
    return { ok: true, body: { path: String(f.folder || '').trim() || '\\', name, exe, args: String(f.args || ''), workdir: String(f.workdir || '').trim(), description: String(f.description || ''), enabled: f.enabled !== false, trigger: t.trigger } };
  }
  // An existing trigger -> form values for the edit form.
  function triggerOf(t) {
    if (!t) return { kind: 'daily', at: '', date: '', days: [], everyMinutes: '', delaySeconds: '' };
    const every = durSec(t.interval);
    const delay = durSec(t.delay);
    return { kind: KINDS.includes(t.kind) ? t.kind : 'daily', at: hhmm(t.start), date: ymd(t.start), days: [], everyMinutes: every ? String(Math.round(every / 60)) : '', delaySeconds: delay ? String(delay) : '' };
  }
  const Sched = { KINDS, DAYS, dur, when, triggerText, triggersText, row, groups, summary, addBody, triggerBody, triggerOf };

  // ---------- health schedule ----------
  function line(st) {
    if (!st) return 'Scheduled health check unavailable.';
    if (!st.available) return 'Scheduled health check unavailable' + (st.reason ? ': ' + st.reason : '') + '.';
    if (!st.enabled) return 'Scheduled health check off' + (st.task ? ' (task disabled)' : '') + '.';
    return 'Scheduled health check on: ' + (st.schedule && st.schedule.at ? st.schedule.kind + ' ' + st.schedule.at : 'custom trigger') + '.';
  }
  function lastText(st) {
    if (st && st.statusLine) return st.statusLine;
    const r = st && st.lastRun;
    if (!r) return 'No scheduled run yet.';
    return 'Last scheduled run ' + when(r.startedAtIso) + ': ' + (r.status || 'unknown') + ', ' + plural(r.findings | 0, 'finding') + '.';
  }
  function body(f) {
    f = f || {};
    if (!f.enabled) return { ok: true, body: { enabled: false } };
    if (!HHMM.test(String(f.at || ''))) return { ok: false, error: 'time must be HH:MM' };
    const b = { enabled: true, at: f.at };
    const days = (f.days || []).filter((d) => DAYS.includes(d));
    if (days.length && days.length < 7) b.days = days;
    return { ok: true, body: b };
  }
  const HSched = { line, lastText, body };

  // ---------- watchdog (observe only) ----------
  const every = (s) => (s < 120 ? s + 's' : s < 7200 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h');
  const sgn = (v) => (v > 0 ? '+' : '') + v;
  function head(snap) {
    if (!snap) return 'Watchdog unavailable.';
    const a = snap.analysis || {};
    let s = 'Observe only. ' + (snap.collecting ? 'Sampling every ' + every(snap.intervalSec || 600) : 'Collector not sampling') + '; ' + plural(a.samples | 0, 'sample') + ' over ' + (a.spanH || 0) + ' h';
    if (snap.lastSampleAt) s += ', last ' + new Date(snap.lastSampleAt).toLocaleString();
    if (snap.lastError) s += '; last sample failed: ' + String(snap.lastError).slice(0, 160);
    return s + '.';
  }
  function trendTitle(t, extra) {
    return [t.name + ' (pid ' + t.pid + ')', extra, plural(t.n | 0, 'sample') + ' over ' + t.spanH + ' h'].concat(t.seed ? ['seed ' + t.seed] : [], t.owner ? ['tree ' + t.owner] : []).join('\n');
  }
  function stat(label, s, unit) {
    if (!s || s.median === null || s.median === undefined) return { label, value: NA, title: label + ': no samples' };
    return { label, value: 'median ' + s.median + ', p95 ' + s.p95 + ', max ' + s.max + (unit ? ' ' + unit : ''), title: label };
  }
  function sections(snap) {
    const a = (snap && snap.analysis) || {};
    const pg = a.paging || {};
    const cr = a.crashes || { total: 0, wer: 0, byApp: [] };
    return [
      { id: 'priv', title: 'Private bytes growth (top 10)', empty: 'No growing process yet (needs 3 samples per process).',
        rows: (a.privGrowth || []).map((t) => ({ label: t.name, value: sgn(t.mbPerH) + ' MB/h (r2 ' + t.r2 + ')', title: trendTitle(t, t.privMB + ' MB now, ' + sgn(t.mbPerH) + ' MB/h, fit r2 ' + t.r2) })) },
      { id: 'handles', title: 'Handle growth (top 10)', empty: 'No growing handle count yet.',
        rows: (a.handleGrowth || []).map((t) => ({ label: t.name, value: sgn(t.perH) + ' handles/h (r2 ' + t.r2h + ')', title: trendTitle(t, t.handles + ' handles now, ' + sgn(t.perH) + ' handles/h, fit r2 ' + t.r2h) })) },
      { id: 'seeds', title: 'Known cases', empty: 'No known cases configured.',
        rows: (a.seeds || []).map((s) => ({ label: s.id, value: s.n ? s.privMB + ' MB ' + sgn(s.mbPerH) + ' MB/h, ' + s.handles + ' handles ' + sgn(s.handlesPerH) + '/h' : s.seen ? 'seen, too few samples' : 'not seen', title: s.id + (s.known ? '\nknown: ' + s.known : '') })) },
      { id: 'paging', title: 'Paging (' + plural(pg.n | 0, 'sample') + ')', empty: 'No paging samples yet.',
        rows: pg.n ? [stat('pages/s', pg.pagesPerSec), stat('page reads/s', pg.pageReadsPerSec), stat('available', pg.availMB, 'MB'), stat('commit', pg.commitPct, '%')] : [] },
      { id: 'crashes', title: 'Crashes and hangs', empty: 'No crash or hang events.', note: plural(cr.wer | 0, 'WER report') + ' in the window.',
        rows: (cr.byApp || []).map((x) => ({ label: x.app || '(unknown app)', value: (x.crashes | 0) + ((x.crashes | 0) === 1 ? ' crash' : ' crashes') + ', ' + plural(x.hangs | 0, 'hang'), title: x.app })) },
      { id: 'measuring', title: 'Still measuring', empty: 'Nothing listed.',
        rows: (a.measuring || []).filter((m) => !/threshold/i.test(m)).map((m) => ({ label: m, value: '', title: m })) },
    ];
  }
  const Watch = { head, sections };

  const api = { Sched, HSched, Watch };
  if (typeof module === 'object' && module.exports) Object.assign(module.exports, api);
  else { root.CCSched = Sched; root.CCHSched = HSched; root.CCWatch = Watch; }
})(this);

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const CH = window.CCChrome;
  const FL = window.CCFlow;
  const US = window.CCUsage;
  const RS = window.CCRes;
  const HL = window.CCHealth;
  const PL = window.CCPlace;
  const TY = window.CCType;
  const CD = window.CCCard;
  const KY = window.CCKeys;
  const SD = window.CCSide;
  const SC = window.CCSched;
  const HS = window.CCHSched;
  const WD = window.CCWatch;
  const UP = window.CCUpd;
  const CLIENT_ID = PL.newClientId(); // per page load; sent with every pane this page opens

  // ---------- state vocabulary (UI/UX standard section 1) ----------
  // Pane state -> one glyph + one word + one token class; never colour alone.
  function vstate(p) {
    const s = p && p.state;
    if (s === 'exited') return p.exitCode === 0 ? 'done' : 'failed';
    if (s === 'busy') return 'running';
    if (s === 'attention') return 'needs';
    if (s === 'waiting') return 'idle';
    return 'pending';
  }
  const VGLYPH = { running: '>', done: '+', failed: 'x', needs: '?', idle: '-', pending: '.', stale: '!', halted: '=' };
  const VWORD = { running: 'running', done: 'done', failed: 'failed', needs: 'needs you', idle: 'idle', pending: 'starting', stale: 'STALE', halted: 'halted' };
  function setDot(d, vs, title) {
    d.className = 'dot v-' + vs;
    d.dataset.g = VGLYPH[vs] || '-';
    d.title = title || VWORD[vs] || vs;
  }
  // CON-UX-PANEROWS: row count + shown states from Settings (per machine).
  let flowOptsCache = null;
  let flowOptsFor = null;
  function flowOpts() {
    if (flowOptsFor !== settings) { flowOptsFor = settings; flowOptsCache = FL.normalizeOpts(settings); }
    return flowOptsCache;
  }
  // Keyed in-place row patching for a workflow box: slots are reused by index and only
  // changed text is written, so a status refresh moves nothing.
  function drawFlow(box, flow) {
    const rows = FL.view(flow, flowOpts());
    const h = flow.height;
    while (box.children.length < h) {
      const r = el('div', 'frow');
      for (let i = 0; i < 5; i++) r.appendChild(el('span', 'fc' + i));
      box.appendChild(r);
    }
    while (box.children.length > h) box.lastChild.remove();
    for (let i = 0; i < h; i++) {
      const row = box.children[i];
      const r = rows[i];
      const now = Date.now();
      // CONETA: a running row with "started" shows the kit's clock form in one wider cell
      const clk = r ? FL.clockOf(r, now) : '';
      const cls = 'frow' + (r ? ' f-' + r.state : '') + (clk ? ' clk' : '');
      if (row.className !== cls) row.className = cls;
      const c = r ? FL.cells(r, now) : ['', '', '', '', ''];
      for (let j = 0; j < 5; j++) if (row.children[j].textContent !== c[j]) row.children[j].textContent = c[j];
      const t = r ? r.label + (r.step ? '\n' + r.step : '') : '';
      if (row.title !== t) row.title = t;
    }
  }

  // ---------- per-viewer UI prefs (browser storage; the page works without it) ----------
  function prefGet(k, dflt) {
    try { const v = localStorage.getItem(k); return v === null ? dflt : v; } catch (e) { return dflt; }
  }
  function prefSet(k, v) {
    try { localStorage.setItem(k, v); } catch (e) { /* ignore */ }
  }
  // Composer-only claude panes: hide claude's own input box and status rows.
  let hideCliChrome = prefGet('cc-cli-chrome', 'hide') !== 'show';

  // ---------- token ----------
  let TOKEN = null;
  const hm = /[#&]t=([0-9a-f]+)/.exec(location.hash);
  if (hm) {
    TOKEN = hm[1];
    try { sessionStorage.setItem('cc-token', TOKEN); } catch (e) { /* ignore */ }
    history.replaceState(null, '', location.pathname);
  } else {
    try { TOKEN = sessionStorage.getItem('cc-token'); } catch (e) { TOKEN = null; }
  }

  const $ = (sel, root) => (root || document).querySelector(sel);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  };

  async function api(method, path, body) {
    const r = await fetch(path, {
      method,
      headers: Object.assign({ 'X-Console-Token': TOKEN || '' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  // ---------- state ----------
  let info = null;
  let settings = null;
  let projects = [];
  let statusSnap = null;
  const views = new Map(); // id -> PaneView
  let order = [];
  let dormant = []; // layout entries without a live pane
  let maximizedId = null;
  let focusedId = null;

  const THEMES = {
    dark: {
      background: '#111318', foreground: '#e4e6eb', cursor: '#e8a35c', cursorAccent: '#111318', selectionBackground: '#3a4252',
      black: '#1d2027', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#d7dae0',
      brightBlack: '#6b7280', brightRed: '#ff7b86', brightGreen: '#b5e890', brightYellow: '#ffd68a', brightBlue: '#82c4ff', brightMagenta: '#dd9af0', brightCyan: '#7fd6e0', brightWhite: '#ffffff',
    },
    light: {
      background: '#fbfbf8', foreground: '#1f2328', cursor: '#b5651d', cursorAccent: '#fbfbf8', selectionBackground: '#c8d7ef',
      black: '#24292f', red: '#c62828', green: '#2e7d32', yellow: '#8a6d00', blue: '#1f5fbf', magenta: '#8e3fb0', cyan: '#00796b', white: '#4f5761',
      brightBlack: '#57606a', brightRed: '#e53935', brightGreen: '#43a047', brightYellow: '#7d6400', brightBlue: '#2f76e0', brightMagenta: '#a452c8', brightCyan: '#00897b', brightWhite: '#424a53',
    },
  };

  function fmtAge(ms) {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function fmtEta(s) {
    if (s === null || s === undefined) return '';
    if (s < 120) return '~' + Math.round(s) + 's';
    if (s < 7200) return '~' + Math.round(s / 60) + 'm';
    return '~' + Math.round(s / 3600) + 'h';
  }
  // Split an args string, honouring double quotes.
  function splitArgs(s) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(s || ''))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }

  // ---------- theme / settings ----------
  // R13: 'system' follows prefers-color-scheme (no data-theme attribute; tokens.css and
  // app.css both read the media query); 'dark' / 'light' force one.
  const darkMq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function effTheme() {
    const t = settings && settings.theme;
    if (t === 'light' || t === 'dark') return t;
    return darkMq && !darkMq.matches ? 'light' : 'dark';
  }
  function applyTheme() {
    const t = settings.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    $('#font-size-label').textContent = settings.fontSize + 'px';
    applyTypeScale(settings.typeScale);
    document.body.classList.toggle('no-status', !settings.statusPanel);
    $('#statuspanel').style.width = (settings.statusWidth || 380) + 'px';
    for (const v of views.values()) v.applyLook();
  }

  // CON-UX-TYPESCALE: write the six --fs-* levels on :root (app.css holds the same
  // values as fallbacks, so the page is right before this runs).
  function applyTypeScale(scale) {
    const st = document.documentElement.style;
    let moved = false;
    for (const [k, v] of Object.entries(TY.vars(scale))) {
      if (st.getPropertyValue(k) === v) continue;
      st.setProperty(k, v);
      moved = true;
    }
    // the top-bar strips measure their text: re-fit once the sizes changed
    if (moved && $('#us-slots') && $('#us-slots').children.length) { try { fitUsage(); } catch (e) { /* strip not built yet */ } }
  }

  async function saveSettings(patch) {
    settings = await api('PUT', '/api/settings', Object.assign({}, settings, patch));
    applyTheme();
    for (const v of views.values()) v.renderChips();
  }

  // ---------- layout persistence ----------
  let saveTimer = null;
  function layoutBody() {
    const live = order.filter((id) => views.has(id)).map((id) => views.get(id).layoutEntry());
    return { panes: live.concat(dormant), maximized: maximizedId };
  }
  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      api('PUT', '/api/layout', layoutBody()).catch(() => {});
    }, 400);
  }
  // A reload / close inside the debounce window must not lose the last change.
  window.addEventListener('pagehide', () => {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fetch('/api/layout', { method: 'PUT', keepalive: true, headers: { 'X-Console-Token': TOKEN || '', 'Content-Type': 'application/json' }, body: JSON.stringify(layoutBody()) });
    } catch (e) { /* closing */ }
  });

  // ---------- pane view ----------
  const NEEDLE_CAP = 300;
  // /done receipt line (CON-6): this exact text, alone on its line, gets the done styling.
  const DONE_TEXT = 'Done ritual complete, safe to clear';
  function loadNeedles(id) {
    try {
      const v = JSON.parse(localStorage.getItem('cc-inputs-' + id) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-NEEDLE_CAP) : [];
    } catch (e) { return []; }
  }
  function saveNeedles(id, needles) {
    try { localStorage.setItem('cc-inputs-' + id, JSON.stringify(needles)); } catch (e) { /* ignore */ }
  }

  class PaneView {
    constructor(pinfo, saved) {
      this.id = pinfo.id;
      this.info = pinfo;
      this.minimized = !!(saved && saved.minimized);
      this.fontSize = saved && saved.fontSize ? saved.fontSize : null;
      this.history = [];
      this.histIdx = -1;
      this.ws = null;
      this.closing = false;
      this.retry = 0;
      // Operator-input highlighting (see markInput / scanInputs).
      this.lineBuf = '';
      this.userDecos = [];
      this.doneDecos = [];
      this.doneOverride = false; // tests: style the done line in a shell pane too
      this.lineDecos = []; // R6 line-class bars (claude panes)
      this.lineOverride = false; // tests: classify lines in a shell pane too
      this.scanFrom = 0;
      this.scanTimer = null;
      this.needles = loadNeedles(this.id);
      // Composer-only chrome crop (see detectChrome).
      this.crop = 0;
      this.cropWant = 0;
      this.cropTimer = null;
      this.chromeTimer = null;
      this.chrome = null;
      this.peek = false;
      this.compactOverride = false; // tests: treat a shell pane like a claude pane
      // Slash drop-up (CON-5): command list above the composer in claude panes.
      this.slashOverride = false; // tests: give a shell pane the claude slash list
      this.slashRows = null;
      this.slashAt = 0;
      this.slashHits = [];
      this.slashIdx = 0;
      this.slashLoading = null;
      this.build();
      this.connect();
    }

    layoutEntry() {
      const i = this.info;
      return { id: i.id, kind: i.kind, projectId: i.projectId, account: i.account, shell: i.shell, title: i.title, cwd: i.cwd, sessionId: i.sessionId, minimized: this.minimized, fontSize: this.fontSize };
    }

    build() {
      const root = el('div', 'pane');
      root.dataset.id = this.id;
      const head = el('div', 'pane-head');
      this.dot = el('span', 'dot');
      this.titleEl = el('span', 'ptitle');
      this.infoEl = el('span', 'pinfo');
      // Fixed-width badge slot: always rendered, text only for "needs you" (the one
      // actionable state); an empty slot keeps its width so the header never shifts.
      this.badge = el('span', 'badge slot blank');
      // What claude's hidden status rows carried: agents / shells / monitors / ctx.
      // Always present in claude panes (empty = '-'); a shell pane never shows it.
      this.statEl = el('span', 'pstat', '-');
      this.statEl.style.display = 'none';
      this.statEl.addEventListener('click', (e) => { e.stopPropagation(); this.peek = !this.peek; this.refreshChromeMode(); });
      // Fixed slots (standard s4): state word + time (R5), project pct + ETA (R8).
      this.wordEl = el('span', 'pword', '-');
      this.progEl = el('span', 'pprog', '-');
      const btns = el('span', 'pbtns');
      const mk = (box, label, title, fn, cls) => {
        const b = el('button', cls || null, label);
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        box.appendChild(b);
        return b;
      };
      this.maxBtn = mk(btns, 'Max', 'Maximize / restore', () => toggleMax(this.id));
      mk(btns, 'Min', 'Minimize to the taskbar', () => setMinimized(this.id, true));
      mk(btns, 'X', 'Close (kills the process)', () => closePane(this.id));
      // R7: the rest of the header lives in one '...' menu (reachable on touch).
      this.menuBtn = mk(btns, '...', 'More: font size, Find, Compose, Restart, pane info', () => this.toggleMenu(), 'more');
      this.menuBtn.setAttribute('aria-haspopup', 'true');
      this.menuBtn.setAttribute('aria-expanded', 'false');
      this.menuEl = el('div', 'pmenu');
      this.menuEl.setAttribute('role', 'menu');
      const fr = el('div', 'pm-row');
      const menu = (box, label, title, fn) => mk(box, label, title, () => { if (fn() !== false) this.toggleMenu(false); });
      menu(fr, 'A-', 'Smaller font (this pane)', () => { this.bumpFont(-1); return false; });
      menu(fr, 'A+', 'Larger font (this pane)', () => { this.bumpFont(1); return false; });
      this.menuEl.appendChild(fr);
      menu(this.menuEl, 'Find', 'Search scrollback (Ctrl+Shift+F)', () => { this.toggleSearch(); });
      menu(this.menuEl, 'Compose', 'Show/hide the prompt composer', () => { this.composer.classList.toggle('collapsed'); });
      menu(this.menuEl, 'Restart', 'Restart this pane', () => { this.restart(false); });
      this.menuInfo = el('div', 'pm-info', '');
      this.menuEl.appendChild(this.menuInfo);
      for (const b of this.menuEl.querySelectorAll('button')) b.setAttribute('role', 'menuitem');
      this.menuEl.addEventListener('mousedown', (e) => e.stopPropagation());
      this.menuEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.toggleMenu(false); this.menuBtn.focus(); } });
      head.append(this.dot, this.titleEl, this.infoEl, this.wordEl, this.progEl, this.badge, this.statEl, btns);
      head.addEventListener('dblclick', () => toggleMax(this.id));
      // Drag by the title bar only (never from a header button, never from the terminal,
      // so xterm keeps its own mouse selection).
      head.draggable = true;
      head.addEventListener('pointerdown', (e) => { this.dragFromBtn = !!e.target.closest('button'); });
      head.addEventListener('dragstart', (e) => {
        if (this.dragFromBtn) {
          e.preventDefault();
          return;
        }
        startDrag(e, this.id, root);
      });
      head.addEventListener('dragend', endDrag);
      root.addEventListener('dragover', (e) => paneDragOver(e, this.id));
      root.addEventListener('drop', (e) => paneDrop(e, this.id));
      // Files / text dropped anywhere on the pane go to the composer (attachments).
      root.addEventListener('dragover', (e) => {
        if (!isContentDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        root.classList.add('file-over');
      });
      root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) root.classList.remove('file-over'); });
      root.addEventListener('drop', (e) => {
        root.classList.remove('file-over');
        if (!isContentDrag(e)) return;
        e.preventDefault();
        e.stopPropagation();
        this.takeTransfer(e.dataTransfer);
      });

      // Always-present one-line strip (UI/UX standard section 4): the permission note,
      // else the /done band, else blank. Never inserted or removed, so nothing moves.
      this.noteEl = el('div', 'pane-strip');
      // Workflow rows (standard section 4): the project's progress files, one fixed row
      // per task, updated in place; height = max rows seen (cap 6); reset by /done.
      this.flowEl = el('div', 'flow');
      this.flow = FL.create(Date.now());
      this.flowFromStart = true; // widened once to the pane's startedAt below

      this.searchBar = el('div', 'pane-search');
      this.searchInput = el('input');
      this.searchInput.placeholder = 'Search scrollback (Enter = next, Shift+Enter = previous)';
      const sPrev = el('button', 'small', 'Prev');
      const sNext = el('button', 'small', 'Next');
      const sClose = el('button', 'small', 'Close');
      this.searchCount = el('span', 'muted small');
      this.searchBar.append(this.searchInput, this.searchCount, sPrev, sNext, sClose);
      const sopts = () => ({
        incremental: false, caseSensitive: false,
        // Per theme (R10): the dark match tint was 2.35:1 under light-theme text.
        decorations: effTheme() === 'light'
          ? { matchBackground: '#f2d98c', activeMatchBackground: '#e8a35c', matchOverviewRuler: '#b5651d', activeMatchColorOverviewRuler: '#b5651d' }
          : { matchBackground: '#6b5a2a', activeMatchBackground: '#e8a35c', matchOverviewRuler: '#e8a35c', activeMatchColorOverviewRuler: '#ff9900' },
      });
      this.searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) this.search.findPrevious(this.searchInput.value, sopts());
          else this.search.findNext(this.searchInput.value, sopts());
        } else if (e.key === 'Escape') this.toggleSearch(false);
      });
      this.searchInput.addEventListener('input', () => this.search.findNext(this.searchInput.value, Object.assign(sopts(), { incremental: true })));
      sNext.addEventListener('click', () => this.search.findNext(this.searchInput.value, sopts()));
      sPrev.addEventListener('click', () => this.search.findPrevious(this.searchInput.value, sopts()));
      sClose.addEventListener('click', () => this.toggleSearch(false));

      // The terminal sits in a clipping wrapper: in a composer-only claude pane the pty
      // gets `crop` extra rows that fall below the wrapper's edge (claude's input box and
      // status rows), and a mask covers the block while it floats above the bottom.
      this.termWrap = el('div', 'term-wrap');
      this.termEl = el('div', 'term');
      this.maskEl = el('div', 'chrome-mask');
      this.termWrap.append(this.termEl, this.maskEl);

      const exitBar = el('div', 'pane-exit');
      this.exitText = el('span', null, 'Process exited.');
      const rb = el('button', 'small', 'Restart fresh');
      rb.addEventListener('click', () => this.restart(false));
      this.resumeBtn = el('button', 'small', 'Resume conversation');
      this.resumeBtn.addEventListener('click', () => this.restart(true));
      const cb = el('button', 'small', 'Close');
      cb.addEventListener('click', () => closePane(this.id));
      exitBar.append(this.exitText, rb, this.resumeBtn, cb);

      // Composer
      this.composer = el('div', 'composer');
      this.ta = el('textarea');
      this.ta.placeholder = 'Prompt composer - Enter sends (empty sends Enter), Shift+Enter: new line. Alt+Up/Down: history. Esc: back to terminal.';
      this.ta.rows = 1;
      this.ta.addEventListener('keydown', (e) => this.composerKey(e));
      this.ta.addEventListener('input', () => { this.growComposer(); this.slashUpdate(); });
      this.ta.addEventListener('click', () => this.slashUpdate());
      this.ta.addEventListener('keyup', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') this.slashUpdate(); });
      this.ta.addEventListener('blur', () => this.slashClose());
      this.ta.setAttribute('aria-autocomplete', 'list');
      this.ta.setAttribute('aria-expanded', 'false');
      this.slashEl = el('div', 'slash-menu');
      this.slashEl.id = 'slash-' + this.id;
      this.slashEl.setAttribute('role', 'listbox');
      this.slashEl.setAttribute('aria-label', 'Slash commands');
      this.ta.setAttribute('aria-controls', this.slashEl.id);
      // Keep the caret in the composer: a press on the list must not blur it (mouse
      // and touch); the click that follows accepts the row.
      this.slashEl.addEventListener('pointerdown', (e) => e.preventDefault());
      this.slashEl.addEventListener('mousedown', (e) => e.preventDefault());
      this.slashEl.addEventListener('click', (e) => {
        const row = e.target.closest('.slash-row');
        if (!row) return;
        this.slashAccept(+row.dataset.i);
      });
      this.ta.addEventListener('paste', (e) => {
        const files = e.clipboardData ? [...e.clipboardData.files] : [];
        if (!files.length) return; // plain text pastes as usual
        e.preventDefault();
        this.attachFiles(files);
      });
      this.attachRow = el('div', 'attach-row');
      this.fileInput = el('input');
      this.fileInput.type = 'file';
      this.fileInput.multiple = true;
      this.fileInput.style.display = 'none';
      this.fileInput.addEventListener('change', () => {
        this.attachFiles([...this.fileInput.files]);
        this.fileInput.value = '';
      });
      const crow = el('div', 'crow');
      this.chipBox = el('span', 'crow');
      // CON-UX-KEYS: the key strip is drawn by renderChips() from Settings (shown keys).
      const keyBox = el('span', 'crow');
      this.keyBox = keyBox;
      const grow = el('span', 'grow');
      const sendBtn = el('button', 'primary', 'Send');
      sendBtn.title = 'Send (Enter; Shift+Enter is a new line)';
      sendBtn.addEventListener('click', () => this.sendComposer());
      const attachBtn = el('button', 'attach-btn', 'Attach');
      attachBtn.title = 'Attach files: their saved path goes into the prompt (or drop / paste files and images onto the pane)';
      attachBtn.addEventListener('click', () => this.fileInput.click());
      crow.append(this.chipBox, keyBox, grow, attachBtn);
      // Send sits beside the text box, so the key row stays one line at iPad width.
      const trow = el('div', 'trow');
      trow.append(this.ta, sendBtn);
      this.composer.append(this.slashEl, this.attachRow, trow, crow, this.fileInput);

      root.append(head, this.menuEl, this.noteEl, this.flowEl, this.searchBar, this.termWrap, exitBar, this.composer);
      root.addEventListener('mousedown', () => setFocused(this.id));
      this.root = root;
      $('#grid').appendChild(root);

      // Terminal
      const fontSize = this.fontSize || settings.fontSize;
      this.term = new window.Terminal({
        fontSize, fontFamily: settings.fontFamily, lineHeight: settings.lineHeight || 1.2,
        scrollback: settings.scrollback || 10000, cursorBlink: true, allowProposedApi: true,
        theme: THEMES[effTheme()], macOptionIsMeta: true,
      });
      this.fit = new window.FitAddon.FitAddon();
      this.search = new window.SearchAddon.SearchAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(this.search);
      try { this.term.loadAddon(new window.WebLinksAddon.WebLinksAddon()); } catch (e) { /* optional */ }
      this.search.onDidChangeResults && this.search.onDidChangeResults((r) => {
        this.searchCount.textContent = r && r.resultCount ? (r.resultIndex + 1) + '/' + r.resultCount : '';
      });
      this.term.open(this.termEl);
      this.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) { this.toggleSearch(true); return false; }
        if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.key === 'C') && this.term.hasSelection()) {
          navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
          this.term.clearSelection();
          return false;
        }
        if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
          if (this.term.hasSelection()) navigator.clipboard.writeText(this.term.getSelection()).catch(() => {});
          return false;
        }
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) return false; // let the browser paste event through
        if (e.ctrlKey && e.altKey && (e.key === 'b' || e.key === 'B')) return false; // sidebar toggle (window handler)
        // Composer-only pane: typing lands in the composer, never in claude's hidden box.
        // Enter, Esc, arrows, Tab and Ctrl+keys still go to claude.
        if (this.compactActive() && !this.composer.classList.contains('collapsed') && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
          e.preventDefault();
          this.ta.value += e.key;
          this.growComposer();
          this.ta.focus();
          this.ta.setSelectionRange(this.ta.value.length, this.ta.value.length);
          this.slashUpdate();
          return false;
        }
        return true;
      });
      this.termEl.addEventListener('paste', (e) => {
        if (!this.compactActive() || this.composer.classList.contains('collapsed')) return;
        const files = e.clipboardData ? [...e.clipboardData.files] : [];
        const t = e.clipboardData && e.clipboardData.getData('text');
        e.preventDefault();
        e.stopPropagation();
        if (files.length) this.attachFiles(files);
        else if (t) this.insertAtCursor(t);
        this.ta.focus();
      }, true);
      this.term.onScroll(() => this.applyMask());
      this.term.onData((d) => { this.trackTyped(d); this.sendRaw(d); });
      this.term.onResize(({ cols, rows }) => { this.wsSend({ t: 'resize', cols, rows }); this.scheduleChrome(); });
      this.term.textarea && this.term.textarea.addEventListener('focus', () => setFocused(this.id));
      this.ro = new ResizeObserver(() => this.scheduleFit());
      this.ro.observe(this.termWrap);
      this.renderChips();
      this.update(this.info);
      this.refreshChromeMode();
    }

    toggleMenu(force) {
      const on = force === undefined ? !this.menuEl.classList.contains('open') : !!force;
      if (on === this.menuEl.classList.contains('open')) return;
      this.menuEl.classList.toggle('open', on);
      this.menuBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) {
        for (const v of views.values()) if (v !== this) v.toggleMenu(false);
        const f = this.menuEl.querySelector('button');
        if (f) f.focus();
      }
    }

    // R5 state word (minutes only, so it changes at most once a minute).
    refreshWord() {
      const vs = vstate(this.info);
      let w = CH.paneWord(vs, VWORD[vs] || vs, this.info, Date.now());
      if (vs === 'failed' && this.info.exitCode !== null && this.info.exitCode !== undefined) w = 'failed (' + this.info.exitCode + ')';
      const cls = 'pword v-' + vs;
      if (this.wordEl.textContent !== w) this.wordEl.textContent = w;
      if (this.wordEl.className !== cls) this.wordEl.className = cls;
      const t = this.info.tool && vs === 'running' ? 'Running tool ' + this.info.tool : VWORD[vs] || vs;
      if (this.wordEl.title !== t) this.wordEl.title = t;
    }

    // R8: the project's top running progress item, '-' when none.
    setProgress(items) {
      const t = this.info.projectId ? FL.top(items) : null;
      const text = t ? t.text : '-';
      const cls = 'pprog' + (t ? ' ' + t.cls : '');
      if (this.progEl.textContent !== text) this.progEl.textContent = text;
      if (this.progEl.className !== cls) this.progEl.className = cls;
      const title = t ? t.title : 'No running progress item for this pane\'s project';
      if (this.progEl.title !== title) this.progEl.title = title;
    }

    // Quick chips (ticked ones) and the key strip (shown keys), both from Settings.
    renderChips() {
      this.chipBox.textContent = '';
      for (const c of KY.normalizeChips(settings.quickChips)) {
        if (!c.on) continue;
        const b = el('button', null, c.text);
        b.title = 'Send "' + c.text + '" + Enter';
        b.addEventListener('click', () => this.sendText(c.text));
        this.chipBox.appendChild(b);
      }
      this.keyBox.textContent = '';
      const show = KY.normalizeStrip(settings.keyStrip);
      for (const k of KY.KEYS) {
        if (!show[k.id]) continue;
        const b = el('button', 'key', k.label);
        b.title = k.title;
        b.dataset.key = k.id;
        b.addEventListener('click', () => { this.sendKeys(k.seq); this.focusInput(); });
        this.keyBox.appendChild(b);
      }
    }

    // One pty write per key event; a chord's second key follows after a short gap so
    // the CLI reads two key presses, not one pasted string.
    sendKeys(seq) {
      seq.forEach((s, i) => { if (i === 0) this.sendRaw(s); else setTimeout(() => this.sendRaw(s), 60 * i); });
    }

    applyLook() {
      this.term.options.theme = THEMES[effTheme()];
      this.term.options.fontSize = this.fontSize || settings.fontSize;
      this.term.options.fontFamily = settings.fontFamily;
      this.term.options.lineHeight = settings.lineHeight || 1.2;
      this.scheduleFit();
    }

    bumpFont(d) {
      this.fontSize = Math.max(9, Math.min(40, (this.fontSize || settings.fontSize) + d));
      this.applyLook();
      saveLayout();
    }

    scheduleFit() {
      clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.doFit(), 60);
    }

    cellHeight() {
      const scr = this.term.element && this.term.element.querySelector('.xterm-screen');
      const h = scr ? scr.getBoundingClientRect().height : 0;
      return h && this.term.rows ? h / this.term.rows : 0;
    }

    // Fit the terminal to its wrapper plus `crop` rows. The term element is made exactly
    // crop * cell-height taller than the wrapper, so FitAddon yields visible + crop rows
    // and the extra rows render below the wrapper's clipped edge.
    doFit() {
      if (this.root.classList.contains('hidden') || !this.termWrap.offsetWidth) return;
      for (let pass = 0; pass < 2; pass++) {
        const ch = this.cellHeight();
        const px = this.crop && ch ? Math.round(this.crop * ch * 100) / 100 : 0;
        this.termEl.style.height = px ? 'calc(100% + ' + px + 'px)' : '';
        try { this.fit.fit(); } catch (e) { return; }
        if (!this.crop || Math.abs(this.cellHeight() - ch) < 0.01) break;
      }
      this.applyMask();
    }

    // Rows the operator can see (the pty has `crop` more below the edge).
    get visibleRows() {
      return this.term.rows - this.crop;
    }

    compactActive() {
      return hideCliChrome && !this.peek && (this.info.kind === 'claude' || this.compactOverride);
    }

    focusInput() {
      if (this.compactActive() && !this.composer.classList.contains('collapsed')) this.ta.focus();
      else this.term.focus();
    }

    growComposer() {
      const ta = this.ta;
      const before = ta.offsetHeight;
      ta.style.height = 'auto';
      const max = Math.round(window.innerHeight * 0.4);
      ta.style.height = Math.min(ta.scrollHeight + 2, max) + 'px';
      if (ta.offsetHeight !== before) this.scheduleFit();
    }

    scheduleChrome() {
      if (this.chromeTimer) return;
      this.chromeTimer = setTimeout(() => { this.chromeTimer = null; this.detectChrome(); }, 90);
    }

    // Find claude's input box + status rows in the bottom screen, surface the counts in
    // the header, and (composer-only) hide the block: grow the crop after a short pause,
    // shrink it slowly, so agent rows coming and going do not resize the pty every frame.
    detectChrome() {
      if (!this.term) return;
      const isClaude = this.info.kind === 'claude' || this.compactOverride;
      const buf = this.term.buffer.active;
      let ch = null;
      if (isClaude && buf.type === 'normal') {
        const lines = [];
        for (let y = 0; y < this.term.rows; y++) {
          const l = buf.getLine(buf.baseY + y);
          lines.push(l ? l.translateToString(true) : '');
        }
        ch = CH.findChrome(lines);
      }
      this.chrome = ch;
      if (isClaude && ch) {
        const sum = CH.summarize(ch.status);
        this.statSum = sum;
        this.statEl.textContent = (CH.label(sum) || sum.mode || 'cli') + (this.peek ? ' (cli shown)' : '');
        this.statEl.title = ch.status.join('\n') + '\n\nClick: ' + (this.peek ? 'hide' : 'show') + ' claude\'s own input box and status rows in this pane';
        this.statEl.style.display = '';
      } else if (!isClaude) {
        this.statEl.style.display = 'none';
      }
      const want = this.compactActive() ? CH.planCrop(ch, this.crop, Math.max(0, Math.min(40, this.term.rows - 4))) : 0;
      this.setCropWant(want);
      this.applyMask();
    }

    setCropWant(want) {
      if (want === this.crop) {
        this.cropWant = want;
        clearTimeout(this.cropTimer);
        this.cropTimer = null;
        return;
      }
      if (want === this.cropWant && this.cropTimer) return;
      this.cropWant = want;
      clearTimeout(this.cropTimer);
      const delay = !this.compactActive() ? 0 : want > this.crop ? 400 : want === 0 ? 300 : 2500;
      this.cropTimer = setTimeout(() => {
        this.cropTimer = null;
        if (this.cropWant === this.crop) return;
        this.crop = this.cropWant;
        this.root.classList.toggle('cropped', this.crop > 0);
        this.doFit();
      }, delay);
    }

    // Cover the block while it floats above the bottom edge (short transcript, or it
    // just grew past the crop), and the partial row the clip edge would show. Only at
    // the live bottom; scrolled up, nothing is masked.
    applyMask() {
      const ch = this.chrome && this.chrome.rows === (this.term && this.term.rows) ? this.chrome : null;
      const buf = this.term && this.term.buffer.active;
      const atBottom = !!buf && buf.viewportY === buf.baseY;
      if (!this.term || !this.compactActive() || !atBottom || (!ch && !this.crop)) {
        this.maskEl.style.display = 'none';
        return;
      }
      const row = ch ? Math.min(ch.start, this.visibleRows) : this.visibleRows;
      const top = this.termEl.offsetTop + (parseFloat(getComputedStyle(this.termEl).paddingTop) || 0) + row * this.cellHeight();
      this.maskEl.style.top = Math.max(0, Math.round(top)) + 'px';
      this.maskEl.style.display = 'block';
    }

    toggleSearch(force) {
      const open = force === undefined ? !this.searchBar.classList.contains('open') : force;
      this.searchBar.classList.toggle('open', open);
      if (open) {
        this.searchInput.focus();
        this.searchInput.select();
      } else {
        this.search.clearDecorations();
        this.focusInput();
      }
      this.scheduleFit();
    }

    connect() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/ws/pane/' + this.id + '?t=' + encodeURIComponent(TOKEN));
      this.ws = ws;
      ws.onopen = () => {
        this.retry = 0;
        this.scheduleFit();
        setTimeout(() => this.wsSend({ t: 'resize', cols: this.term.cols, rows: this.term.rows }), 120);
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.t === 'replay') {
          this.resetInputMarks();
          this.term.reset();
          if (m.d) this.term.write(m.d, () => { this.scheduleScan(); this.scheduleChrome(); });
          if (m.info) this.update(m.info);
        } else if (m.t === 'out') {
          this.lastOut = Date.now();
          this.term.write(m.d, () => { this.scheduleScan(); this.scheduleChrome(); });
        } else if (m.t === 'exit') {
          this.update(Object.assign({}, this.info, { state: 'exited', exitCode: m.code }));
        }
      };
      ws.onclose = (ev) => {
        if (this.closing || ev.code === 4000) return;
        this.retry = Math.min(this.retry + 1, 6);
        setTimeout(() => { if (!this.closing && views.has(this.id)) this.connect(); }, 500 * this.retry);
      };
    }

    wsSend(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    }

    sendRaw(d) {
      this.wsSend({ t: 'in', d });
    }

    // Send text as a typed/pasted prompt, then Enter after a short pause so claude's
    // input box treats the Enter as submit, not as part of a paste.
    // claude panes: the Enter is not fired on a fixed timer alone. claude reads a burst
    // of input as a paste, and an Enter that reaches it while it is still taking the
    // text in (same read, or a slow frame on a busy machine) becomes part of the paste:
    // the prompt then sits unsent in claude's input box - hidden in a composer-only
    // pane - until the next send's Enter submits both. So: wait until the text has
    // landed and output is quiet, send Enter, then check the input box and send Enter
    // again while it still holds text. Sends are queued so two prompts never interleave.
    sendText(text) {
      this.markInput(text);
      const run = () => {
        if (text.includes('\n')) {
          this.term.paste(text); // bracketed paste when the app enabled it
        } else {
          this.sendRaw(text);
        }
        this.lineBuf = ''; // term.paste above echoes through trackTyped; markInput already has it
        if (this.info.kind !== 'claude' && !this.compactOverride) {
          return new Promise((r) => setTimeout(() => { this.sendRaw('\r'); r(); }, 40));
        }
        return this.submitClaude();
      };
      this.sendQueue = (this.sendQueue || Promise.resolve()).then(run, run);
      return this.sendQueue;
    }

    // Text of claude's input box on the live screen ('' empty, null = no box found).
    cliInputText() {
      if (!this.term) return null;
      const buf = this.term.buffer.active;
      if (buf.type !== 'normal') return null;
      const lines = [];
      for (let y = 0; y < this.term.rows; y++) {
        const l = buf.getLine(buf.baseY + y);
        lines.push(l ? l.translateToString(true) : '');
      }
      return CH.inputText(lines, CH.findChrome(lines));
    }

    // Resolve once output has been quiet for `quiet` ms (at least `min` ms from now,
    // at most `max`), or earlier when ready() says so.
    settle(min, quiet, max, ready) {
      const t0 = Date.now();
      return new Promise((resolve) => {
        const tick = () => {
          const now = Date.now();
          const calm = now - (this.lastOut || 0) >= quiet;
          if (now - t0 >= max || (now - t0 >= min && calm && (!ready || ready()))) return resolve();
          setTimeout(tick, 40);
        };
        setTimeout(tick, Math.min(min, 40));
      });
    }

    async submitClaude() {
      // 1. the text has reached claude's box (or a dialog has no box) and output is quiet
      await this.settle(180, 120, 1500, () => this.cliInputText() !== '');
      this.sendRaw('\r');
      // 2. verify: an input box still holding text means the Enter was absorbed
      for (let i = 0; i < 3; i++) {
        await this.settle(450, 200, 2500);
        const t = this.cliInputText();
        if (!t) return; // empty box (sent / queued) or no box (dialog, menu): done
        this.submitRetries = (this.submitRetries || 0) + 1;
        this.sendRaw('\r');
      }
    }

    // ---- operator-input highlighting ----
    // Every line the operator submits (composer, chips, or typed into the terminal and
    // ended with Enter) becomes a needle. After output settles, the live screen and the
    // lines that scrolled past since the last scan are matched against the needles, and
    // a matching line gets an xterm marker + decoration (tinted band, left accent bar).
    // Matching the rendered text, instead of pinning the cursor row at Enter time,
    // survives claude's TUI redraws: a marked line whose text changes loses its mark,
    // and the echo is found wherever claude actually prints it. Needles persist per
    // pane, so a page reload or replay re-marks the scrollback.
    markInput(text) {
      let added = false;
      for (const raw of String(text).split(/\r?\n|\r/)) {
        const n = raw.replace(/\s+/g, ' ').trim();
        if (!n || n.length > 2000) continue;
        const at = this.needles.indexOf(n);
        if (at >= 0) this.needles.splice(at, 1);
        this.needles.push(n);
        added = true;
      }
      if (!added) return;
      if (this.needles.length > NEEDLE_CAP) this.needles = this.needles.slice(-NEEDLE_CAP);
      saveNeedles(this.id, this.needles);
      this.scheduleScan();
    }

    trackTyped(d) {
      if (d.startsWith('\x1b[200~')) {
        this.lineBuf += d.replace(/\x1b\[20[01]~/g, '');
        return;
      }
      if (d.charCodeAt(0) === 0x1b) return; // arrows, function keys: the buffer may drift, accepted
      for (const ch of d) {
        if (ch === '\r') {
          if (this.lineBuf.trim()) this.markInput(this.lineBuf);
          this.lineBuf = '';
        } else if (ch === '\x7f' || ch === '\b') this.lineBuf = this.lineBuf.slice(0, -1);
        else if (ch === '\x03' || ch === '\x15') this.lineBuf = '';
        else if (ch >= ' ') this.lineBuf += ch;
      }
      if (this.lineBuf.length > 8000) this.lineBuf = this.lineBuf.slice(-8000);
    }

    scheduleScan() {
      if (this.scanTimer) return;
      this.scanTimer = setTimeout(() => { this.scanTimer = null; this.scanInputs(); }, 150);
    }

    resetInputMarks() {
      for (const d of this.userDecos.concat(this.doneDecos, this.lineDecos)) { try { d.deco.dispose(); d.marker.dispose(); } catch (e) { /* gone */ } }
      this.userDecos = [];
      this.doneDecos = [];
      this.lineDecos = [];
      this.scanFrom = 0;
    }

    // ---- /done receipt line (CON-6) ----
    // In a claude pane, a line that is exactly DONE_TEXT (after claude's bullet glyph)
    // gets a top-layer decoration over those cells: an opaque cell-sized box (hides the
    // xterm glyphs) carrying the same text, bold, in a shimmering orange gradient.
    doneEnabled() {
      return this.info.kind === 'claude' || this.doneOverride;
    }

    // Cell column where DONE_TEXT starts on this buffer line, or -1.
    doneColumn(line) {
      const t = line.translateToString(true);
      if (!t.includes(DONE_TEXT)) return -1;
      const rest = t.replace(/^[\s\u25cf\u23fa\u2022*]+/, '').replace(/\s+$/, '');
      if (rest !== DONE_TEXT) return -1;
      let str = '';
      const at = [];
      for (let x = 0; x < line.length; x++) {
        const c = line.getCell(x);
        if (!c || c.getWidth() === 0) continue;
        at.push(x);
        str += c.getChars() || ' ';
      }
      const i = str.indexOf(DONE_TEXT);
      return i < 0 ? -1 : at[i];
    }

    addDoneMark(offset, col) {
      const marker = this.term.registerMarker(offset);
      if (!marker) return;
      const deco = this.term.registerDecoration({ marker, x: col, width: DONE_TEXT.length, layer: 'top' });
      if (!deco) { marker.dispose(); return; }
      deco.onRender((e) => {
        e.classList.add('done-line');
        let span = e.firstElementChild;
        if (!span) {
          span = el('span', 'done-text', DONE_TEXT);
          e.appendChild(span);
        }
        const o = this.term.options;
        e.style.fontFamily = o.fontFamily;
        e.style.fontSize = o.fontSize + 'px';
        e.style.lineHeight = e.style.height;
      });
      this.doneDecos.push({ marker, deco, col });
    }

    // A screen line is operator input when, after stripping box borders, it is a prompt
    // glyph (claude '>' or U+276F, a cmd/PowerShell/sh prompt) followed by a needle or
    // the start of a wrapped one, or it directly follows such a line with more of a needle.
    isUserLine(text, prev) {
      const s = text.replace(/\s+/g, ' ').replace(/^[ \u2502|]+/, '').replace(/[ \u2502|]+$/, '');
      if (!s) return false;
      let r = null;
      let m;
      if ((m = /^[>\u276f\u203a] ?(.*)$/.exec(s))) r = m[1];
      else if ((m = /^(?:PS )?[A-Za-z]:\\[^>]*> ?(.*)$/.exec(s))) r = m[1];
      else if ((m = /^\S*[$#] (.*)$/.exec(s))) r = m[1];
      else if (prev) r = s;
      if (r === null) return false;
      r = r.trim();
      if (!r) return false;
      for (let i = this.needles.length - 1; i >= 0; i--) {
        const n = this.needles[i];
        if (n === r || (r.length >= 3 && n.includes(r))) return true;
      }
      return false;
    }

    scanInputs() {
      const wantDone = this.doneEnabled();
      const wantCls = this.info.kind === 'claude' || this.lineOverride;
      if (!this.term || (!this.needles.length && !wantDone && !wantCls)) return;
      const buf = this.term.buffer.active;
      if (buf.type !== 'normal') return;
      const end = buf.length - 1;
      const start = Math.max(0, Math.min(this.scanFrom, buf.baseY, end - this.term.rows * 3));
      this.userDecos = this.userDecos.filter((d) => !d.marker.isDisposed);
      this.doneDecos = this.doneDecos.filter((d) => !d.marker.isDisposed);
      const byLine = new Map();
      for (const d of this.userDecos) byLine.set(d.marker.line, d);
      const doneBy = new Map();
      for (const d of this.doneDecos) doneBy.set(d.marker.line, d);
      this.lineDecos = this.lineDecos.filter((d) => !d.marker.isDisposed);
      const clsBy = new Map();
      for (const d of this.lineDecos) clsBy.set(d.marker.line, d);
      const cursorAbs = buf.baseY + buf.cursorY;
      let prev = false;
      for (let y = start; y <= end; y++) {
        const line = buf.getLine(y);
        if (wantDone) {
          const col = line ? this.doneColumn(line) : -1;
          const dd = doneBy.get(y);
          if (dd && dd.col !== col) {
            try { dd.deco.dispose(); dd.marker.dispose(); } catch (e) { /* gone */ }
            this.doneDecos = this.doneDecos.filter((x) => x !== dd);
          }
          if (col >= 0 && (!dd || dd.col !== col)) this.addDoneMark(y - cursorAbs, col);
        }
        const text = line ? line.translateToString(true) : '';
        const hit = !!line && !!this.needles.length && this.isUserLine(text, prev);
        prev = hit;
        if (wantCls) {
          const cls = hit ? null : CH.classifyLine(text);
          const cd = clsBy.get(y);
          if (cd && cd.cls !== cls) {
            try { cd.deco.dispose(); cd.marker.dispose(); } catch (e) { /* gone */ }
            this.lineDecos = this.lineDecos.filter((x) => x !== cd);
          }
          if (cls && (!cd || cd.cls !== cls)) this.addLineMark(y - cursorAbs, cls);
        }
        if (!this.needles.length) continue;
        const d = byLine.get(y);
        if (hit && !d) this.addInputMark(y - cursorAbs);
        else if (!hit && d) {
          try { d.deco.dispose(); d.marker.dispose(); } catch (e) { /* gone */ }
          this.userDecos = this.userDecos.filter((x) => x !== d);
        }
      }
      this.scanFrom = buf.baseY;
    }

    addLineMark(offset, cls) {
      const marker = this.term.registerMarker(offset);
      if (!marker) return;
      const deco = this.term.registerDecoration({ marker, x: 0, width: 1, layer: 'bottom' });
      if (!deco) { marker.dispose(); return; }
      deco.onRender((e) => e.classList.add('cc-l-' + cls));
      this.lineDecos.push({ marker, deco, cls });
    }

    addInputMark(offset) {
      const marker = this.term.registerMarker(offset);
      if (!marker) return;
      const deco = this.term.registerDecoration({ marker, x: 0, width: this.term.cols, layer: 'bottom' });
      if (!deco) { marker.dispose(); return; }
      deco.onRender((e) => e.classList.add('cc-user-line'));
      this.userDecos.push({ marker, deco });
    }

    sendComposer() {
      const text = this.ta.value.replace(/\r\n/g, '\n');
      if (!text.trim()) {
        this.sendRaw('\r');
      } else {
        this.sendText(text.replace(/\n+$/, ''));
        this.history.unshift(text);
        this.history = this.history.slice(0, 50);
      }
      this.histIdx = -1;
      this.ta.value = '';
      this.slashClose();
      this.attachRow.textContent = '';
      this.ta.style.height = '';
      this.scheduleFit();
      this.ta.focus();
      markSeen(this.id);
    }

    // Enter sends (Ctrl+Enter too); Shift+Enter is a newline. Never while an IME is
    // composing: that Enter commits the composition.
    composerKey(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (this.slashOpen() && this.slashKey(e)) return;
      if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        this.sendComposer();
      } else if (this.compactActive() && this.composerForward(e)) {
        e.preventDefault();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.term.focus();
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (!this.history.length) return;
        this.histIdx = e.key === 'ArrowUp' ? Math.min(this.histIdx + 1, this.history.length - 1) : Math.max(this.histIdx - 1, -1);
        this.ta.value = this.histIdx >= 0 ? this.history[this.histIdx] : '';
      }
    }

    // ---- slash drop-up (CON-5) ----
    // Like the CLI's "/" list: while the composer text starts with "/" and the caret is
    // in that first token, a list of commands (built-ins, project + account commands and
    // skills, from /api/commands) opens above the composer. Prefix matches first, then
    // substring. Up/Down move (wrapping), Tab/Enter fill in "/name " (never send), Esc
    // closes, a click or tap accepts. While it is open those keys stop here; closed,
    // the composer behaves exactly as before. Claude panes only.
    slashEnabled() {
      return this.info.kind === 'claude' || this.slashOverride;
    }

    slashOpen() {
      return this.slashEl.classList.contains('open');
    }

    // The query when the caret sits in a leading "/token", else null.
    slashQuery() {
      const v = this.ta.value;
      if (!v.startsWith('/')) return null;
      const end = v.search(/\s/);
      const tokEnd = end < 0 ? v.length : end;
      const a = this.ta.selectionStart;
      const b = this.ta.selectionEnd;
      if (a !== b || a < 1 || a > tokEnd) return null;
      return v.slice(1, tokEnd);
    }

    slashLoad() {
      if (this.slashRows && Date.now() - this.slashAt < 30000) return Promise.resolve(this.slashRows);
      if (this.slashLoading) return this.slashLoading;
      this.slashLoading = api('GET', '/api/commands?pane=' + encodeURIComponent(this.id))
        .then((r) => { this.slashRows = r.commands || []; this.slashAt = Date.now(); return this.slashRows; })
        .catch(() => this.slashRows || [])
        .finally(() => { this.slashLoading = null; });
      return this.slashLoading;
    }

    slashUpdate() {
      if (!this.slashEnabled()) return;
      const q = this.slashQuery();
      if (q === null) { this.slashClose(); return; }
      this.slashLoad().then((rows) => {
        if (this.slashQuery() !== q) return; // the text moved on while loading
        const lq = q.toLowerCase();
        const pre = [];
        const sub = [];
        for (const r of rows) {
          const n = r.name.toLowerCase();
          if (n.startsWith(lq)) pre.push(r);
          else if (lq && n.includes(lq)) sub.push(r);
        }
        const hits = pre.concat(sub);
        if (!hits.length) { this.slashClose(); return; }
        const keep = this.slashOpen() && this.slashHits[this.slashIdx];
        const ki = keep ? hits.findIndex((h) => h.name === keep.name) : -1;
        this.slashHits = hits;
        this.slashIdx = ki >= 0 ? ki : 0;
        this.slashRender();
      });
    }

    slashRender() {
      this.slashEl.textContent = '';
      this.slashHits.forEach((r, i) => {
        const row = el('div', 'slash-row');
        row.dataset.i = i;
        row.id = this.slashEl.id + '-' + i;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', i === this.slashIdx ? 'true' : 'false');
        if (i === this.slashIdx) row.classList.add('sel');
        row.title = '/' + r.name + (r.description ? ' - ' + r.description : '');
        row.append(el('span', 'slash-name', '/' + r.name), el('span', 'slash-desc', r.description || ''));
        this.slashEl.appendChild(row);
      });
      this.slashEl.classList.add('open');
      this.ta.setAttribute('aria-expanded', 'true');
      this.ta.setAttribute('aria-activedescendant', this.slashEl.id + '-' + this.slashIdx);
      this.slashScroll();
    }

    slashScroll() {
      const row = this.slashEl.children[this.slashIdx];
      if (!row) return;
      const top = row.offsetTop;
      const bot = top + row.offsetHeight;
      if (top < this.slashEl.scrollTop) this.slashEl.scrollTop = top;
      else if (bot > this.slashEl.scrollTop + this.slashEl.clientHeight) this.slashEl.scrollTop = bot - this.slashEl.clientHeight;
    }

    slashMove(d) {
      const n = this.slashHits.length;
      if (!n) return;
      const prev = this.slashEl.children[this.slashIdx];
      if (prev) { prev.classList.remove('sel'); prev.setAttribute('aria-selected', 'false'); }
      this.slashIdx = (this.slashIdx + d + n) % n;
      const row = this.slashEl.children[this.slashIdx];
      if (row) { row.classList.add('sel'); row.setAttribute('aria-selected', 'true'); }
      this.ta.setAttribute('aria-activedescendant', this.slashEl.id + '-' + this.slashIdx);
      this.slashScroll();
    }

    slashAccept(i) {
      const r = this.slashHits[i === undefined ? this.slashIdx : i];
      if (!r) return;
      const v = this.ta.value;
      const end = v.search(/\s/);
      const rest = end < 0 ? '' : v.slice(end).replace(/^[ \t]+/, '');
      const head = '/' + r.name + ' ';
      this.ta.value = head + rest;
      this.slashClose();
      this.ta.focus();
      this.ta.setSelectionRange(head.length, head.length);
      this.growComposer();
    }

    slashClose() {
      if (!this.slashEl) return;
      this.slashEl.classList.remove('open');
      this.slashEl.textContent = '';
      this.slashHits = [];
      this.ta.setAttribute('aria-expanded', 'false');
      this.ta.removeAttribute('aria-activedescendant');
    }

    // Keys while the list is open. True = handled here (composerForward / history never see it).
    slashKey(e) {
      if (e.ctrlKey || e.metaKey) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') this.slashMove(e.key === 'ArrowDown' ? 1 : -1);
      else if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey && !e.altKey) this.slashAccept();
      else if (e.key === 'Escape' && !e.shiftKey && !e.altKey) this.slashClose();
      else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    }

    // Composer-only pane: the composer is the input surface, so the keys claude needs
    // reach it from here. Esc and Shift+Tab always; Enter, Up, Down and Ctrl+C when the
    // composer is empty (otherwise they edit the text as usual).
    composerForward(e) {
      const empty = !this.ta.value;
      const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
      let seq = null;
      if (e.key === 'Escape' && plain && !e.shiftKey) seq = '\x1b';
      else if (e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.altKey) seq = '\x1b[Z';
      else if (empty && plain && !e.shiftKey && e.key === 'Enter') seq = '\r';
      else if (empty && plain && !e.shiftKey && e.key === 'ArrowUp') seq = '\x1b[A';
      else if (empty && plain && !e.shiftKey && e.key === 'ArrowDown') seq = '\x1b[B';
      else if (empty && e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'c' || e.key === 'C')) seq = '\x03';
      if (seq === null) return false;
      this.sendRaw(seq);
      markSeen(this.id);
      return true;
    }

    // Re-apply the composer-only mode (setting changed, peek toggled, pane kind known).
    refreshChromeMode() {
      const on = this.compactActive();
      this.ta.placeholder = on
        ? 'Message claude - Enter sends, Shift+Enter: new line. Empty box: Up/Down, Ctrl+C go to claude; Esc, Shift+Tab always. Alt+Up/Down: history.'
        : 'Prompt composer - Enter sends (empty sends Enter), Shift+Enter: new line. Alt+Up/Down: history. Esc: back to terminal.';
      this.root.classList.toggle('compact-cli', on);
      this.detectChrome();
    }

    // ---- attachments (drop / paste / Attach) ----
    // The browser never sees a dropped file's real path, so each file is uploaded to the
    // console (drops/<day>/), and the saved absolute path goes into the prompt at the
    // cursor. claude reads an image path as an image and any other path as a file.
    insertAtCursor(text) {
      const ta = this.ta;
      const a = ta.selectionStart === undefined ? ta.value.length : ta.selectionStart;
      const b = ta.selectionEnd === undefined ? a : ta.selectionEnd;
      const pre = ta.value.slice(0, a);
      const lead = pre && !/\s$/.test(pre) ? ' ' : '';
      ta.value = pre + lead + text + ta.value.slice(b);
      const at = a + lead.length + text.length;
      ta.setSelectionRange(at, at);
      this.growComposer();
    }

    takeTransfer(dt) {
      const files = dt.files ? [...dt.files] : [];
      if (files.length) return this.attachFiles(files);
      const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))[0];
      const text = uri || dt.getData('text/plain');
      if (text) {
        this.insertAtCursor(text);
        this.ta.focus();
      }
      return Promise.resolve([]);
    }

    attachFiles(files) {
      if (this.composer.classList.contains('collapsed')) this.composer.classList.remove('collapsed');
      return Promise.all(files.map((f) => this.uploadOne(f)));
    }

    addAttachChip(name) {
      const chip = el('span', 'att busy');
      const label = el('span', 'att-name', name);
      const x = el('span', 'x', 'x');
      x.title = 'Remove (also takes the path out of the prompt)';
      chip.append(label, x);
      this.attachRow.appendChild(chip);
      x.addEventListener('click', () => {
        if (chip.inserted) {
          const i = this.ta.value.indexOf(chip.inserted);
          if (i >= 0) this.ta.value = this.ta.value.slice(0, i) + this.ta.value.slice(i + chip.inserted.length).replace(/^ /, '');
        }
        chip.remove();
        this.growComposer();
      });
      this.growComposer();
      return chip;
    }

    async uploadOne(f) {
      const name = f.name || 'pasted.' + ((f.type || '').split('/')[1] || 'bin');
      const chip = this.addAttachChip(name);
      const max = (info && info.uploadMaxBytes) || 50 * 1024 * 1024;
      const fail = (msg) => {
        chip.className = 'att err';
        chip.firstChild.textContent = name + ': ' + msg;
        chip.title = msg;
        return null;
      };
      if (f.size > max) return fail('over the ' + Math.round(max / 1048576) + ' MB cap');
      if (/^image\//.test(f.type || '') && f.size < 8 * 1048576) {
        const rd = new FileReader();
        rd.onload = () => {
          const img = el('img');
          img.src = rd.result;
          img.alt = '';
          chip.insertBefore(img, chip.firstChild);
        };
        rd.readAsDataURL(f);
      }
      try {
        const r = await fetch('/api/upload?name=' + encodeURIComponent(name), {
          method: 'POST',
          headers: { 'X-Console-Token': TOKEN || '', 'Content-Type': 'application/octet-stream' },
          body: f,
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return fail(j.error || 'HTTP ' + r.status);
        const ins = /\s/.test(j.path) ? '"' + j.path + '"' : j.path;
        this.insertAtCursor(ins + ' ');
        chip.inserted = ins + ' ';
        chip.className = 'att';
        chip.title = j.path;
        chip.dataset.path = j.path;
        return j.path;
      } catch (e) {
        return fail(e.message);
      }
    }

    async restart(resume) {
      try {
        const i = await api('POST', '/api/panes/' + this.id + '/restart', { resume: !!resume });
        this.resetInputMarks();
        this.term.reset();
        this.update(i);
        if (!this.ws || this.ws.readyState !== 1) this.connect();
      } catch (e) {
        alert('Restart failed: ' + e.message);
      }
    }

    update(i) {
      const prevUnseen = this.info && this.info.unseen;
      this.info = Object.assign({}, this.info, i);
      const p = this.info;
      this.titleEl.textContent = p.title || p.kind;
      const acct = p.kind === 'claude' ? (info.accounts.find((a) => a.id === p.account) || {}).label || p.account : p.shell;
      this.infoEl.textContent = [p.kind, acct, p.cwd].filter(Boolean).join(' | ');
      // Compact header: the subtitle is a hover tooltip on the title.
      this.titleEl.title = this.infoEl.textContent + '\nDrag the title bar onto another pane to move it, or onto the taskbar to minimize';
      const vs = vstate(p);
      setDot(this.dot, vs, VWORD[vs] + (vs === 'failed' && p.exitCode !== null && p.exitCode !== undefined ? ' (code ' + p.exitCode + ')' : ''));
      this.refreshWord();
      this.menuInfo.textContent = this.infoEl.textContent;
      if (p.kind === 'claude' || this.compactOverride) this.statEl.style.display = '';
      this.root.classList.toggle('st-running', vs === 'running');
      this.root.classList.toggle('st-needs', vs === 'needs');
      this.root.classList.toggle('st-failed', vs === 'failed');
      // CON-UX-CLEAR: /clear (SessionStart source=clear) restarts the pane strip and the
      // project card's rows from that moment, strict: pre-clear files stay out.
      if (p.clearedAt && p.clearedAt !== this.clearSeen) {
        this.clearSeen = p.clearedAt;
        this.flowFromStart = false;
        this.flow = FL.create(p.clearedAt, { strict: true });
        drawFlow(this.flowEl, this.flow);
        this.scheduleFit();
        if (p.projectId) {
          cardFlows.set(p.projectId, FL.create(p.clearedAt, { strict: true }));
          if (statusSnap) setTimeout(renderStatus, 0);
        }
      }
      if (this.flowFromStart && p.startedAt) {
        this.flowFromStart = false;
        if (p.startedAt < this.flow.since) this.flow.since = p.startedAt;
      }
      this.root.classList.toggle('is-exited', p.state === 'exited');
      this.exitText.textContent = 'Process exited' + (p.exitCode !== null && p.exitCode !== undefined ? ' (code ' + p.exitCode + ')' : '') + '.';
      this.resumeBtn.style.display = p.kind === 'claude' && p.sessionId ? '' : 'none';
      const note = p.state === 'attention' && p.note ? p.note : '';
      const dn = p.done || null;
      // DONE closes the session: its workflow rows fold into the band.
      if (dn && dn.kind === 'done' && this.flow.rows.length) {
        this.flow = FL.create(Date.now());
        drawFlow(this.flowEl, this.flow);
      }
      this.noteEl.textContent = note || doneText(dn);
      this.noteEl.className = 'pane-strip' + (note ? ' note' : dn ? ' ' + dn.kind : '');
      this.root.classList.toggle('is-done', !!dn && dn.kind === 'done');
      this.root.classList.toggle('is-failed', !!dn && dn.kind === 'failed');
      const need = settings.idleBadge && p.unseen && p.state === 'attention';
      this.badge.textContent = need ? 'needs you' : '';
      this.badge.classList.toggle('blank', !need);
      if (p.unseen && !prevUnseen) maybeNotify(this);
      renderTaskbar();
      renderProjects();
      updateTitle();
    }

    // Claude panes only: the project's progress items, patched into the fixed rows.
    updateFlow(items) {
      if (this.info.kind !== 'claude' && !this.compactOverride) return;
      const h0 = this.flow.height;
      FL.update(this.flow, items, flowOpts());
      drawFlow(this.flowEl, this.flow);
      if (this.flow.height !== h0) this.scheduleFit();
    }

    destroy() {
      this.closing = true;
      if (this.scanTimer) clearTimeout(this.scanTimer);
      clearTimeout(this.chromeTimer);
      clearTimeout(this.cropTimer);
      clearTimeout(this.fitTimer);
      try { localStorage.removeItem('cc-inputs-' + this.id); } catch (e) { /* ignore */ }
      try { this.ws && this.ws.close(); } catch (e) { /* gone */ }
      try { this.ro.disconnect(); } catch (e) { /* gone */ }
      this.term.dispose();
      this.root.remove();
    }
  }

  // ---------- /done band (UI/UX standard sections 2 and 4) ----------
  // The server validates session_done.json (status, binding, HEAD + hand-off hash,
  // prompt / Stop / tab-title timing) and sends pane.done; the client only draws it.
  function doneText(d) {
    if (!d) return '';
    if (d.kind === 'done') return '[+] DONE S' + d.session + ' - safe to clear';
    return '[x] /done failed: ' + (d.reason || 'failed');
  }
  // Project-row glyph and status card mirror the project's claude panes; a project
  // with no claude pane open shows the marker itself (a CLI session outside the console).
  function projectDone(pid, sp) {
    const mine = [...views.values()].filter((v) => v.info.projectId === pid && v.info.kind === 'claude');
    if (mine.length) {
      const v = mine.find((x) => x.info.done);
      return v ? v.info.done : null;
    }
    const d = sp && sp.done;
    return d ? { kind: d.verdict === 'DONE' ? 'done' : 'failed', session: d.session, reason: d.reason } : null;
  }

  // ---------- pane operations ----------
  async function openPane(req) {
    try {
      const pinfo = await api('POST', '/api/panes', Object.assign({}, req, { client: CLIENT_ID }));
      const v = ensureView(pinfo);
      maximizedId = null;
      setFocused(v.id);
      setTimeout(() => v.focusInput(), 50);
      return v;
    } catch (e) {
      alert('Could not open pane: ' + e.message);
      return null;
    }
  }

  function ensureView(pinfo, saved) {
    let v = views.get(pinfo.id);
    if (v) {
      v.update(pinfo);
      return v;
    }
    v = new PaneView(pinfo, saved);
    views.set(pinfo.id, v);
    if (!order.includes(pinfo.id)) order.push(pinfo.id);
    relayout();
    saveLayout();
    return v;
  }

  function removeView(id) {
    const v = views.get(id);
    if (!v) return;
    v.destroy();
    views.delete(id);
    order = order.filter((x) => x !== id);
    if (maximizedId === id) maximizedId = null;
    if (focusedId === id) focusedId = null;
    relayout();
    saveLayout();
  }

  async function closePane(id) {
    const v = views.get(id);
    if (!v) return;
    if (v.info.state !== 'exited' && !(await askConfirm({ title: 'Close pane', what: 'Close "' + (v.info.title || id) + '"? This ends its process.', safe: 'It stays in the taskbar as a closed chip; a claude pane resumes its session when reopened.', go: 'Close', danger: true }))) return;
    if (!views.has(id)) return; // closed meanwhile (exited and removed while the dialog was up)
    // Keep a dormant entry so the pane can be reopened (claude resumes its session id).
    const entry = v.layoutEntry();
    entry.id = 'd' + Date.now().toString(36);
    entry.minimized = true;
    entry.closedAt = Date.now();
    dormant.unshift(entry);
    dormant = dormant.slice(0, 12);
    try { await api('DELETE', '/api/panes/' + id); } catch (e) { /* already gone */ }
    removeView(id);
  }

  async function reopenDormant(entry, resume) {
    dormant = dormant.filter((d) => d !== entry);
    const req = { kind: entry.kind, projectId: entry.projectId, account: entry.account, shell: entry.shell, title: entry.title };
    if (!entry.projectId) req.cwd = entry.cwd;
    if (resume && entry.kind === 'claude' && entry.sessionId) req.resume = entry.sessionId;
    const v = await openPane(req);
    if (v && entry.fontSize) {
      v.fontSize = entry.fontSize;
      v.applyLook();
    }
    renderTaskbar();
    saveLayout();
  }

  function setMinimized(id, on) {
    const v = views.get(id);
    if (!v) return;
    v.minimized = on;
    if (on && maximizedId === id) maximizedId = null;
    if (!on) setFocused(id);
    relayout();
    saveLayout();
    if (!on) setTimeout(() => v.focusInput(), 80);
  }

  function toggleMax(id) {
    const v = views.get(id);
    if (!v) return;
    v.minimized = false;
    maximizedId = maximizedId === id ? null : id;
    relayout();
    saveLayout();
    setTimeout(() => v.focusInput(), 80);
  }

  // ---------- drag to reorder ----------
  // Panes are dragged by their title bar, minimized chips by themselves. A drop on a
  // pane takes that pane's grid slot; a drop on the taskbar minimizes (before/after the
  // chip under the pointer); a chip dropped on the grid is restored. Order lives in
  // `order`, so the existing layout persistence saves it.
  const DRAG_TYPE = 'application/x-cc-pane';
  let dragId = null;
  let dropHint = null; // { el, cls }

  function setDropHint(target, cls) {
    if (dropHint && dropHint.el === target && dropHint.cls === cls) return;
    clearDropHint();
    if (!target) return;
    target.classList.add(cls);
    dropHint = { el: target, cls };
  }

  function clearDropHint() {
    if (dropHint) dropHint.el.classList.remove(dropHint.cls);
    dropHint = null;
  }

  function startDrag(e, id, srcEl) {
    dragId = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_TYPE, id);
    srcEl.classList.add('dragging');
    document.body.classList.add('dragging-pane');
  }

  function endDrag() {
    dragId = null;
    clearDropHint();
    document.body.classList.remove('dragging-pane');
    for (const x of document.querySelectorAll('.dragging')) x.classList.remove('dragging');
  }

  function isPaneDrag(e) {
    return !!dragId || !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(DRAG_TYPE));
  }

  // A drag carrying files or text from outside (not one of our pane drags).
  function isContentDrag(e) {
    if (isPaneDrag(e) || !e.dataTransfer) return false;
    const ts = Array.from(e.dataTransfer.types || []);
    return ts.includes('Files') || ts.includes('text/plain') || ts.includes('text/uri-list');
  }

  function draggedId(e) {
    return dragId || (e.dataTransfer && e.dataTransfer.getData(DRAG_TYPE)) || null;
  }

  // Move pane `id` next to `targetId` (in front of it, or behind it with `after`; to the
  // end when targetId is null) and set its minimized state, then relayout + refit.
  function movePane(id, targetId, after, minimized) {
    const v = views.get(id);
    if (!v || id === targetId) return;
    order = order.filter((x) => x !== id);
    const i = targetId ? order.indexOf(targetId) : -1;
    if (i < 0) order.push(id);
    else order.splice(after ? i + 1 : i, 0, id);
    v.minimized = minimized;
    if (minimized && maximizedId === id) maximizedId = null;
    if (!minimized && maximizedId && maximizedId !== id) maximizedId = null;
    relayout();
    saveLayout();
    if (!minimized) {
      setFocused(id);
      setTimeout(() => v.focusInput(), 80);
    }
  }

  function paneDragOver(e, targetId) {
    if (!isPaneDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const v = views.get(targetId);
    setDropHint(v && dragId !== targetId ? v.root : null, 'drop-target');
  }

  function paneDrop(e, targetId) {
    if (!isPaneDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = draggedId(e);
    endDrag();
    const v = views.get(id);
    if (!v || id === targetId) return;
    // A grid pane moving forward lands behind the target, so it ends up in the target's slot.
    const after = !v.minimized && order.indexOf(id) < order.indexOf(targetId);
    movePane(id, targetId, after, false);
  }

  // The live chip under the pointer on the taskbar: { el, id, after } or { self: true }.
  function stripTarget(e) {
    const it = e.target.closest && e.target.closest('#tb-items .tb-item[data-id]');
    if (!it) return null;
    if (it.dataset.id === dragId) return { self: true };
    const r = it.getBoundingClientRect();
    return { el: it, id: it.dataset.id, after: e.clientX > r.left + r.width / 2 };
  }

  function wireDrag() {
    const grid = $('#grid');
    grid.addEventListener('dragover', (e) => {
      if (!isPaneDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropHint(grid, 'drop-target');
    });
    grid.addEventListener('drop', (e) => {
      if (!isPaneDrag(e)) return;
      e.preventDefault();
      const id = draggedId(e);
      endDrag();
      if (id) movePane(id, null, false, false);
    });
    const tb = $('#taskbar');
    tb.addEventListener('dragover', (e) => {
      if (!isPaneDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const t = stripTarget(e);
      if (t && t.self) clearDropHint();
      else if (t) setDropHint(t.el, t.after ? 'drop-after' : 'drop-before');
      else setDropHint(tb, 'drop-target');
    });
    tb.addEventListener('drop', (e) => {
      if (!isPaneDrag(e)) return;
      e.preventDefault();
      const id = draggedId(e);
      const t = stripTarget(e);
      endDrag();
      if (!id || (t && t.self)) return;
      movePane(id, t ? t.id : null, t ? t.after : false, true);
    });
    // Leaving the window or cancelling (Esc) clears the indicator.
    document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropHint(); });
    document.addEventListener('dragend', endDrag);
    // A file dropped outside a pane must not navigate the window to it.
    document.addEventListener('dragover', (e) => { if (isContentDrag(e)) e.preventDefault(); });
    document.addEventListener('drop', (e) => { if (isContentDrag(e)) e.preventDefault(); });
  }

  function markSeen(id) {
    const v = views.get(id);
    if (v && v.info.unseen) {
      v.update({ unseen: false });
      v.wsSend({ t: 'seen' });
    }
  }

  function setFocused(id) {
    if (focusedId !== id) {
      focusedId = id;
      for (const v of views.values()) v.root.classList.toggle('focused', v.id === id);
      if (phoneOff.has(id)) relayout();
    }
    markSeen(id);
  }

  // R3: phone width shows one pane (the focused one); the others wait in the taskbar.
  const phoneMq = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
  const isPhone = () => !!(phoneMq && phoneMq.matches);
  let phoneOff = new Set();
  function relayout() {
    const grid = $('#grid');
    let vis = order.filter((id) => views.has(id) && !views.get(id).minimized);
    if (maximizedId && vis.includes(maximizedId)) vis = [maximizedId];
    else maximizedId = null;
    phoneOff = new Set();
    if (isPhone() && vis.length > 1) {
      const keep = vis.includes(focusedId) ? focusedId : vis[0];
      for (const id of vis) if (id !== keep) phoneOff.add(id);
      vis = [keep];
    }
    const n = vis.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.max(1, Math.ceil(n / cols));
    grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    grid.style.gridTemplateRows = 'repeat(' + rows + ', minmax(0, 1fr))';
    for (const id of order) {
      const v = views.get(id);
      if (!v) continue;
      const shown = vis.includes(id);
      v.root.classList.toggle('hidden', !shown);
      v.maxBtn.textContent = maximizedId === id ? 'Restore' : 'Max';
      grid.appendChild(v.root); // keep DOM in order
      if (shown) v.scheduleFit();
    }
    $('#empty').classList.toggle('hidden', n > 0);
    renderTaskbar();
    renderProjects();
  }

  function renderTaskbar() {
    const box = $('#tb-items');
    box.textContent = '';
    for (const id of order) {
      const v = views.get(id);
      if (!v || !(v.minimized || phoneOff.has(id))) continue;
      const off = !v.minimized;
      const it = el('div', 'tb-item' + (off ? ' phone-off' : '') + (v.info.unseen ? ' unseen' : '') + (dragId === id ? ' dragging' : ''));
      it.title = 'Restore ' + v.info.title + ' (drag to reorder, or onto the grid to restore there)';
      it.dataset.id = id;
      it.draggable = true;
      it.addEventListener('dragstart', (e) => startDrag(e, id, it));
      it.addEventListener('dragend', endDrag);
      const d = el('span');
      setDot(d, vstate(v.info));
      it.append(d, el('span', null, v.info.title));
      if (settings.idleBadge && v.info.unseen && v.info.state === 'attention') it.appendChild(el('span', 'badge', 'needs you'));
      it.addEventListener('click', () => { if (off) { setFocused(id); relayout(); } else setMinimized(id, false); });
      box.appendChild(it);
    }
    for (const entry of dormant) {
      const it = el('div', 'tb-item dormant');
      const canResume = entry.kind === 'claude' && entry.sessionId;
      it.title = 'Closed pane. Click to reopen' + (canResume ? ' and resume its conversation; Shift+click opens fresh' : '');
      it.append(el('span', null, 'reopen: ' + (entry.title || entry.kind) + (entry.kind === 'shell' ? ' (shell)' : '')));
      const x = el('span', 'x', 'x');
      x.title = 'Forget';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        dormant = dormant.filter((d2) => d2 !== entry);
        renderTaskbar();
        saveLayout();
      });
      it.appendChild(x);
      it.addEventListener('click', (e) => reopenDormant(entry, canResume && !e.shiftKey));
      box.appendChild(it);
    }
    // Counts only (no sentence swaps): "<n> min / <m> closed", '-' when empty.
    const nMin = order.filter((id) => views.has(id) && views.get(id).minimized).length;
    $('.tb-label').textContent = nMin || dormant.length ? nMin + ' min / ' + dormant.length + ' closed' : '-';
  }

  function updateTitle() {
    let n = 0;
    for (const v of views.values()) if (v.info.unseen) n++;
    document.title = (n ? '(' + n + ') ' : '') + 'Claude Console';
  }

  function maybeNotify(v) {
    if (!settings.desktopNotify || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (!document.hidden && !v.minimized && focusedId === v.id) return;
    try {
      const n = new Notification(v.info.title + ': ' + (v.info.state === 'attention' ? 'needs you' : 'waiting for input'), { body: v.info.note || v.info.cwd || '', tag: 'cc-' + v.id });
      n.onclick = () => { window.focus(); setMinimized(v.id, false); };
    } catch (e) { /* ignore */ }
  }

  // ---------- projects sidebar ----------
  const STATE_RANK = { attention: 0, waiting: 1, busy: 2, starting: 3, exited: 4 };
  // ---------- drag to reorder the Projects list and the status cards ----------
  // Same HTML5 drag model as the panes (one drop hint, cleared on drop/dragend). Each
  // list keeps its own order (settings.projectOrder / settings.cardOrder, saved on the
  // server, so it survives reloads and relaunches); ids not in the order keep their
  // discovery order after the ordered ones.
  const LIST_TYPES = { projects: 'application/x-cc-project', cards: 'application/x-cc-card' };
  let listDrag = null; // { kind, id }
  let listRenderPending = false;

  function orderedBy(items, ids) {
    const rank = new Map((Array.isArray(ids) ? ids : []).map((id, i) => [id, i]));
    return items.map((it, i) => ({ it, i })).sort((a, b) => {
      const ra = rank.has(a.it.id) ? rank.get(a.it.id) : 1e6 + a.i;
      const rb = rank.has(b.it.id) ? rank.get(b.it.id) : 1e6 + b.i;
      return ra - rb;
    }).map((x) => x.it);
  }

  function listIds(kind) {
    const sel = kind === 'projects' ? '#project-list li[data-lid]' : '#status-list .card[data-lid]';
    return [...document.querySelectorAll(sel)].map((e) => e.dataset.lid);
  }

  function reorderList(kind, moved, target, after) {
    const ids = listIds(kind).filter((x) => x !== moved);
    const i = ids.indexOf(target);
    if (i < 0) return;
    ids.splice(after ? i + 1 : i, 0, moved);
    const key = kind === 'projects' ? 'projectOrder' : 'cardOrder';
    settings[key] = ids;
    renderStatus();
    renderProjects();
    saveSettings({ [key]: ids }).catch(() => {});
  }

  function makeListDraggable(node, kind, id) {
    node.draggable = true;
    node.dataset.lid = id;
    node.addEventListener('pointerdown', (e) => { node.dragFromBtn = !!e.target.closest('button'); });
    node.addEventListener('dragstart', (e) => {
      if (node.dragFromBtn) { e.preventDefault(); return; }
      listDrag = { kind, id };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(LIST_TYPES[kind], id);
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => {
      listDrag = null;
      node.classList.remove('dragging');
      clearDropHint();
      if (listRenderPending) {
        listRenderPending = false;
        renderStatus();
        renderProjects();
      }
    });
    node.addEventListener('dragover', (e) => {
      if (!listDrag || listDrag.kind !== kind) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (listDrag.id === id) { clearDropHint(); return; }
      const r = node.getBoundingClientRect();
      setDropHint(node, e.clientY > r.top + r.height / 2 ? 'drop-below' : 'drop-above');
    });
    node.addEventListener('drop', (e) => {
      if (!listDrag || listDrag.kind !== kind) return;
      e.preventDefault();
      e.stopPropagation();
      const moved = listDrag.id;
      const r = node.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      listDrag = null;
      clearDropHint();
      listRenderPending = false;
      if (moved !== id) reorderList(kind, moved, id, after);
    });
  }

  // ---------- project tools (child rows under a project; config/tools.json) ----------
  let tools = [];
  async function loadTools() {
    try { tools = (await api('GET', '/api/tools')).tools || []; } catch (e) { tools = []; }
  }
  function openToolSet() {
    try { return new Set(JSON.parse(prefGet('cc-proj-open', '[]'))); } catch (e) { return new Set(); }
  }
  function toggleToolsOpen(pid) {
    const set = openToolSet();
    if (set.has(pid)) set.delete(pid); else set.add(pid);
    prefSet('cc-proj-open', JSON.stringify([...set]));
    renderProjects();
  }
  // CON-UX-SUBCAT: open sub-categories, '<pid>:<cat>' (per viewer, browser storage)
  function subOpenSet() {
    try { return new Set(JSON.parse(prefGet('cc-sub-open', '[]'))); } catch (e) { return new Set(); }
  }
  function toggleSubOpen(key) {
    const set = subOpenSet();
    if (set.has(key)) set.delete(key); else set.add(key);
    prefSet('cc-sub-open', JSON.stringify([...set]));
    renderProjects();
  }
  async function launchTool(t, row) {
    row.classList.remove('err');
    row.classList.add('busy');
    try {
      await api('POST', '/api/tools/' + t.id + '/launch');
      row.title = (t.title ? t.title + ' - ' : '') + 'started ' + new Date().toLocaleTimeString();
    } catch (e) {
      row.classList.add('err');
      row.title = 'Could not start ' + t.label + ': ' + e.message;
      // A failed start is said out loud, not only in the row tooltip (CON-TOOL-CONSOLE).
      alert('Could not start ' + t.label + ': ' + e.message);
    }
    setTimeout(() => row.classList.remove('busy'), 800);
  }

  // ---------- edit a tool row: Rename / Edit path / Remove (CON-PROJ-EDIT) ----------
  // The row's '...' opens a small menu; each action opens #dlg-tool in its mode. The
  // server validates a path (absolute, exists; a page also takes an http(s) URL) and
  // keeps every change in data/tools.local.json. Remove confirms inside the dialog
  // and only drops the entry from the console; nothing on disk is touched.
  let toolMenuEl = null;
  let toolEdit = null; // { tool, mode }
  function closeToolMenu() {
    if (!toolMenuEl || !toolMenuEl.classList.contains('open')) return;
    toolMenuEl.classList.remove('open');
    const b = document.querySelector('#project-list .t-more[aria-expanded="true"]');
    if (b) b.setAttribute('aria-expanded', 'false');
  }
  function openToolMenu(t, btn) {
    if (!toolMenuEl) {
      toolMenuEl = el('div', 'pmenu tool-menu');
      toolMenuEl.id = 'tool-menu';
      toolMenuEl.setAttribute('role', 'menu');
      toolMenuEl.addEventListener('mousedown', (e) => e.stopPropagation());
      toolMenuEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeToolMenu(); });
      document.body.appendChild(toolMenuEl);
      document.addEventListener('mousedown', (e) => { if (!e.target.closest('#tool-menu, .t-more')) closeToolMenu(); });
      window.addEventListener('resize', closeToolMenu);
      const list = $('#project-list');
      if (list) list.addEventListener('scroll', closeToolMenu);
    }
    const wasFor = toolMenuEl.dataset.tool;
    const wasOpen = toolMenuEl.classList.contains('open');
    closeToolMenu();
    if (wasOpen && wasFor === t.id) return;
    toolMenuEl.textContent = '';
    toolMenuEl.dataset.tool = t.id;
    const item = (label, title, mode) => {
      const b = el('button', 'tm-' + mode, label);
      b.type = 'button';
      b.title = title;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', (e) => { e.stopPropagation(); closeToolMenu(); showToolEdit(t, mode); });
      toolMenuEl.appendChild(b);
    };
    item('Rename', 'Change the name shown in the sidebar', 'rename');
    item('Edit path', t.kind === 'open' ? 'Change the file, folder or URL it opens' : 'Change the program it starts', 'path');
    item('Remove', 'Remove this entry from the console (nothing on disk is touched)', 'remove');
    toolMenuEl.appendChild(el('div', 'pm-info', t.path || ''));
    const r = btn.getBoundingClientRect();
    toolMenuEl.classList.add('open');
    const w = toolMenuEl.offsetWidth;
    const h = toolMenuEl.offsetHeight;
    toolMenuEl.style.left = Math.max(4, Math.min(r.right - w, window.innerWidth - w - 4)) + 'px';
    toolMenuEl.style.top = (r.bottom + h + 4 > window.innerHeight ? Math.max(4, r.top - h - 2) : r.bottom + 2) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    const f = toolMenuEl.querySelector('button');
    if (f) f.focus();
  }
  function showToolEdit(t, mode) {
    toolEdit = { tool: t, mode };
    const dlg = $('#dlg-tool');
    dlg.className = 'mode-' + mode;
    $('#tl-title').textContent = mode === 'rename' ? 'Rename tool' : mode === 'path' ? 'Edit tool path' : 'Remove tool';
    $('#tl-what').textContent = mode === 'remove' ? 'Remove "' + t.label + '" from the console?' : t.label;
    $('#tl-name').value = t.label;
    $('#tl-path').value = t.path || '';
    $('#tl-path-hint').textContent = t.kind === 'open' ? 'Absolute path to a file or folder, or an http(s) URL.' : 'Absolute path to the program (.exe) it starts.';
    $('#tl-note').textContent = '';
    const go = $('#tl-go');
    go.textContent = mode === 'remove' ? 'Remove' : 'Save';
    go.className = mode === 'remove' ? 'danger-solid' : 'primary';
    go.disabled = false;
    dlg.returnValue = '';
    dlg.showModal();
    const focus = mode === 'rename' ? $('#tl-name') : mode === 'path' ? $('#tl-path') : go;
    focus.focus();
    if (focus.select) focus.select();
  }
  // +Tool (CON-TOOL-ADD): the same dialog in 'add' mode - name, path (or URL), optional
  // arguments and start folder, and where it goes (a project, or a group). `pre` =
  // { label, path, target: 'p:<id>' | 'g:<id>', note } prefills it (a drop the server
  // could not place opens it this way). The server validates like Edit path.
  const toolAddQueue = [];
  function showToolAdd(pre) {
    pre = pre || {};
    const dlg = $('#dlg-tool');
    if (dlg.open) { toolAddQueue.push(pre); return; }
    toolEdit = { tool: null, mode: 'add' };
    dlg.className = 'mode-add';
    $('#tl-title').textContent = 'Add tool';
    $('#tl-what').textContent = 'A program, script, shortcut (.lnk), file, folder or web page to start from the Projects list.';
    $('#tl-name').value = pre.label || '';
    $('#tl-path').value = pre.path || '';
    $('#tl-args').value = '';
    $('#tl-cwd').value = '';
    $('#tl-path-hint').textContent = 'Absolute path (for example D:\\folder\\app.exe) or an http(s) URL. Programs and scripts run; anything else opens with its default program.';
    const sel = $('#tl-target');
    sel.textContent = '';
    for (const g of groupsNow()) {
      const o = el('option', null, 'Group: ' + g.name);
      o.value = 'g:' + g.id;
      sel.appendChild(o);
    }
    for (const p of orderedBy(projects, settings && settings.projectOrder)) {
      const o = el('option', null, p.name);
      o.value = 'p:' + p.id;
      sel.appendChild(o);
    }
    if (pre.target && [...sel.options].some((o) => o.value === pre.target)) sel.value = pre.target;
    else if (sel.querySelector('option[value^="p:"]')) sel.value = sel.querySelector('option[value^="p:"]').value;
    $('#tl-note').textContent = pre.note || '';
    const go = $('#tl-go');
    go.textContent = 'Add';
    go.className = 'primary';
    go.disabled = false;
    dlg.returnValue = '';
    dlg.showModal();
    const focus = pre.label && !pre.path ? $('#tl-path') : $('#tl-name');
    focus.focus();
    if (focus.select) focus.select();
  }
  function applyToolResult(r) {
    tools = r.tools || tools;
    if (r.settings) settings = r.settings;
    const tgt = r.projectId;
    if (tgt && !openToolSet().has(tgt)) toggleToolsOpen(tgt);
    renderProjects();
  }
  function targetBody(target) {
    const t = String(target || '');
    return t.startsWith('g:') ? { group: t.slice(2) } : t.startsWith('p:') ? { project: t.slice(2) } : {};
  }
  async function doToolEdit() {
    if (!toolEdit || $('#tl-go').disabled) return;
    const { tool, mode } = toolEdit;
    $('#tl-go').disabled = true;
    $('#tl-note').textContent = '';
    if (mode === 'add') {
      const target = $('#tl-target').value;
      try {
        const r = await api('POST', '/api/tools', Object.assign({ label: $('#tl-name').value, path: $('#tl-path').value, args: $('#tl-args').value, cwd: $('#tl-cwd').value }, targetBody(target)));
        toolEdit = null;
        $('#dlg-tool').close('done');
        applyToolResult(Object.assign({}, r, { projectId: target.startsWith('p:') ? target.slice(2) : null }));
      } catch (e) {
        $('#tl-note').textContent = e.message;
        $('#tl-go').disabled = false;
      }
      return;
    }
    try {
      const r = mode === 'remove'
        ? await api('DELETE', '/api/tools/' + encodeURIComponent(tool.id))
        : await api('PATCH', '/api/tools/' + encodeURIComponent(tool.id), mode === 'rename' ? { label: $('#tl-name').value } : { path: $('#tl-path').value });
      tools = r.tools || tools;
      if (mode === 'remove') { try { settings = await api('GET', '/api/settings'); } catch (e) { /* keep */ } }
      toolEdit = null;
      $('#dlg-tool').close('done');
      renderProjects();
    } catch (e) {
      $('#tl-note').textContent = e.message;
      $('#tl-go').disabled = false;
    }
  }
  function wireToolEdit() {
    $('#tl-go').addEventListener('click', doToolEdit);
    for (const i of [$('#tl-name'), $('#tl-path'), $('#tl-args'), $('#tl-cwd')]) {
      i.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault(); // Enter never submits the form (its first button is Cancel)
        doToolEdit();
      });
      i.addEventListener('input', () => { $('#tl-note').textContent = ''; });
    }
    $('#dlg-tool').addEventListener('close', () => {
      // The close event is a queued task: an Esc close can land AFTER the dialog was
      // reopened for the next action (seen under load, CON-E2E-FLAKY). Then it must
      // not clear the new action's state, or its button silently does nothing.
      if ($('#dlg-tool').open) return;
      toolEdit = null;
      if (toolAddQueue.length) setTimeout(() => showToolAdd(toolAddQueue.shift()), 0);
    });
  }

  // ---------- files dropped from Explorer onto the Projects list (CON-TOOL-ADD) ----------
  // Root cause of "dropping a .lnk does nothing": the rows only took the list's own
  // drags (sideHint needs sideDrag), and the document-level guard swallowed the file
  // drop. Now a project row (or its tool rows), a group header or an empty group takes
  // a drop of any files or folders. The browser gives only the NAME of a dropped file,
  // so a .lnk travels as its bytes (the server resolves it); other names are looked up
  // on the Desktops; file:// and http(s) links carry their own target. What the server
  // cannot place opens the +Tool dialog prefilled with the name.
  function isFileDrag(e) {
    if (sideDrag || !e.dataTransfer) return false;
    const ts = Array.from(e.dataTransfer.types || []);
    return !ts.includes(SIDE_TYPE) && !ts.includes(DRAG_TYPE) && (ts.includes('Files') || ts.includes('text/uri-list'));
  }
  function dropTargetOf(node) {
    if (node.dataset.gid && (node.classList.contains('group-row') || node.classList.contains('group-empty'))) return 'g:' + node.dataset.gid;
    if (node.dataset.lid) return 'p:' + node.dataset.lid;
    if (node.dataset.anchor) return node.dataset.anchor;
    if (node.dataset.gid) return 'g:' + node.dataset.gid;
    return null;
  }
  function b64(buf) {
    const u = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function dropFiles(dt, target) {
    // Read everything synchronously first: the DataTransfer empties after this tick.
    const raw = [];
    for (const it of Array.from(dt.items || [])) {
      if (it.kind !== 'file') continue;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      const f = it.getAsFile();
      if (f) raw.push({ f, dir: !!(entry && entry.isDirectory) });
    }
    if (!raw.length) for (const f of Array.from(dt.files || [])) raw.push({ f, dir: false });
    const links = raw.length ? [] : String(dt.getData('text/uri-list') || '').split(/\r?\n/).filter((l) => l && l[0] !== '#');
    const items = [];
    for (const { f, dir } of raw) {
      const item = { name: f.name, dir };
      if (!dir && /\.lnk$/i.test(f.name) && f.size > 0 && f.size < 131072) {
        try { item.lnk = b64(await f.arrayBuffer()); } catch (e) { /* name lookup instead */ }
      }
      items.push(item);
    }
    for (const l of links.slice(0, 20)) {
      if (/^file:\/\//i.test(l)) {
        try {
          const u = new URL(l);
          const p = decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:)/, '$1').replace(/\//g, '\\');
          items.push({ name: p.split('\\').pop(), path: u.host ? '\\\\' + u.host + p : p });
        } catch (e) { /* skip */ }
      } else if (/^https?:\/\//i.test(l)) items.push({ name: l, url: l });
    }
    if (!items.length) return;
    try {
      const r = await api('POST', '/api/tools/drop', Object.assign({ items }, targetBody(target)));
      applyToolResult(Object.assign({}, r, { projectId: target.startsWith('p:') ? target.slice(2) : null }));
      for (const u of r.unresolved || []) showToolAdd({ label: u.label, target, note: u.error });
    } catch (e) {
      showToolAdd({ label: items[0].name, target, note: e.message });
    }
  }
  function fileDropTarget(node) {
    node.addEventListener('dragover', (e) => {
      if (!isFileDrag(e) || !dropTargetOf(node)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setDropHint(node, 'drop-into');
    });
    node.addEventListener('drop', (e) => {
      if (!isFileDrag(e)) return;
      const target = dropTargetOf(node);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropHint();
      dropFiles(e.dataTransfer, target);
    });
  }

  // ---------- operator groups (settings.sidebarGroups, saved on the server) ----------
  // A group holds projects ('p:<id>') and tools ('t:<id>') in the operator's order; an
  // item in a group leaves its usual place. Groups collapse like projects (+/-).
  function groupsNow() {
    return Array.isArray(settings && settings.sidebarGroups) ? settings.sidebarGroups : [];
  }
  function cloneGroups() {
    return groupsNow().map((g) => Object.assign({}, g, { items: g.items.slice() }));
  }
  function saveGroups(groups, extra) {
    const patch = Object.assign({ sidebarGroups: groups }, extra || {});
    Object.assign(settings, patch);
    renderProjects();
    saveSettings(patch).then(() => renderProjects()).catch(() => {});
  }
  // +Group, Rename and Delete ask inside #dlg-group (CON-DIALOGS), never through the
  // browser's prompt()/confirm(): those block the page and look foreign in the app.
  // CON-CONFIRM: the same dialog in mode 'confirm' replaces every other confirm()
  // (pane close, retired project, Quit). askConfirm resolves true on the go button,
  // false on Cancel / Esc / a dialog already open.
  let groupEdit = null; // { mode: 'add' | 'rename' | 'delete', id } or { mode: 'confirm', resolve }
  const GR_SAFE_DELETE = 'Its projects and tools go back to their usual place. Nothing on disk is touched.';
  function settleConfirm(ok) {
    const ge = groupEdit;
    if (ge && ge.mode === 'confirm' && ge.resolve) { ge.resolve(ok); ge.resolve = null; }
  }
  function askConfirm(o) {
    return new Promise((resolve) => {
      if ($('#dlg-group').open) { resolve(false); return; }
      showGroupDialog('confirm', null, Object.assign({}, o, { resolve }));
    });
  }
  function showGroupDialog(mode, id, ask) {
    const g = id ? groupsNow().find((x) => x.id === id) : null;
    if (mode !== 'add' && mode !== 'confirm' && !g) return;
    const dlg = $('#dlg-group');
    if (dlg.open) return;
    settleConfirm(false); // a confirm whose late close event has not run yet
    groupEdit = mode === 'confirm' ? { mode, resolve: ask.resolve } : { mode, id: g ? g.id : null };
    dlg.className = 'mode-' + mode;
    $('#gr-title').textContent = mode === 'confirm' ? ask.title : mode === 'add' ? 'New group' : mode === 'rename' ? 'Rename group' : 'Delete group';
    $('#gr-what').textContent = mode === 'confirm' ? ask.what : mode === 'add' ? 'Name it, then drag projects or tools onto it.' : mode === 'rename' ? g.name : 'Delete the group "' + g.name + '"?';
    const safe = mode === 'confirm' ? (ask.safe || '') : GR_SAFE_DELETE;
    $('#gr-safe').textContent = safe;
    $('#gr-safe').hidden = !safe;
    $('#gr-name').value = mode === 'rename' ? g.name : '';
    $('#gr-note').textContent = '';
    const go = $('#gr-go');
    go.textContent = mode === 'confirm' ? ask.go : mode === 'add' ? 'Create' : mode === 'rename' ? 'Save' : 'Delete';
    go.className = mode === 'delete' || (mode === 'confirm' && ask.danger) ? 'danger-solid' : 'primary';
    dlg.returnValue = '';
    dlg.showModal();
    const focus = mode === 'delete' || mode === 'confirm' ? go : $('#gr-name');
    focus.focus();
    if (focus.select) focus.select();
  }
  function doGroupEdit() {
    if (!groupEdit) return;
    const { mode, id } = groupEdit;
    if (mode === 'confirm') {
      settleConfirm(true);
      groupEdit = null;
      $('#dlg-group').close('done');
      return;
    }
    const gs = cloneGroups();
    const g = id ? gs.find((x) => x.id === id) : null;
    const name = $('#gr-name').value.replace(/\s+/g, ' ').trim();
    if (mode === 'add') {
      gs.push({ id: 'g-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name || 'Group', open: true, items: [] });
    } else if (!g) {
      $('#gr-note').textContent = 'This group no longer exists.';
      return;
    } else if (mode === 'rename') {
      if (!name) { $('#gr-note').textContent = 'Type a name.'; return; }
      g.name = name;
    }
    groupEdit = null;
    $('#dlg-group').close('done');
    saveGroups(mode === 'delete' ? gs.filter((x) => x.id !== id) : gs);
  }
  function wireGroupEdit() {
    $('#gr-go').addEventListener('click', doGroupEdit);
    $('#gr-name').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Enter never submits the form (its first button is Cancel)
      doGroupEdit();
    });
    $('#gr-name').addEventListener('input', () => { $('#gr-note').textContent = ''; });
    // A late close event (queued task) must not clear a dialog reopened meanwhile.
    $('#dlg-group').addEventListener('close', () => { if ($('#dlg-group').open) return; settleConfirm(false); groupEdit = null; });
  }
  function newGroup() { showGroupDialog('add'); }
  function renameGroup(id) { showGroupDialog('rename', id); }
  function deleteGroup(id) { showGroupDialog('delete', id); }
  function toggleGroup(id) {
    const gs = cloneGroups();
    const g = gs.find((x) => x.id === id);
    if (!g) return;
    g.open = !g.open;
    saveGroups(gs);
  }

  // One drag model for the whole Projects list: projects, tool rows and group headers.
  // Drop on a group header (or an empty group): into that group. Drop on a row inside a
  // group: that place in the group. Drop on an ungrouped row: out of any group (a
  // project also takes that place in projectOrder). Group headers reorder among groups.
  const SIDE_TYPE = 'application/x-cc-side';
  let sideDrag = null;
  function sideHint(node, e) {
    if (!sideDrag || node.dataset.item === sideDrag) return null;
    const header = node.classList.contains('group-row');
    const r = node.getBoundingClientRect();
    const half = e.clientY > r.top + r.height / 2 ? 'drop-below' : 'drop-above';
    if (sideDrag.startsWith('g:')) return header ? half : null;
    if (header || node.classList.contains('group-empty')) return 'drop-into';
    return half;
  }
  function sideDraggable(node, key) {
    node.dataset.item = key;
    node.draggable = true;
    node.addEventListener('pointerdown', (e) => { node.dragFromBtn = !!e.target.closest('button'); });
    node.addEventListener('dragstart', (e) => {
      if (node.dragFromBtn) { e.preventDefault(); return; }
      e.stopPropagation();
      sideDrag = key;
      listDrag = { kind: 'side', id: key };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(SIDE_TYPE, key);
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => {
      sideDrag = null;
      listDrag = null;
      node.classList.remove('dragging');
      clearDropHint();
      if (listRenderPending) {
        listRenderPending = false;
        renderProjects();
      }
    });
    sideDropTarget(node);
  }
  function sideDropTarget(node) {
    fileDropTarget(node);
    node.addEventListener('dragover', (e) => {
      const h = sideHint(node, e);
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropHint(node, h);
    });
    node.addEventListener('drop', (e) => {
      const h = sideHint(node, e);
      if (!h) return;
      e.preventDefault();
      e.stopPropagation();
      const moved = sideDrag;
      sideDrag = null;
      listDrag = null;
      clearDropHint();
      listRenderPending = false;
      applySideDrop(moved, node, h);
    });
  }
  function applySideDrop(moved, node, hint) {
    const gs = cloneGroups();
    const after = hint === 'drop-below';
    const gid = node.dataset.gid || null;
    if (moved.startsWith('g:')) {
      const id = moved.slice(2);
      const g = gs.find((x) => x.id === id);
      const rest = gs.filter((x) => x.id !== id);
      const i = rest.findIndex((x) => x.id === gid);
      if (!g || i < 0) return;
      rest.splice(after ? i + 1 : i, 0, g);
      saveGroups(rest);
      return;
    }
    for (const g of gs) g.items = g.items.filter((x) => x !== moved);
    if (hint === 'drop-into') {
      const g = gs.find((x) => x.id === gid);
      if (!g) return;
      g.items.push(moved);
      g.open = true;
      saveGroups(gs);
      return;
    }
    // a tool row under a project stands for that project's place
    const anchor = node.dataset.anchor || node.dataset.item;
    if (gid) {
      const g = gs.find((x) => x.id === gid);
      if (!g) return;
      const i = g.items.indexOf(anchor);
      g.items.splice(i < 0 ? g.items.length : (after || node.dataset.anchor ? i + 1 : i), 0, moved);
      saveGroups(gs);
      return;
    }
    if (moved.startsWith('p:') && anchor && anchor.startsWith('p:')) {
      const id = moved.slice(2);
      const ids = orderedBy(projects, settings.projectOrder).map((p) => p.id).filter((x) => x !== id);
      const i = ids.indexOf(anchor.slice(2));
      ids.splice(i < 0 ? ids.length : (after || node.dataset.anchor ? i + 1 : i), 0, id);
      saveGroups(gs, { projectOrder: ids });
      return;
    }
    saveGroups(gs); // a tool dropped outside the groups goes back under its project
  }

  function toolRow(t, gid, child) {
    const row = el('li', 'tool-row' + (t.available ? '' : ' missing') + (gid ? ' in-group' : '') + (child ? '' : ' grouped-tool'));
    row.dataset.tool = t.id;
    if (gid) row.dataset.gid = gid;
    if (child && t.projectId) row.dataset.anchor = 'p:' + t.projectId;
    row.appendChild(el('span', 'tool-name', t.label));
    const owner = projects.find((p) => p.id === t.projectId);
    row.title = (t.title ? t.title + '\n' : '') + (owner && !child ? owner.name + ' tool. ' : '') + (t.available ? 'Click: start ' + t.label : 'Not found on this machine (... > Edit path)') + '. Drag into or out of a group.';
    row.addEventListener('click', (e) => { e.stopPropagation(); if (t.available) launchTool(t, row); });
    const act = el('span', 'pact');
    const more = el('button', 'small t-more', '...');
    more.type = 'button';
    more.title = 'Rename, edit path or remove ' + t.label;
    more.setAttribute('aria-haspopup', 'true');
    more.setAttribute('aria-expanded', 'false');
    more.addEventListener('click', (e) => { e.stopPropagation(); openToolMenu(t, more); });
    act.appendChild(more);
    row.appendChild(act);
    sideDraggable(row, 't:' + t.id);
    return row;
  }

  // CON-BOARD-LINK: "Status board" quick link under a project that has one. The
  // server resolves and re-validates the URL and opens it in the default browser
  // (the --app window's own Edge profile is not signed in to claude.ai).
  function boardRow(p, url, gid) {
    const row = el('li', 'tool-row board-row' + (gid ? ' in-group' : ''));
    row.dataset.anchor = 'p:' + p.id;
    row.appendChild(el('span', 'tool-name', 'Status board'));
    row.title = 'Open the ' + p.name + ' status board in the browser\n' + url;
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      row.classList.remove('err');
      row.classList.add('busy');
      try {
        await api('POST', '/api/projects/' + p.id + '/board');
      } catch (x) {
        row.classList.add('err');
        alert('Could not open the ' + p.name + ' status board: ' + x.message);
      }
      setTimeout(() => row.classList.remove('busy'), 800);
    });
    return row;
  }

  // CON-UX-SUBCAT: a sub-category header under an open project: +/- toggle, name, and a
  // one-line summary (local model state, stack head, tool count).
  function subcatRow(p, cat, open, gid, sum) {
    const li = el('li', 'subcat-row' + (open ? ' open' : '') + (gid ? ' in-group' : ''));
    li.dataset.sub = cat;
    li.dataset.anchor = 'p:' + p.id;
    const tg = el('button', 'tool-toggle', open ? '-' : '+');
    tg.type = 'button';
    tg.setAttribute('aria-expanded', open ? 'true' : 'false');
    const key = p.id + ':' + cat;
    tg.addEventListener('click', (e) => { e.stopPropagation(); toggleSubOpen(key); });
    li.append(tg, el('span', 'sub-name', SD.LABEL[cat]), el('span', 'pmeta sub-sum', sum || ''));
    li.title = (open ? 'Hide ' : 'Show ') + p.name + ' ' + SD.LABEL[cat].toLowerCase() + (sum ? '\n' + sum : '');
    li.addEventListener('click', (e) => { e.stopPropagation(); toggleSubOpen(key); });
    return li;
  }


  function renderProjects() {
    const ul = $('#project-list');
    if (!ul) return;
    if (listDrag) { listRenderPending = true; return; } // never rebuild under a drag
    ul.textContent = '';
    const rail = $('#rail-projects');
    if (rail) rail.textContent = '';
    const openSet = openToolSet();
    const gs = groupsNow();
    const placed = new Set();
    for (const g of gs) for (const it of g.items) placed.add(it);
    const byId = new Map(projects.map((p) => [p.id, p]));
    const toolById = new Map(tools.map((t) => [t.id, t]));
    const railRows = [];

    const projectRow = (p, gid) => {
      const li = el('li', (p.retired ? 'retired' : '') + (gid ? ' in-group' : ''));
      const mine = [...views.values()].filter((v) => v.info.projectId === p.id);
      let best = null;
      for (const v of mine) if (!best || STATE_RANK[v.info.state] < STATE_RANK[best.info.state]) best = v;
      const sp = statusSnap && statusSnap.projects.find((x) => x.id === p.id);
      const pd = projectDone(p.id, sp);
      const pvs = pd ? pd.kind : best ? vstate(best.info) : 'idle';
      const dotCls = 'dot v-' + pvs + (pd ? ' is-' + pd.kind : '');
      const dot = el('span', dotCls);
      dot.dataset.g = VGLYPH[pvs];
      dot.title = pd ? doneText(pd) : best ? VWORD[pvs] : 'no pane';
      const name = el('span', 'pname', p.name + (p.retired ? ' (retired)' : ''));
      const meta = el('span', 'pmeta');
      const bits = [];
      if (mine.length) bits.push(mine.length + ' open');
      if (sp && sp.git && sp.git.dirty) bits.push('+' + sp.git.dirty);
      meta.textContent = bits.join(' ');
      const unseen = mine.filter((v) => v.info.unseen).length;
      const kids = tools.filter((t) => t.projectId === p.id && !placed.has('t:' + t.id));
      const board = sp && sp.board ? sp.board : null;
      // CON-UX-SUBCAT: child kinds (pins = local model + chat rows, stack, tools)
      const hv = null; const hasLm = false; const hasChat = false; // no stack / pin rows ship
      const cl = SD.cats({ pins: hasLm || hasChat, stack: !!hv, tools: !!(kids.length || board) });
      const expanded = cl.length > 0 && openSet.has(p.id);
      if (cl.length) {
        const tg = el('button', 'tool-toggle', expanded ? '-' : '+');
        tg.title = (expanded ? 'Hide ' : 'Show ') + p.name + (board ? ' status board link' + (kids.length || hv ? ',' : '') : '') + (kids.length ? ' tools (' + kids.map((t) => t.label).join(', ') + ')' : '') + (hv ? (kids.length ? ' and' : '') + ' stack status' : '') + (hasLm || hasChat ? (kids.length || hv || board ? ',' : '') + ' local model + chat' : '');
        tg.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        tg.addEventListener('click', (e) => { e.stopPropagation(); toggleToolsOpen(p.id); });
        li.appendChild(tg);
      } else {
        li.appendChild(el('span', 'tool-toggle-pad'));
      }
      li.append(dot, name);
      if (unseen && settings.idleBadge) li.appendChild(el('span', 'badge', String(unseen)));
      li.append(meta);
      li.title = p.dir + '\nClick: claude here (focuses an open one). Shift+click: always a new claude pane. Right-click: new pane here (claude or shell). Drag into or out of a group.';
      li.addEventListener('contextmenu', (e) => { e.preventDefault(); showNewDialog(p.id); });
      li.dataset.lid = p.id;
      if (gid) li.dataset.gid = gid;
      sideDraggable(li, 'p:' + p.id);
      const open = async (e) => {
        const shift = e.shiftKey;
        if (p.retired && !(await askConfirm({ title: 'Retired project', what: p.name + ' is retired. Open a claude pane there anyway?', go: 'Open' }))) return;
        const existing = mine.find((v) => v.info.kind === 'claude');
        if (existing && !shift) {
          if (existing.minimized) setMinimized(existing.id, false);
          else setFocused(existing.id);
          existing.focusInput();
          return;
        }
        openPane({ kind: 'claude', projectId: p.id });
        if (isPhone() && !document.body.classList.contains('no-sidebar')) toggleSidebar(true);
      };
      li.addEventListener('click', open);
      ul.appendChild(li);
      // CON-UX-SUBCAT: children only while the project is open; with several kinds,
      // each kind under its own header and only while that header is open.
      const rowsOf = (c) => {
        return (board ? [boardRow(p, board, gid)] : []).concat(kids.map((t) => toolRow(t, gid, true)));
      };
      const subs = new Set([...subOpenSet()].filter((k) => k.startsWith(p.id + ':')).map((k) => k.slice(p.id.length + 1)));
      for (const st of SD.plan(cl, expanded, subs)) {
        if (st.kind === 'head') {
          const sum = (kids.length + (board ? 1 : 0)) + '';
          ul.appendChild(subcatRow(p, st.cat, st.open, gid, sum));
        } else {
          for (const r of rowsOf(st.cat)) {
            if (cl.length > 1) r.classList.add('in-sub');
            ul.appendChild(r);
          }
        }
      }
      // Collapsed sidebar: the rail shows the same status dot per project, dot only.
      const r = el('li', 'rail-proj' + (p.retired ? ' retired' : '') + (unseen && settings.idleBadge ? ' unseen' : ''));
      r.dataset.lid = p.id;
      const rd = el('span', dotCls);
      rd.dataset.g = VGLYPH[pvs];
      r.appendChild(rd);
      // Collapsed rail: the stack rollup rides on the dot only when a service failed.
      r.title = (hv && hv.bad ? hv.head + '\n' : '') + p.name + (p.retired ? ' (retired)' : '') + (pd ? ' - ' + doneText(pd) : best ? ' - ' + VWORD[pvs] : '') + (bits.length ? ' - ' + bits.join(' ') : '') + '\nClick: claude here (focuses an open one). Shift+click: always a new claude pane.';
      r.addEventListener('click', open);
      railRows.push(r);
    };

    for (const g of gs) {
      const members = g.items.filter((it) => (it[0] === 'p' ? byId.has(it.slice(2)) : toolById.has(it.slice(2))));
      const head = el('li', 'group-row' + (g.open ? ' open' : ''));
      head.dataset.gid = g.id;
      const tg = el('button', 'tool-toggle', g.open ? '-' : '+');
      tg.title = (g.open ? 'Collapse' : 'Expand') + ' the group ' + g.name;
      tg.setAttribute('aria-expanded', g.open ? 'true' : 'false');
      tg.addEventListener('click', (e) => { e.stopPropagation(); toggleGroup(g.id); });
      const name = el('span', 'gname', g.name);
      const count = el('span', 'pmeta', String(members.length));
      const act = el('span', 'pact');
      const bRen = el('button', 'small g-rename', 'Rename');
      bRen.title = 'Rename this group';
      bRen.addEventListener('click', (e) => { e.stopPropagation(); renameGroup(g.id); });
      const bDel = el('button', 'small g-delete', 'x');
      bDel.title = 'Delete this group (its projects and tools go back to their usual place)';
      bDel.addEventListener('click', (e) => { e.stopPropagation(); deleteGroup(g.id); });
      act.append(bRen, bDel);
      head.append(tg, name, count, act);
      head.title = 'Group ' + g.name + '. Click: ' + (g.open ? 'collapse' : 'expand') + '. Drag projects or tools onto it; drag the header to reorder groups.';
      head.addEventListener('click', () => toggleGroup(g.id));
      sideDraggable(head, 'g:' + g.id);
      ul.appendChild(head);
      if (g.open) {
        for (const it of members) {
          if (it[0] === 'p') projectRow(byId.get(it.slice(2)), g.id);
          else ul.appendChild(toolRow(toolById.get(it.slice(2)), g.id, false));
        }
        if (!members.length) {
          const empty = el('li', 'group-empty in-group', 'Drag projects or tools here');
          empty.dataset.gid = g.id;
          sideDropTarget(empty);
          ul.appendChild(empty);
        }
      } else {
        // collapsed group: its projects still get rail dots
        const hide = document.createDocumentFragment();
        const keep = ul.lastChild;
        for (const it of members) if (it[0] === 'p') projectRow(byId.get(it.slice(2)), g.id);
        while (ul.lastChild !== keep) hide.prepend(ul.lastChild);
      }
    }
    for (const p of orderedBy(projects, settings && settings.projectOrder)) if (!placed.has('p:' + p.id)) projectRow(p, null);
    // An added tool with no project that is in no group (its group was deleted) stays
    // reachable at the bottom of the list.
    for (const t of tools) {
      if (!t.loose || placed.has('t:' + t.id)) continue;
      const r = toolRow(t, null, false);
      r.classList.add('loose-tool');
      ul.appendChild(r);
    }
    const add = el('li', 'group-add');
    const bAdd = el('button', 'small', '+ Group');
    bAdd.title = 'New group: name it, then drag projects or tools onto it';
    bAdd.addEventListener('click', (e) => { e.stopPropagation(); newGroup(); });
    const bTool = el('button', 'small tool-add', '+ Tool');
    bTool.title = 'Add a tool: a program, script, shortcut, file, folder or web page (or drop files from Explorer onto a project or group)';
    bTool.addEventListener('click', (e) => { e.stopPropagation(); showToolAdd({}); });
    add.append(bAdd, bTool);
    ul.appendChild(add);
    if (rail) for (const r of railRows) rail.appendChild(r);
    const foot = $('#side-foot');
    if (foot && info) {
      // Diagnostic only when something is wrong (declutter, R11); the Settings info
      // line carries the full text. The slot stays, '-' when healthy.
      const bad = [];
      if (!info.claudeFound) bad.push('claude: NOT FOUND');
      if (!info.hooks) bad.push('hooks off');
      foot.textContent = bad.length ? bad.join(' | ') : '-';
    }
  }

  // ---------- status panel ----------
  // ---------- usage strip (CON-USAGE) ----------
  // Lives in the top bar, the same row as the 3-bar sidebar button. Built once with
  // fixed slots; a refresh writes text only, so nothing moves as numbers change.
  // Slot toggles persist on the server (data/usage.local.json); browser storage is
  // only a cache for the first paint.
  let usagePrefs = (() => { try { return Object.assign({}, JSON.parse(prefGet('cc-usage-prefs', '{}'))); } catch (e) { return {}; } })();
  let usageModel = null;
  const usageCells = new Map(); // 'acc1:w7d' -> {pct, left, box}
  function setText(n, t) { if (n.textContent !== t) n.textContent = t; }
  function setCls(n, c) { if (n.className !== c) n.className = c; }

  function buildUsageStrip() {
    const slots = $('#us-slots');
    if (!slots || slots.dataset.built) return;
    slots.dataset.built = '1';
    for (const slot of US.ACCS) {
      const acc = el('span', 'us-slot us-acc');
      acc.dataset.slot = slot;
      acc.appendChild(el('b', 'us-lbl', 'Acc ' + slot.slice(3)));
      for (const w of US.WINS) {
        const box = el('span', 'us-win');
        box.dataset.win = w.key;
        const p = el('span', 'us-pct', US.NA);
        const l = el('span', 'us-left', US.NA);
        box.append(el('i', 'us-wl', w.label), p, el('span', 'us-colon', ': '), l);
        acc.appendChild(box);
        usageCells.set(slot + ':' + w.key, { pct: p, left: l, box });
      }
      slots.appendChild(acc);
    }
    const apiSlot = el('span', 'us-slot us-api');
    apiSlot.dataset.slot = 'api';
    apiSlot.append(el('b', 'us-lbl', 'API'), el('span', 'us-usd', US.NA));
    apiSlot.title = 'API credits balance';
    const ex = el('span', 'us-slot us-extra');
    ex.dataset.slot = 'extra';
    ex.append(el('b', 'us-lbl us-lbl-x', 'Extra Use'), el('span', 'us-usd2', US.NA));
    ex.title = 'Extra Usage spent / limit';
    slots.append(apiSlot, ex);
    const pop = $('#us-pop');
    for (const [k, label] of US.TOGGLES) {
      const lab = el('label', 'check');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.dataset.key = k;
      lab.append(cb, document.createTextNode(' ' + label));
      pop.appendChild(lab);
      cb.addEventListener('change', () => saveUsagePrefs({ [k]: cb.checked }));
    }
  }

  function applyUsagePrefs() {
    const on = (k) => US.isOn(usagePrefs, k);
    for (const n of document.querySelectorAll('#us-slots .us-slot')) n.hidden = !on(n.dataset.slot);
    for (const n of document.querySelectorAll('#us-slots .us-win')) n.hidden = !on(n.dataset.win);
    for (const cb of document.querySelectorAll('#us-pop input[data-key]')) cb.checked = on(cb.dataset.key);
    renderUsage();
    fitUsage();
  }

  async function saveUsagePrefs(patch) {
    usagePrefs = Object.assign({}, usagePrefs, patch);
    prefSet('cc-usage-prefs', JSON.stringify(usagePrefs));
    applyUsagePrefs();
    try {
      const r = await api('PUT', '/api/usage-prefs', { slots: patch });
      usagePrefs = r.slots;
      prefSet('cc-usage-prefs', JSON.stringify(usagePrefs));
    } catch (e) { /* the cache keeps it for this window */ }
  }

  function renderUsage(snap) {
    const s = snap || statusSnap;
    usageModel = US.model(s && s.quota, info && info.accounts, Date.now(), s && s.usage);
    for (const a of usageModel.accs) {
      const box = $('#us-slots .us-acc[data-slot="' + a.slot + '"]');
      if (!box) continue;
      setCls(box, 'us-slot us-acc' + (a.present ? '' : ' us-none') + (a.status ? ' us-st' : ''));
      const t = a.label + (a.present ? '' : ': no quota source') + (a.status ? ' (status ' + a.status + ')' : '');
      if (box.title !== t) box.title = t;
      for (const w of a.wins) {
        const c = usageCells.get(a.slot + ':' + w.key);
        setText(c.pct, w.pct);
        setText(c.left, w.left);
        setCls(c.pct, 'us-pct' + (w.band ? ' us-' + w.band : ''));
        const tt = a.label + ' ' + w.label + ': ' + w.pct + ' used, resets in ' + w.left;
        if (c.box.title !== tt) c.box.title = tt;
      }
    }
    const u = $('#us-slots .us-usd');
    if (u) setText(u, usageModel.api);
    const x = $('#us-slots .us-usd2');
    if (x) setText(x, usageModel.extra);
    const sv = $('#us-summary .us-sum-v');
    if (sv) setText(sv, US.summary(usageModel, usagePrefs));
  }

  // Full strip when it fits beside the top actions, else (and always at phone
  // width) one tappable summary that drops the slots down. Slot widths are fixed by
  // CSS, so this depends on the window width and the toggles, never on the numbers.
  function fitUsage() {
    const strip = $('#usage-strip');
    if (!strip) return;
    strip.classList.remove('compact');
    let compact = phoneMq ? phoneMq.matches : false;
    if (!compact) {
      const bar = $('#topbar');
      const cs = getComputedStyle(bar);
      const gap = parseFloat(cs.columnGap) || 8;
      // four gaps: brand | usage | resource readout | actions. The readout's core
      // (CPU RAM GPU) is reserved first (CON-RES ruling, option C): the usage strip
      // takes its compact summary when it does not fit beside that core; drives and
      // NET then show as room allows.
      const avail = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - $('#topbar .brand-box').offsetWidth - $('#topbar .top-actions').offsetWidth - 4 * gap - resCoreWidth();
      const need = $('#us-slots').scrollWidth + $('#us-gear').offsetWidth + 6;
      compact = need > avail;
    }
    strip.classList.toggle('compact', compact);
    if (!compact) setUsageOpen(false);
    fitRes();
  }

  // ---------- resource readout (CON-RES) ----------
  // CPU RAM GPU C: D: E: F: NET, label + percent only, centred on the app in the
  // top bar. The readout takes only the room the usage strip and the actions leave:
  // too narrow drops items in RS.DROP order (never wraps, never pushes a control);
  // when the exact app centre would collide it sits as near the centre as fits.
  let resSnap = null;
  let resKeys = '';
  function renderRes(snap) {
    const row = $('#res-items');
    if (!row) return;
    resSnap = snap || null;
    const list = RS.items(resSnap);
    const keys = list.map((x) => x.key).join(',');
    if (keys !== resKeys) {
      resKeys = keys;
      row.textContent = '';
      for (const x of list) {
        const el = document.createElement('span');
        el.className = 'res-item';
        el.dataset.k = x.key;
        const l = document.createElement('span');
        l.className = 'res-lbl';
        l.textContent = x.label;
        const v = document.createElement('span');
        v.className = 'res-pct';
        el.append(l, v);
        row.appendChild(el);
      }
    }
    for (const x of list) {
      const el = row.querySelector('.res-item[data-k="' + x.key + '"]');
      if (!el) continue;
      setText(el.lastChild, x.text);
      if (el.dataset.band !== x.band) el.dataset.band = x.band;
      if (el.title !== x.title) el.title = x.title;
    }
    fitRes(); // cheap; also follows top-action changes (e.g. a button shown or hidden)
  }
  function resCoreWidth() {
    const row = $('#res-items');
    if (!row || !row.children.length) return 0;
    for (const e of row.children) e.hidden = !RS.CORE.includes(e.dataset.k);
    return row.offsetWidth + 2 * 12; // breathing room either side of the centred row
  }
  function fitRes() {
    const box = $('#res-strip');
    const row = $('#res-items');
    if (!box || !row) return;
    const els = Array.from(row.children);
    for (const e of els) e.hidden = false;
    row.style.marginLeft = '0px';
    const avail = box.clientWidth;
    for (let i = 0; i < RS.DROP.length && row.offsetWidth > avail; i++) {
      const e = row.querySelector('.res-item[data-k="' + RS.DROP[i] + '"]');
      if (e) e.hidden = true;
    }
    const shown = els.filter((e) => !e.hidden).length;
    box.classList.toggle('res-none', shown === 0 || row.offsetWidth > avail);
    const bar = $('#topbar').getBoundingClientRect();
    const gr = box.getBoundingClientRect();
    const w = row.offsetWidth;
    const want = bar.left + bar.width / 2 - w / 2 - gr.left;
    row.style.marginLeft = Math.round(Math.max(0, Math.min(gr.width - w, want))) + 'px';
  }
  function resOffline() {
    renderRes({ drives: (resSnap && Array.isArray(resSnap.drives) ? resSnap.drives : []).map((d) => ({ letter: d.letter })) });
  }

  function setUsageOpen(open) {
    const strip = $('#usage-strip');
    strip.classList.toggle('open', !!open);
    $('#us-summary').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('#us-slots').style.top = open ? Math.round($('#topbar').getBoundingClientRect().bottom) + 'px' : '';
  }
  function setUsagePop(open) {
    $('#us-pop').hidden = !open;
    $('#us-gear').setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function wireUsage() {
    buildUsageStrip();
    $('#us-gear').addEventListener('click', (e) => { e.stopPropagation(); setUsagePop($('#us-pop').hidden); });
    $('#us-summary').addEventListener('click', (e) => { e.stopPropagation(); setUsageOpen(!$('#usage-strip').classList.contains('open')); });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#us-pop, #us-gear')) setUsagePop(false);
      if (!e.target.closest('#us-slots, #us-summary')) setUsageOpen(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#us-pop').hidden) { setUsagePop(false); $('#us-gear').focus(); }
      setUsageOpen(false);
    });
    window.addEventListener('resize', fitUsage);
    if (phoneMq && phoneMq.addEventListener) phoneMq.addEventListener('change', fitUsage);
    applyUsagePrefs();
    api('GET', '/api/usage-prefs').then((r) => {
      usagePrefs = r.slots || {};
      prefSet('cc-usage-prefs', JSON.stringify(usagePrefs));
      applyUsagePrefs();
    }).catch(() => {});
  }

  const expanded = new Set(JSON.parse((() => { try { return localStorage.getItem('cc-expanded') || '[]'; } catch (e) { return '[]'; } })()));
  const cardFlows = new Map(); // project id -> workflow rows remembered for this page
  const nextOpen = new Set(); // CON-UX-STATUSPANEL: cards whose Next line shows the full block
  const pageStart = Date.now();
  const HL_WORD = { halted: 'halted', backoff: 'backoff', limit: 'limit', refused: 'halted' };

  // Patch a node's children only when the freshly built content differs, so a refresh
  // with nothing new writes nothing (no flicker, scroll never resets).
  function patchChildren(node, fresh) {
    const sig = fresh.map((n) => n.outerHTML).join('');
    if (node.dataset.sig === sig) return false;
    node.dataset.sig = sig;
    node.replaceChildren(...fresh);
    return true;
  }

  // "status stale NNs" only past 15 s; the slot keeps '-' otherwise (no ticker).
  function statusAgeText() {
    if (!statusSnap) return '-';
    const s = Math.round((Date.now() - statusSnap.at) / 1000);
    return s > 15 ? 'status stale ' + s + 's' : '-';
  }

  function cardBody(p, open) {
    const out = [];
    const h = el('h4');
    h.appendChild(el('span', null, (open ? '- ' : '+ ') + p.name));
    if (p.handoff && p.handoff.session !== null && p.handoff.session !== undefined) h.appendChild(el('span', 'muted small', 'S' + p.handoff.session));
    const hl = p.headless;
    // Headless: '*' + lanes while live (its own token); halted / backoff / limit as a
    // word with the '=' glyph (R9), never only "active".
    if (hl && hl.active) {
      const what = hl.lanes.length ? hl.lanes.map((x) => x.lane || 'lane ' + x.index).join(', ') : (hl.task || 'running');
      const mk = el('span', 'hl-mark', '* ' + (hl.lanes.length > 1 ? hl.lanes.length + ' lanes' : 'headless'));
      mk.title = 'Headless run active: ' + what + (hl.runs !== null && hl.cap ? ' (' + hl.runs + '/' + hl.cap + ' runs in 24 h)' : '');
      h.appendChild(mk);
    }
    if (hl && HL_WORD[hl.state]) {
      const w = el('span', 'hl-state ' + (hl.state === 'halted' || hl.state === 'refused' ? 'status-halted' : 'status-warn'), '= ' + HL_WORD[hl.state]);
      w.title = 'Headless state: ' + hl.state + (hl.runs !== null && hl.cap ? ' (' + hl.runs + '/' + hl.cap + ' runs in 24 h)' : '');
      h.appendChild(w);
    }
    const pd = projectDone(p.id, p);
    if (pd) h.appendChild(el('span', 'done-mark ' + pd.kind, pd.kind === 'done' ? '[+] DONE S' + pd.session : '[x] /done failed'));
    h.appendChild(el('span', 'grow'));
    if (p.git) {
      const g = p.git.error ? 'git err' : (p.git.branch || '?') + (p.git.dirty ? ' +' + p.git.dirty : ' clean') + (p.git.ahead ? ' ^' + p.git.ahead : '');
      h.appendChild(el('span', 'muted small', g));
    }
    h.style.cursor = 'pointer';
    out.push(h);
    // Declutter (R11): counts only when non-zero, no ages (they tick).
    // CON-UX-STATUSPANEL: 'inbox M new' (newest kind + subject on hover), no raw names.
    const kv = [];
    const ib = CD.inboxLine(p.inbox);
    if (ib) { const s = el('span', 'kv-inbox', ib.text); s.title = ib.title; kv.push(s); }
    if (p.progress) {
      const running = p.progress.items.filter((x) => x.status === 'running' && !x.stale).length;
      const stale = p.progress.items.filter((x) => x.stale).length;
      if (running) kv.push(running + ' running');
      if (stale) kv.push(stale + ' STALE');
    }
    if (p.handoff) kv.push(p.handoff.file);
    const kvEl = el('div', 'kv');
    kv.forEach((x, i) => { if (i) kvEl.append(' | '); kvEl.append(x); });
    if (!kv.length) kvEl.textContent = '-';
    out.push(kvEl);
    // Workflow rows: same grammar and memory as the pane strip; fixed height.
    let fl = cardFlows.get(p.id);
    if (!fl) { fl = FL.create(pageStart); cardFlows.set(p.id, fl); }
    FL.update(fl, p.progress ? p.progress.items : [], flowOpts());
    const box = el('div', 'flow');
    drawFlow(box, fl);
    out.push(box);
    // CON-UX-STATUSPANEL: one 'Next:' line, ellipsis at the card width; the full block
    // on hover and on click (toggles in place). No next-action block = nothing.
    const nx = open && p.handoff ? CD.nextLine(p.handoff.nextAction) : '';
    if (nx) {
      const full = CD.nextBlock(p.handoff.nextAction).join('\n');
      const n = el('div', 'next' + (nextOpen.has(p.id) ? ' open' : ''), 'Next: ' + (nextOpen.has(p.id) ? full : nx));
      n.title = full + '\n\nClick: ' + (nextOpen.has(p.id) ? 'one line' : 'show the full block');
      n.dataset.pid = p.id;
      out.push(n);
    }
    return out;
  }

  function renderStatus() {
    const s = statusSnap;
    if (!s) return;
    $('#status-age').textContent = statusAgeText();
    // Pane strips follow their project's progress even while a list drag is held.
    for (const v of views.values()) {
      const sp = v.info.projectId && s.projects.find((x) => x.id === v.info.projectId);
      v.updateFlow(sp && sp.progress ? sp.progress.items : []);
      v.setProgress(sp && sp.progress ? sp.progress.items : []);
    }
    renderUsage(s);
    if (listDrag) { listRenderPending = true; return; }

    // Keyed cards: one node per project id, created once; its content is patched only
    // when it changed, and a node moves only when the order changed.
    const list = $('#status-list');
    const have = new Map([...list.children].filter((c) => c.dataset.id).map((c) => [c.dataset.id, c]));
    const want = [];
    for (const p of orderedBy(s.projects, settings.cardOrder)) {
      if (p.self) continue; // the console's own repo is not a fleet tree to watch
      let card = have.get(p.id);
      if (!card) {
        card = el('div', 'card');
        card.dataset.id = p.id;
        makeListDraggable(card, 'cards', p.id);
        card.addEventListener('click', (e) => {
          if (e.target.closest('.next')) {
            if (nextOpen.has(p.id)) nextOpen.delete(p.id);
            else nextOpen.add(p.id);
            renderStatus();
            return;
          }
          if (!e.target.closest('h4')) return;
          if (expanded.has(p.id)) expanded.delete(p.id);
          else expanded.add(p.id);
          try { localStorage.setItem('cc-expanded', JSON.stringify([...expanded])); } catch (e2) { /* ignore */ }
          renderStatus();
        });
      }
      have.delete(p.id);
      const hl = p.headless;
      const cls = 'card' + (p.retired ? ' retired' : '') + (hl && hl.active ? ' headless-active' : '');
      const keep = [...card.classList].filter((c) => c === 'dragging' || c === 'drop-above' || c === 'drop-below');
      const full = [cls].concat(keep).join(' ');
      if (card.className !== full) card.className = full;
      patchChildren(card, cardBody(p, expanded.has(p.id)));
      want.push(card);
    }
    for (const c of have.values()) c.remove();
    want.forEach((c, i) => { if (list.children[i] !== c) list.insertBefore(c, list.children[i] || null); });
    renderProjects();
  }


  async function pollStatus() {
    try {
      statusSnap = await api('GET', '/api/status');
      renderStatus();
    } catch (e) {
      $('#status-age').textContent = 'status error: ' + e.message;
    }
  }

  // ---------- dialogs ----------
  function fillSelect(sel, items, value) {
    sel.textContent = '';
    for (const it of items) {
      const o = el('option', null, it.label);
      o.value = it.id;
      if (it.id === value) o.selected = true;
      sel.appendChild(o);
    }
  }

  // ---------- new-pane folder picker (CON-4) ----------
  // Drive select + subfolder list + breadcrumb over GET /api/fs/drives and
  // /api/fs/list (read-only). Clicking or tapping a folder opens it and makes it the
  // pane's working folder (and clears the project choice); typing a path still works,
  // Enter in the path box browses there. Alt+Up / Up goes to the parent.
  const fp = { path: null, parent: null, seq: 0, drives: [] };

  function fpNote(text, bad) {
    const n = $('#fp-note');
    n.textContent = text || '';
    n.classList.toggle('bad', !!bad);
  }

  function fpRender(res) {
    fp.path = res.path;
    fp.parent = res.parent;
    const drive = res.path.slice(0, 3).toUpperCase();
    if ([...$('#new-drive').options].some((o) => o.value === drive)) $('#new-drive').value = drive;
    const crumbs = $('#fp-crumbs');
    crumbs.textContent = '';
    const parts = res.path.slice(3).split('\\').filter(Boolean);
    let acc = res.path.slice(0, 3);
    const segs = [{ label: acc, path: acc }];
    for (const p of parts) {
      acc = acc.endsWith('\\') ? acc + p : acc + '\\' + p;
      segs.push({ label: p, path: acc });
    }
    segs.forEach((sg, i) => {
      if (i) crumbs.appendChild(el('span', 'fp-sep', '>'));
      const b = el('button', 'fp-crumb small', sg.label);
      b.type = 'button';
      if (i === segs.length - 1) b.setAttribute('aria-current', 'location');
      b.addEventListener('click', () => fpBrowse(sg.path, true));
      crumbs.appendChild(b);
    });
    const list = $('#fp-list');
    list.textContent = '';
    for (const d of res.dirs) {
      const b = el('button', 'fp-dir' + (d.link ? ' link' : ''));
      b.type = 'button';
      b.setAttribute('role', 'listitem');
      b.append(el('span', 'fp-name', d.name));
      if (d.link) b.append(el('span', 'muted small', ' (link)'));
      b.title = res.path.replace(/\\$/, '') + '\\' + d.name;
      b.addEventListener('click', () => fpBrowse(b.title, true));
      list.appendChild(b);
    }
    $('#fp-up').disabled = !res.parent;
    if (res.error) fpNote(res.error, true);
    else if (res.truncated) fpNote('Showing the first ' + res.dirs.length + ' folders.');
    else if (!res.dirs.length) fpNote('No subfolders.');
    else fpNote('');
  }

  // pick = operator navigation: the folder becomes the working folder.
  async function fpBrowse(p, pick) {
    const my = ++fp.seq;
    try {
      const res = await api('GET', '/api/fs/list?path=' + encodeURIComponent(p));
      if (my !== fp.seq) return;
      fpRender(res);
      if (pick) {
        $('#new-cwd').value = res.path;
        $('#new-project').value = '';
      }
    } catch (e) {
      if (my === fp.seq) fpNote(e.message, true);
    }
  }

  async function fpOpen(start) {
    try {
      fp.drives = (await api('GET', '/api/fs/drives')).drives || [];
    } catch (e) {
      fp.drives = [];
    }
    fillSelect($('#new-drive'), fp.drives.map((d) => ({ id: d, label: d })), (start || fp.drives[0] || '').slice(0, 3).toUpperCase());
    if (start || fp.drives.length) await fpBrowse(start || fp.drives[0], false);
  }

  function wireFolderPicker() {
    $('#new-drive').addEventListener('change', () => fpBrowse($('#new-drive').value, true));
    $('#fp-up').addEventListener('click', () => { if (fp.parent) fpBrowse(fp.parent, true); });
    $('#new-cwd').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Enter browses; it never submits (or cancels) the dialog
      const v = $('#new-cwd').value.trim();
      if (v) fpBrowse(v, true);
    });
    $('#new-folder').addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'ArrowUp') {
        e.preventDefault();
        if (fp.parent) fpBrowse(fp.parent, true);
        return;
      }
      const t = e.target;
      if (!t.classList || !t.classList.contains('fp-dir') || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? t.nextElementSibling : t.previousElementSibling;
      if (n) n.focus();
    });
    $('#new-project').addEventListener('change', () => {
      const pr = projects.find((x) => x.id === $('#new-project').value);
      if (pr && pr.dir) {
        $('#new-cwd').value = '';
        fpBrowse(pr.dir, false);
      }
    });
  }

  function showNewDialog(projectId, kind) {
    const dlg = $('#dlg-new');
    fillSelect($('#new-project'), [{ id: '', label: '(none - console folder)' }].concat(projects.map((p) => ({ id: p.id, label: p.name + (p.retired ? ' (retired)' : '') }))), projectId || '');
    $('#new-cwd').value = '';
    fpNote('');
    const pr = projectId ? projects.find((x) => x.id === projectId) : null;
    fpOpen(pr && pr.dir ? pr.dir : null);
    fillSelect($('#new-account'), info.accounts, settings.defaultAccount);
    fillSelect($('#new-shell'), info.shells, settings.defaultShell);
    $('#new-kind').value = kind || 'claude';
    $('#new-args').value = '';
    dlg.className = 'kind-' + $('#new-kind').value;
    dlg.returnValue = '';
    dlg.showModal();
  }

  // ---------- remove a project listing (CON-7) ----------
  // Settings lists every project with a Remove action. The confirm dialog keeps its
  // Remove button disabled until the exact phrase is typed; the server hides the
  // listing (data/console.local.json) and never touches the folder. Live panes block it.
  const RM_PHRASE = 'DELETE PROJECT';
  let rmTarget = null;

  function livePanesOf(pid) {
    return [...views.values()].filter((v) => v.info.projectId === pid).length;
  }

  function renderSettingsProjects() {
    const ul = $('#set-projects');
    ul.textContent = '';
    for (const p of projects) {
      const li = el('li');
      li.dataset.pid = p.id;
      const txt = el('span', 'sp-text');
      txt.append(el('span', 'sp-name', p.name + (p.retired ? ' (retired)' : '')), el('span', 'sp-dir muted small', p.dir));
      const b = el('button', 'small danger', 'Remove');
      b.type = 'button';
      b.title = 'Remove ' + p.name + ' from the console (files on disk are not touched)';
      b.addEventListener('click', () => showRemove(p));
      li.append(txt, b);
      ul.appendChild(li);
    }
  }

  function rmSync() {
    const live = rmTarget ? livePanesOf(rmTarget.id) : 0;
    const ok = $('#rm-phrase').value === RM_PHRASE;
    $('#rm-go').disabled = !ok || live > 0 || !rmTarget;
  }

  function showRemove(p) {
    rmTarget = p;
    $('#rm-what').textContent = 'Remove "' + p.name + '" (' + p.dir + ') from the console?';
    $('#rm-phrase').value = '';
    const live = livePanesOf(p.id);
    $('#rm-note').textContent = live ? 'It has ' + live + ' open pane' + (live === 1 ? '' : 's') + '. Close ' + (live === 1 ? 'it' : 'them') + ' first.' : '';
    rmSync();
    $('#dlg-remove').returnValue = '';
    $('#dlg-remove').showModal();
    $('#rm-phrase').focus();
  }

  async function doRemove() {
    rmSync();
    if ($('#rm-go').disabled || !rmTarget) return;
    $('#rm-go').disabled = true;
    try {
      const r = await api('DELETE', '/api/projects/' + encodeURIComponent(rmTarget.id));
      projects = r.projects || projects.filter((x) => x.id !== rmTarget.id);
      try { settings = await api('GET', '/api/settings'); } catch (e) { /* keep */ }
      rmTarget = null;
      $('#dlg-remove').close('done');
      renderProjects();
      renderSettingsProjects();
      pollStatus();
    } catch (e) {
      $('#rm-note').textContent = e.message;
      rmSync();
    }
  }

  function wireRemove() {
    $('#rm-phrase').addEventListener('input', rmSync);
    $('#rm-phrase').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // Enter never submits the form (its first button is Cancel)
      doRemove();
    });
    $('#rm-go').addEventListener('click', doRemove);
    $('#dlg-remove').addEventListener('close', () => { if ($('#dlg-remove').open) return; rmTarget = null; $('#rm-phrase').value = ''; });
  }

  function showSettings() {
    renderSettingsProjects();
    const f = $('#form-settings');
    fillSelect($('#set-account'), info.accounts, settings.defaultAccount);
    // v19.1 B: unset headless = preselect the proxy account (split as designed); nothing
    // is applied until the operator changes a pick and saves.
    const hl = settings.headlessAccount || (info.accounts.find((a) => a.headlessProxy) || info.accounts.find((a) => a.id !== settings.defaultAccount) || info.accounts[0] || {}).id;
    fillSelect($('#set-headless'), info.accounts, hl);
    acctDirty = false;
    refreshRouteLine(null);
    api('GET', '/api/route').then(refreshRouteLine).catch(() => {});
    api('GET', '/api/health').then((h) => { healthSnap = h; $('#health-last').textContent = HL.lastLine(h.running || h.last); }).catch(() => { $('#health-last').textContent = 'Health check unavailable.'; });
    loadHealthSched();
    fillSelect($('#set-shell'), info.shells, settings.defaultShell);
    f.theme.value = settings.theme === 'light' || settings.theme === 'dark' ? settings.theme : 'system';
    f.fontSize.value = settings.fontSize;
    fillTypeForm(settings.typeScale);
    const fo = FL.normalizeOpts(settings);
    f.flowRows.value = fo.cap;
    for (const st of FL.STATES) f.elements['fs-' + st].checked = fo.show[st];
    f.fontFamily.value = settings.fontFamily;
    f.lineHeight.value = settings.lineHeight;
    f.scrollback.value = settings.scrollback;
    const ks = KY.normalizeStrip(settings.keyStrip);
    for (const k of KY.KEYS) f.elements['key-' + k.id].checked = ks[k.id];
    fillChipList(KY.normalizeChips(settings.quickChips));
    f.idleBadge.checked = !!settings.idleBadge;
    f.desktopNotify.checked = !!settings.desktopNotify;
    f.hideCliChrome.checked = hideCliChrome;
    $('#settings-info').textContent = 'claude: ' + (info.claudePath || 'not found') + ' | server pid ' + info.pid + ' | v' + info.version;
    refreshUpdates();
    $('#dlg-settings').returnValue = '';
    $('#dlg-settings').showModal();
  }

  // CON-UX-KEYS: Settings > Quick chips as a list - tick to show, edit the text,
  // Remove, + Add chip (12 at most). Saved with the dialog.
  function chipRow(c) {
    const li = el('li');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = c.on;
    cb.title = 'Show this chip under the panes';
    const tx = el('input', 'chip-text');
    tx.value = c.text;
    tx.maxLength = 200;
    tx.setAttribute('aria-label', 'Chip text');
    tx.spellcheck = false;
    const rm = el('button', 'small danger', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', () => { li.remove(); chipAddSync(); });
    li.append(cb, tx, rm);
    return li;
  }
  function chipAddSync() { $('#chip-add').disabled = $('#set-chips').children.length >= 12; }
  function fillChipList(chips) {
    const ul = $('#set-chips');
    ul.textContent = '';
    for (const c of chips) ul.appendChild(chipRow(c));
    chipAddSync();
  }
  function readChipList() {
    return KY.normalizeChips([...$('#set-chips').children].map((li) => ({ text: li.querySelector('.chip-text').value, on: li.querySelector('input[type=checkbox]').checked })));
  }
  function wireChipList() {
    $('#chip-add').addEventListener('click', () => {
      if ($('#set-chips').children.length >= 12) return;
      const li = chipRow({ text: '', on: true });
      $('#set-chips').appendChild(li);
      chipAddSync();
      li.querySelector('.chip-text').focus();
    });
    // Enter in a chip field never submits the Settings form
    $('#set-chips').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  }

  // CON-UX-TYPESCALE: Settings > Text size. Edits preview live; Save stores them,
  // Cancel puts the saved scale back.
  function fillTypeForm(scale) {
    const f = $('#form-settings');
    const s = TY.normalize(scale);
    f.elements['ts-base'].value = s.base;
    for (const lv of TY.LEVELS) f.elements['ts-' + lv].value = s[lv];
  }
  function readTypeForm() {
    const f = $('#form-settings');
    const v = (n) => { const x = parseFloat(f.elements[n].value); return Number.isFinite(x) ? x : null; };
    const out = { base: v('ts-base') };
    for (const lv of TY.LEVELS) out[lv] = v('ts-' + lv);
    return TY.normalize(out);
  }
  function wireTypeForm() {
    $('#set-type').addEventListener('input', () => applyTypeScale(readTypeForm()));
    $('#ts-reset').addEventListener('click', () => { fillTypeForm(TY.DEFAULTS); applyTypeScale(TY.DEFAULTS); });
    $('#dlg-settings').addEventListener('close', () => { if ($('#dlg-settings').returnValue !== 'ok') applyTypeScale(settings.typeScale); });
  }

  function setHideCliChrome(on) {
    hideCliChrome = !!on;
    prefSet('cc-cli-chrome', hideCliChrome ? 'hide' : 'show');
    for (const v of views.values()) v.refreshChromeMode();
  }

  function wireDialogs() {
    wireFolderPicker();
    wireRemove();
    wireToolEdit();
    wireGroupEdit();
    wireTypeForm();
    wireChipList();
    $('#new-kind').addEventListener('change', () => { $('#dlg-new').className = 'kind-' + $('#new-kind').value; });
    $('#dlg-new').addEventListener('close', () => {
      if ($('#dlg-new').returnValue !== 'ok') return;
      const pid = $('#new-project').value;
      const kind = $('#new-kind').value;
      const req = { kind, args: splitArgs($('#new-args').value) };
      const cwd = $('#new-cwd').value.trim();
      if (pid) req.projectId = pid;
      else if (cwd) req.cwd = cwd;
      if (kind === 'claude') req.account = $('#new-account').value;
      else req.shell = $('#new-shell').value;
      openPane(req);
    });
    $('#dlg-settings').addEventListener('close', async () => {
      if ($('#dlg-settings').returnValue !== 'ok') return;
      const f = $('#form-settings');
      const patch = {
        theme: f.theme.value,
        fontSize: Math.max(9, Math.min(40, parseInt(f.fontSize.value, 10) || 16)),
        typeScale: readTypeForm(),
        flowRows: Math.max(0, Math.min(12, parseInt(f.flowRows.value, 10) || 0)),
        flowStates: Object.fromEntries(FL.STATES.map((st) => [st, f.elements['fs-' + st].checked])),
        fontFamily: f.fontFamily.value || settings.fontFamily,
        lineHeight: Math.max(1, Math.min(2, parseFloat(f.lineHeight.value) || 1.2)),
        scrollback: Math.max(1000, Math.min(100000, parseInt(f.scrollback.value, 10) || 10000)),
        defaultAccount: f.defaultAccount.value,
        headlessAccount: acctDirty || settings.headlessAccount ? f.headlessAccount.value || null : null,
        defaultShell: f.defaultShell.value,
        keyStrip: Object.fromEntries(KY.KEYS.map((k) => [k.id, f.elements['key-' + k.id].checked])),
        quickChips: readChipList(),
        idleBadge: f.idleBadge.checked,
        desktopNotify: f.desktopNotify.checked,
      };
      if (f.hideCliChrome.checked !== hideCliChrome) setHideCliChrome(f.hideCliChrome.checked);
      if (patch.desktopNotify && 'Notification' in window && Notification.permission === 'default') {
        try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
      }
      const changed = acctDirty;
      await saveSettings(patch);
      for (const v of views.values()) v.term.options.scrollback = settings.scrollback;
      // CON-UX-PANEROWS: pane strips and card rows follow a new count / state set now
      if (statusSnap) renderStatus();
      else renderProjects();
      // v19.1 B: only an account pick the operator CHANGED in this dialog is applied,
      // through the kit's own CLI (server side, plugin only); a font change never is.
      if (changed) api('POST', '/api/route', {}).then((r) => { lastRoute = r; }).catch(() => {});
    });
    wireHealth();
    wireHealthSched();
    wireSched();
    wireWatch();
  }

  // ---------- v19.1 B: headless route line ----------
  let lastRoute = null;
  let acctDirty = false;
  const acctLabel = (id) => { const a = ((info && info.accounts) || []).find((x) => x.id === id); return a ? a.label : ''; };
  function refreshRouteLine(r) {
    if (r) lastRoute = r;
    const f = $('#form-settings');
    const proxy = ((info && info.accounts) || []).find((a) => a.headlessProxy);
    $('#set-route').textContent = HL.routeText(r || lastRoute, acctLabel(f.defaultAccount.value), acctLabel(f.headlessAccount.value), proxy ? proxy.label : '');
  }

  // ---------- v19.1 A: Health & cleanup ----------
  let healthSnap = null;
  let healthTicked = null;
  let healthTimer = null;
  function healthRun() { return healthSnap && healthSnap.running ? healthSnap.running : null; }
  function renderHealth() {
    const box = $('#hc-steps');
    box.textContent = '';
    const run = healthRun();
    const steps = (healthSnap && healthSnap.steps) || [];
    if (!healthTicked) healthTicked = new Set(steps.filter((s) => s.default).map((s) => s.id));
    const now = Date.now();
    let group = null;
    if (run) {
      for (const s of run.steps) {
        if (s.group !== group) { group = s.group; box.appendChild(el('h4', 'hc-group', group)); }
        const row = el('div', 'hc-row hc-' + s.status);
        row.dataset.step = s.id;
        row.appendChild(el('span', 'hc-label', s.label));
        row.appendChild(el('span', 'hc-state small', s.status === 'running' ? 'running, ' + fmtEta(Math.max(0, (s.eta_s || 0) - (now - s.startedAt) / 1000)) : s.status));
        const bar = el('div', 'hc-bar');
        const fill = el('i');
        fill.style.width = HL.stepPct(s, now) + '%';
        bar.appendChild(fill);
        row.appendChild(bar);
        box.appendChild(row);
      }
      $('#hc-total').textContent = 'Running: ' + HL.runPct(run, now) + '% overall.';
      $('#hc-go').disabled = true;
      $('#hc-report').hidden = true;
      return;
    }
    for (const s of steps) {
      if (s.group !== group) { group = s.group; box.appendChild(el('h4', 'hc-group', group)); }
      const lab = el('label', 'check hc-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.dataset.step = s.id;
      cb.checked = healthTicked.has(s.id);
      cb.addEventListener('change', () => { if (cb.checked) healthTicked.add(s.id); else healthTicked.delete(s.id); renderHealthTotal(); });
      lab.appendChild(cb);
      const txt = el('span', 'hc-text');
      txt.appendChild(el('span', 'hc-label', s.label));
      txt.appendChild(el('span', 'hc-meta small muted', fmtEta(s.eta_s) + ' | ' + HL.costText(s)));
      if (s.deletes) txt.appendChild(el('span', 'hc-del small', 'Deletes: ' + s.deletes));
      lab.appendChild(txt);
      box.appendChild(lab);
    }
    renderHealthTotal();
    renderHealthReport(healthSnap && healthSnap.last);
  }
  function renderHealthTotal() {
    const t = HL.totals((healthSnap && healthSnap.steps) || [], healthTicked || new Set());
    $('#hc-total').textContent = t.count + ' step' + (t.count === 1 ? '' : 's') + ', ' + (fmtEta(t.eta) || '~0s') + ', ' + t.cost + (t.deletes ? ', ' + t.deletes + ' with deletes' : ', nothing deleted') + '.';
    $('#hc-go').disabled = !t.count;
  }
  function renderHealthReport(run) {
    const box = $('#hc-report');
    box.textContent = '';
    if (!run || !run.endedAt) { box.hidden = true; return; }
    box.hidden = false;
    box.appendChild(el('h4', null, HL.lastLine(run)));
    for (const s of run.steps || []) {
      const r = s.result || {};
      const row = el('div', 'hc-res hc-' + s.status);
      row.appendChild(el('b', null, (s.status === 'done' ? '+ ' : 'x ') + s.label + ': '));
      row.appendChild(el('span', null, r.summary || s.status));
      for (const f of r.findings || []) row.appendChild(el('div', 'hc-find small', '- ' + f));
      box.appendChild(row);
    }
    if (run.reportFile) box.appendChild(el('p', 'small muted', 'Saved: ' + String(run.reportFile).split(/[\\/]/).slice(-3).join('/')));
  }
  function healthTick() {
    clearInterval(healthTimer);
    healthTimer = null;
    if (healthRun() && $('#dlg-health').open) {
      healthTimer = setInterval(() => {
        if (!healthRun() || !$('#dlg-health').open) { clearInterval(healthTimer); healthTimer = null; return; }
        renderHealth();
      }, 1000);
    }
  }
  function onHealthEvent(st) {
    if (!healthSnap) healthSnap = { steps: [] };
    const wasRunning = !!healthSnap.running;
    healthSnap.running = st.running || null;
    healthSnap.last = st.last || healthSnap.last;
    if (wasRunning && !st.running) healthTicked = null;
    if ($('#health-last')) $('#health-last').textContent = HL.lastLine(st.running || st.last);
    if ($('#dlg-health').open) { renderHealth(); healthTick(); }
  }
  async function showHealth() {
    $('#hc-note').textContent = '';
    try { healthSnap = await api('GET', '/api/health'); } catch (e) { $('#hc-note').textContent = 'Health check unavailable: ' + e.message; healthSnap = { steps: [] }; }
    healthTicked = null;
    renderHealth();
    loadHealthSched();
    if (!$('#dlg-health').open) $('#dlg-health').showModal();
    healthTick();
  }
  // ---------- CON-PUBLIC D/E/F: Settings > Updates & repair (server/updates.js) ----------
  function updLine(s) {
    if (!s) return '';
    if (s.mode === 'checkout') return 'v' + s.version + ' (running from a checkout; it updates through git)';
    const c = s.lastCheck;
    const a = s.auto || {};
    const avail = c && c.available ? c.latest.version : a.available;
    return 'v' + s.installed.version + ' ' + s.installed.channel + (avail ? ' | update available v' + avail : c && c.checked ? ' | up to date' : c ? ' | no check: ' + c.reason : '') +
      (a.review ? ' | v' + a.review.version + ' needs review: ' + a.review.conflicts.length + ' conflicting file(s)' : '') + (a.pendingRestart ? ' | v' + a.pendingRestart + ' installed, restart pending' : '');
  }
  // MERGE-CON G5: the header badge; hidden while updates.repo is unset (UP.badge -> null).
  function renderUpdBadge(s) {
    const b = $('#upd-badge');
    const v = UP.badge(s);
    b.hidden = !v;
    if (v) { b.textContent = v.text; b.title = v.title; }
  }
  async function refreshUpdates() {
    try {
      const s = await api('GET', '/api/updates');
      renderUpdBadge(s);
      $('#upd-state').textContent = updLine(s);
      const u = s.lastUpdate;
      $('#upd-last').textContent = u ? 'Last update v' + u.from + ' -> v' + u.to + ': ' + u.status + (u.localMods && u.localMods.length ? ', ' + u.localMods.length + ' local mods kept' : '') : 'No update run yet.';
      $('#upd-auto').checked = !!s.settings.auto;
      const inst = s.mode === 'installed';
      for (const id of ['#btn-upd-apply', '#btn-upd-repair', '#btn-upd-contrib', '#upd-auto']) $(id).disabled = !inst;
    } catch (e) {
      $('#upd-state').textContent = 'Updates: ' + e.message;
    }
  }
  function wireUpdates() {
    $('#upd-badge').addEventListener('click', () => {
      showSettings();
      const f = $('#set-updates');
      if (f && f.scrollIntoView) f.scrollIntoView({ block: 'center' });
    });
    refreshUpdates();
    setInterval(refreshUpdates, 3600000);
    $('#btn-upd-check').addEventListener('click', async () => {
      $('#upd-state').textContent = 'Checking...';
      await api('POST', '/api/updates/check', {}).catch(() => {});
      refreshUpdates();
    });
    $('#btn-upd-apply').addEventListener('click', async () => {
      // CON-CONFIRM: the console's own dialog, never a native confirm()
      if (!(await askConfirm({ title: 'Update now', what: 'Download, verify and apply the update now?', safe: 'Local changes are merged and backed up. The new version runs after the next console restart.', go: 'Update' }))) return;
      $('#upd-state').textContent = 'Updating...';
      const r = await api('POST', '/api/updates/apply', {}).catch((e) => ({ error: e.message }));
      $('#upd-state').textContent = r.error || ('Update: ' + r.status + (r.restartNeeded ? (r.panesBusy ? ' - restart when the ' + r.panesBusy + ' busy pane(s) finish' : ' - restart the console to use it') : ''));
    });
    $('#btn-upd-repair').addEventListener('click', async () => {
      const pf = await api('GET', '/api/updates/preflight').catch((e) => ({ error: e.message }));
      if (pf.error) { $('#upd-state').textContent = pf.error; return; }
      // CON-CONFIRM: the typed confirmation is an inline field, never a native prompt()
      $('#upd-repair-what').textContent = 'Repair v' + pf.version + ': restores ' + pf.absent.length + ' missing file(s); keeps ' + pf.tweaks.length + ' local tweak(s). Kept: ' + pf.keep.join(', ') + '. Cannot: ' + pf.cannot.join('; ') + '. Type "' + pf.confirmPhrase + '" to go ahead.';
      $('#upd-repair-phrase').value = '';
      $('#upd-repair-row').hidden = false;
      $('#upd-repair-phrase').focus();
    });
    $('#btn-upd-repair-go').addEventListener('click', async () => {
      const typed = $('#upd-repair-phrase').value;
      $('#upd-repair-row').hidden = true;
      const r = await api('POST', '/api/updates/reinstall', { mode: 'repair', confirm: typed }).catch((e) => ({ error: e.message }));
      $('#upd-state').textContent = r.error || ('Repair: ' + r.status + (r.reason ? ' - ' + r.reason : ''));
    });
    $('#btn-upd-contrib').addEventListener('click', async () => {
      const r = await api('POST', '/api/updates/contribute', {}).catch((e) => ({ error: e.message }));
      $('#upd-last').textContent = r.error || ('Patch ' + r.file + ' (' + r.count + ' files, scrubbed) saved in reports/. Nothing was sent.');
    });
    $('#upd-auto').addEventListener('change', async (ev) => {
      await api('POST', '/api/updates/settings', { auto: ev.target.checked }).catch(() => {});
      refreshUpdates();
    });
  }
  function wireHealth() {
    wireUpdates();
    $('#btn-health').addEventListener('click', () => showHealth());
    $('#hc-go').addEventListener('click', async () => {
      $('#hc-note').textContent = '';
      const ids = [...(healthTicked || [])];
      try {
        const r = await api('POST', '/api/health/run', { steps: ids });
        healthSnap.running = r.run;
        renderHealth();
        healthTick();
      } catch (e) { $('#hc-note').textContent = e.message; }
    });
    for (const id of ['#set-account', '#set-headless']) $(id).addEventListener('change', () => { acctDirty = true; refreshRouteLine(null); });
  }

  // ---------- MERGE-CON: health schedule (CON-HEALTH-SCHED) ----------
  let hsState = null;
  function renderHealthSched() {
    const st = hsState;
    $('#hs-line').textContent = HS.line(st);
    $('#hs-last').textContent = st ? HS.lastText(st) : '';
    if ($('#health-sched')) { $('#health-sched').textContent = HS.line(st); $('#health-sched').title = st ? HS.lastText(st) : ''; }
    const can = !!(st && st.available);
    for (const n of document.querySelectorAll('#hs-box input, #hs-save')) n.disabled = !can;
    if (!st) return;
    $('#hs-on').checked = !!st.enabled;
    $('#hs-at').value = (st.schedule && st.schedule.at) || st.defaultAt || $('#hs-at').value || '07:30';
  }
  async function loadHealthSched() {
    try { hsState = await api('GET', '/api/health/schedule'); } catch (e) { hsState = null; }
    renderHealthSched();
  }
  function wireHealthSched() {
    $('#hs-save').addEventListener('click', async () => {
      $('#hs-note').textContent = '';
      const b = HS.body({ enabled: $('#hs-on').checked, at: $('#hs-at').value, days: [...document.querySelectorAll('#hs-days .hs-day:checked')].map((c) => c.value) });
      if (!b.ok) { $('#hs-note').textContent = b.error; return; }
      $('#hs-save').disabled = true;
      try { hsState = await api('PUT', '/api/health/schedule', b.body); } catch (e) { $('#hs-note').textContent = e.message; }
      $('#hs-save').disabled = false;
      renderHealthSched();
    });
  }

  // ---------- MERGE-CON: scheduled tasks viewport (CON-SCHEDULER) ----------
  let scList = null;
  let scEdit = null; // {path, name} while the form alters an existing task's trigger
  function scForm() {
    return {
      name: $('#sc-name').value, folder: $('#sc-folder').value, exe: $('#sc-exe').value, args: $('#sc-args').value, workdir: $('#sc-workdir').value,
      kind: $('#sc-kind').value, at: $('#sc-at').value, date: $('#sc-date').value, days: [...document.querySelectorAll('#sc-days .sc-day:checked')].map((c) => c.value),
      delaySeconds: $('#sc-delay').value, everyMinutes: $('#sc-every').value, description: $('#sc-desc').value, enabled: $('#sc-enabled').checked,
    };
  }
  function scKindFields() {
    const k = $('#sc-kind').value;
    for (const n of document.querySelectorAll('#sc-form .sc-t')) {
      const show = (n.classList.contains('sc-t-time') && ['once', 'daily', 'weekly'].includes(k)) || (n.classList.contains('sc-t-once') && k === 'once') || (n.classList.contains('sc-t-weekly') && k === 'weekly') || (n.classList.contains('sc-t-delay') && (k === 'logon' || k === 'boot'));
      n.hidden = !show;
    }
  }
  function scSetEdit(ref, trig) {
    scEdit = ref;
    const editing = !!ref;
    for (const id of ['#sc-name', '#sc-folder', '#sc-exe', '#sc-args', '#sc-workdir']) $(id).disabled = editing;
    for (const n of document.querySelectorAll('#sc-form .sc-new')) n.hidden = editing;
    $('#sc-cancel-edit').hidden = !editing;
    $('#sc-go').textContent = editing ? 'Change trigger' : 'Add task';
    $('#sc-add-sum').textContent = editing ? 'Change the trigger of ' + ref.name : 'Add a task';
    if (editing) {
      const f = SC.triggerOf(trig);
      $('#sc-name').value = ref.name;
      $('#sc-folder').value = ref.path;
      $('#sc-kind').value = f.kind;
      $('#sc-at').value = f.at || '04:00';
      $('#sc-date').value = f.date;
      $('#sc-delay').value = f.delaySeconds;
      $('#sc-every').value = f.everyMinutes;
      for (const c of document.querySelectorAll('#sc-days .sc-day')) c.checked = false;
      $('#sc-add').open = true;
    }
    scKindFields();
  }
  function scTaskOf(key) { return ((scList && scList.tasks) || []).find((t) => t.full === key) || null; }
  function renderSched() {
    const sel = $('#sc-filter');
    const keep = sel.value;
    sel.textContent = '';
    sel.appendChild(el('option', null, 'All')).value = '';
    const by = (scList && scList.byProject) || {};
    const opts = [['console', 'Console']].concat(projects.map((p) => [p.id, p.name || p.id]));
    for (const [id, label] of opts) {
      const o = el('option', null, label + (by[id] ? ' (' + by[id] + ')' : ''));
      o.value = id;
      sel.appendChild(o);
    }
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
    $('#sc-sum').textContent = SC.summary(scList);
    const facts = $('#sc-facts');
    facts.textContent = '';
    for (const f of (scList && scList.facts) || []) facts.appendChild(el('li', null, f));
    const box = $('#sc-list');
    box.textContent = '';
    const gs = SC.groups(scList, projects, sel.value);
    if (scList && scList.available && !gs.length) box.appendChild(el('p', 'small muted', 'No tasks here.'));
    for (const g of gs) {
      box.appendChild(el('h4', 'sc-group', g.label + ' (' + g.rows.length + ')'));
      for (const r of g.rows) {
        const row = el('div', 'sc-row' + (r.boot ? ' sc-boot' : ''));
        row.dataset.task = r.key;
        row.title = r.title;
        const dot = el('span', 'dot ' + r.cls, VGLYPH[r.cls.slice(2)] || '.');
        row.appendChild(dot);
        row.appendChild(el('span', 'sc-name', r.name));
        row.appendChild(el('span', 'sc-trig', r.trigger));
        row.appendChild(el('span', 'sc-word ' + r.cls, r.word));
        const acts = el('span', 'sc-acts');
        const tog = el('button', 'small', r.enabled ? 'Disable' : 'Enable');
        tog.type = 'button';
        tog.dataset.act = 'toggle';
        const ed = el('button', 'small', 'Edit');
        ed.type = 'button';
        ed.dataset.act = 'edit';
        ed.title = 'Change the trigger';
        const rm = el('button', 'small danger', 'Remove');
        rm.type = 'button';
        rm.dataset.act = 'remove';
        rm.title = 'Remove the task (its XML is backed up first)';
        acts.appendChild(tog);
        acts.appendChild(ed);
        acts.appendChild(rm);
        row.appendChild(acts);
        box.appendChild(row);
      }
    }
    for (const b of box.querySelectorAll('button')) b.disabled = !!(scList && scList.busy);
  }
  async function loadSched() {
    try { scList = await api('GET', '/api/scheduler'); } catch (e) { scList = { available: false, error: e.message, tasks: [], facts: [] }; }
    renderSched();
  }
  async function scWrite(method, path, body) {
    $('#sc-note').textContent = '';
    try {
      await api(method, path, body);
      return true;
    } catch (e) { $('#sc-note').textContent = e.message; return false; } finally { await loadSched(); }
  }
  async function showSched(project) {
    $('#sc-note').textContent = '';
    scSetEdit(null);
    if (!$('#dlg-sched').open) $('#dlg-sched').showModal();
    await loadSched();
    if (project !== undefined) { $('#sc-filter').value = project; renderSched(); }
  }
  function wireSched() {
    $('#btn-sched').addEventListener('click', () => showSched());
    $('#sc-refresh').addEventListener('click', () => loadSched());
    $('#sc-filter').addEventListener('change', () => renderSched());
    $('#sc-kind').addEventListener('change', scKindFields);
    $('#sc-cancel-edit').addEventListener('click', () => scSetEdit(null));
    $('#sc-list').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const t = scTaskOf(b.closest('.sc-row').dataset.task);
      if (!t) return;
      const ref = { path: t.path, name: t.name };
      if (b.dataset.act === 'toggle') await scWrite('PATCH', '/api/scheduler/tasks', Object.assign({ enabled: !t.enabled }, ref));
      else if (b.dataset.act === 'edit') scSetEdit(ref, t.triggers[0]);
      else if (b.dataset.act === 'remove') {
        // two-step confirm in the UI: the first click arms the button for 4 s
        if (b.dataset.armed !== '1') {
          b.dataset.armed = '1';
          b.textContent = 'Confirm remove';
          setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = 'Remove'; } }, 4000);
          return;
        }
        await scWrite('DELETE', '/api/scheduler/tasks?path=' + encodeURIComponent(t.path) + '&name=' + encodeURIComponent(t.name));
      }
    });
    $('#sc-go').addEventListener('click', async () => {
      $('#sc-note').textContent = '';
      if (scEdit) {
        const tr = SC.triggerBody(scForm());
        if (!tr.ok) { $('#sc-note').textContent = tr.error; return; }
        if (await scWrite('PATCH', '/api/scheduler/tasks', Object.assign({ trigger: tr.trigger }, scEdit))) scSetEdit(null);
        return;
      }
      const b = SC.addBody(scForm());
      if (!b.ok) { $('#sc-note').textContent = b.error; return; }
      if (await scWrite('POST', '/api/scheduler/tasks', b.body)) { $('#sc-add').open = false; for (const id of ['#sc-name', '#sc-exe', '#sc-args', '#sc-workdir', '#sc-desc', '#sc-delay', '#sc-every']) $(id).value = ''; }
    });
    scKindFields();
  }

  // ---------- MERGE-CON: watchdog readings (CON-WATCHDOG, observe only) ----------
  let wdSnap = null;
  function renderWatch() {
    $('#wd-head').textContent = WD.head(wdSnap);
    const box = $('#wd-body');
    box.textContent = '';
    if (!wdSnap) return;
    for (const s of WD.sections(wdSnap)) {
      const sec = el('section', 'wd-sec');
      sec.dataset.sec = s.id;
      sec.appendChild(el('h4', 'wd-title', s.title));
      if (!s.rows.length) sec.appendChild(el('p', 'small muted', s.empty));
      for (const r of s.rows) {
        const row = el('div', 'wd-row');
        row.title = r.title;
        row.appendChild(el('span', 'wd-label', r.label));
        if (r.value) row.appendChild(el('span', 'wd-val', r.value));
        sec.appendChild(row);
      }
      if (s.note) sec.appendChild(el('p', 'small muted', s.note));
      box.appendChild(sec);
    }
  }
  async function loadWatch() {
    try { wdSnap = await api('GET', '/api/watchdog'); $('#wd-note').textContent = ''; } catch (e) { wdSnap = null; $('#wd-note').textContent = e.message; }
    renderWatch();
  }
  function wireWatch() {
    $('#btn-watch').addEventListener('click', async () => {
      if (!$('#dlg-watch').open) $('#dlg-watch').showModal();
      await loadWatch();
    });
    $('#wd-sample').addEventListener('click', async () => {
      $('#wd-sample').disabled = true;
      $('#wd-note').textContent = '';
      try { wdSnap = await api('POST', '/api/watchdog/sample'); } catch (e) { $('#wd-note').textContent = e.message; }
      $('#wd-sample').disabled = false;
      renderWatch();
    });
  }

  // ---------- events ----------
  function connectEvents() {
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/events?t=' + encodeURIComponent(TOKEN));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'state' || m.t === 'added') {
        if (views.has(m.pane.id)) views.get(m.pane.id).update(m.pane);
        else if (m.t === 'added') ensureView(m.pane, PL.placement(m.pane, CLIENT_ID) === 'tile' ? undefined : { minimized: true });
      } else if (m.t === 'removed') {
        removeView(m.id);
      } else if (m.t === 'panes') {
        for (const p of m.panes) if (views.has(p.id)) views.get(p.id).update(p);
      } else if (m.t === 'health' && m.health) {
        onHealthEvent(m.health);
      } else if (m.t === 'res' && m.res) {
        renderRes(m.res);
      }
    };
    ws.onclose = () => { resOffline(); setTimeout(connectEvents, 2000); };
  }

  // ---------- Projects sidebar collapse (per viewer) ----------
  function applySidebar(collapsed) {
    document.body.classList.toggle('no-sidebar', collapsed);
    const b = $('#btn-sidebar');
    b.setAttribute('aria-pressed', collapsed ? 'false' : 'true');
    b.title = (collapsed ? 'Show' : 'Hide') + ' the Projects sidebar (Ctrl+Alt+B)';
  }
  function toggleSidebar(force) {
    const collapsed = force === undefined ? !document.body.classList.contains('no-sidebar') : force;
    applySidebar(collapsed);
    prefSet('cc-sidebar', collapsed ? 'collapsed' : 'open');
    for (const v of views.values()) v.scheduleFit();
  }

  function wireTopbar() {
    applySidebar(prefGet('cc-sidebar', 'open') === 'collapsed');
    $('#btn-sidebar').addEventListener('click', () => toggleSidebar());
    $('#rail-new').addEventListener('click', () => showNewDialog(null));
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        e.stopPropagation();
        toggleSidebar();
      }
    }, true);
    $('#btn-new').addEventListener('click', () => showNewDialog(null));
    $('#btn-font-up').addEventListener('click', () => saveSettings({ fontSize: Math.min(40, settings.fontSize + 1) }));
    $('#btn-font-dn').addEventListener('click', () => saveSettings({ fontSize: Math.max(9, settings.fontSize - 1) }));
    // Theme toggle lives in the Settings dialog: applies and saves at once, the select follows.
    $('#btn-theme').addEventListener('click', () => {
      const t = effTheme() === 'light' ? 'dark' : 'light';
      $('#set-theme').value = t;
      settings = Object.assign({}, settings, { theme: t });
      applyTheme();
      saveSettings({ theme: t }).catch(() => {});
    });
    $('#btn-status').addEventListener('click', () => saveSettings({ statusPanel: !settings.statusPanel }).then(relayout));
    $('#btn-settings').addEventListener('click', showSettings);
    $('#btn-rescan').addEventListener('click', async () => {
      projects = (await api('POST', '/api/projects/rescan')).projects;
      await loadTools();
      renderProjects();
      pollStatus();
    });
    $('#btn-quit').addEventListener('click', async () => {
      if (!(await askConfirm({ title: 'Quit Claude Console', what: 'Stop the Claude Console server and end every pane process?', safe: 'The Desktop shortcut starts it again.', go: 'Quit', danger: true }))) return;
      try { await api('POST', '/api/shutdown'); } catch (e) { /* closing */ }
      document.body.textContent = 'Claude Console server stopped. Close this window; the Desktop shortcut starts it again.';
    });
    window.addEventListener('keydown', (e) => {
      // Ctrl+Alt+Left/Right moves focus between visible panes.
      if (e.ctrlKey && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        const vis = order.filter((id) => views.has(id) && !views.get(id).minimized);
        if (!vis.length) return;
        const i = vis.indexOf(focusedId);
        const n = vis[(i + (e.key === 'ArrowRight' ? 1 : vis.length - 1)) % vis.length];
        setFocused(n);
        views.get(n).focusInput();
        e.preventDefault();
      }
    });
    window.addEventListener('focus', () => { if (focusedId) markSeen(focusedId); });
  }

  // ---------- boot ----------
  async function boot() {
    if (!TOKEN) {
      document.body.textContent = 'No access token. Start Claude Console from its Desktop shortcut.';
      return;
    }
    try {
      [info, settings] = await Promise.all([api('GET', '/api/info'), api('GET', '/api/settings')]);
    } catch (e) {
      document.body.textContent = 'Cannot reach the Claude Console server (' + e.message + '). Start it from the Desktop shortcut.';
      return;
    }
    const [pj, layout, live] = await Promise.all([api('GET', '/api/projects'), api('GET', '/api/layout'), api('GET', '/api/panes')]);
    projects = pj.projects;
    await loadTools();
    applyTheme();
    // CON-UX-VERSION: bottom right of the footer bar
    $('#tb-version').textContent = 'v' + info.version;
    wireTopbar();
    wireUsage();
    renderRes(null);
    wireDialogs();
    wireDrag();
    const saved = new Map((layout.panes || []).map((e) => [e.id, e]));
    const liveIds = new Set(live.panes.map((p) => p.id));
    const savedOrder = (layout.panes || []).map((e) => e.id);
    const sorted = live.panes.slice().sort((a, b) => {
      const ia = savedOrder.indexOf(a.id);
      const ib = savedOrder.indexOf(b.id);
      return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib);
    });
    for (const p of sorted) ensureView(p, saved.get(p.id));
    // Layout entries whose process is gone (server restarted) become reopenable chips.
    dormant = (layout.panes || []).filter((e) => !liveIds.has(e.id) && e.kind).slice(0, 12);
    maximizedId = layout.maximized && liveIds.has(layout.maximized) ? layout.maximized : null;
    relayout();
    renderProjects();
    connectEvents();
    pollStatus();
    setInterval(pollStatus, 5000);
    // State word ages are whole minutes: re-check every 15 s, write only on change.
    setInterval(() => { for (const v of views.values()) v.refreshWord(); }, 15000);
    if (darkMq && darkMq.addEventListener) darkMq.addEventListener('change', () => { if (settings.theme !== 'light' && settings.theme !== 'dark') applyTheme(); });
    if (phoneMq && phoneMq.addEventListener) phoneMq.addEventListener('change', relayout);
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('.pmenu, .pbtns .more')) for (const v of views.values()) v.toggleMenu(false); });
    window.__cc = { renderUsage, fitUsage, renderRes, fitRes, get usagePrefs() { return Object.assign({}, usagePrefs); }, views, openPane, closePane, setMinimized, toggleMax, toggleSidebar, setHideCliChrome, effTheme, relayout, get order() { return order.slice(); }, get dormant() { return dormant; } };
  }

  boot();
})();
