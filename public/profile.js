/* Claude Console - setup profile UI (CON-013 L5): profile browser, template editor,
   review / apply / revert, adopt screens (when the build has adopt) and the
   machine-profile advisor. Plain browser JS, no build step. The pure helpers at the
   top are also loaded by tests/profile-ui-client.test.js. ASCII only. */

// ---------- pure helpers (browser + node) ----------
(function (root) {
  'use strict';
  // Module row glyph + count (UI/UX standard section 1: glyph + word, never colour alone).
  function moduleGlyph(m) {
    if (m.locked) return '[+]';
    if (!m.on) return '[ ]';
    // partly on: [~] next to the "3/8" count (UX-N9; [-] is idle / dropped)
    return m.on === m.total ? '[+]' : '[~]';
  }
  function moduleCount(m) { return m.locked ? 'always on' : m.on + '/' + m.total; }
  function riskWord(r) { return r === 'high' ? '! high risk' : r === 'medium' ? 'medium' : 'low'; }
  function scopeWord(it) {
    const w = [];
    if (it.windowsOnly) w.push('Windows only');
    if (it.scope === 'template') w.push('template');
    if (it.scope === 'machine-specific') w.push('this machine');
    return w.join(', ');
  }
  function stateWord(it) { return it.locked ? 'always on' : it.state === 'on' ? 'on' : 'off'; }
  function listText(ids, byId) {
    if (!ids || !ids.length) return '-';
    return ids.map((id) => (byId && byId[id] ? byId[id].title : id)).join(', ');
  }
  // Plan rows grouped per module, in profile order: [{module, title, rows, counts}].
  function groupPlan(plan, modules) {
    const itemMod = {};
    for (const m of modules || []) for (const it of m.items) itemMod[it.id] = m;
    const out = [];
    const by = {};
    for (const r of (plan && plan.rows) || []) {
      const m = itemMod[r.item] || { id: '?', title: 'Other', order: 99 };
      if (!by[m.id]) { by[m.id] = { module: m.id, title: m.title, order: m.order, rows: [], counts: {} }; out.push(by[m.id]); }
      by[m.id].rows.push(r);
      by[m.id].counts[r.status] = (by[m.id].counts[r.status] || 0) + 1;
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }
  function countsText(c) {
    if (!c) return '';
    const parts = [];
    for (const k of ['new', 'differs', 'removed', 'conflict', 'unreadable', 'same', 'skipped']) if (c[k]) parts.push(c[k] + ' ' + k);
    return parts.join(', ') || 'nothing to change';
  }
  // differs is a neutral change, not a problem: [~] (UX-F13); same rows carry no glyph
  // (UX-N10), three spaces keep the column.
  const STATUS_GLYPH = { new: '[+]', differs: '[~]', removed: '[-]', same: '   ', conflict: '[x]', unreadable: '[x]', skipped: '[-]' };
  function rowGlyph(status) { return STATUS_GLYPH[status] || '[ ]'; }
  // Typed acknowledgement per high-risk item (custom path): "apply <id>".
  function ackPhrase(id) { return 'apply ' + id; }
  function acksComplete(highRisk, typed) { return (highRisk || []).every((x) => (typed[x.id] || '').trim() === ackPhrase(x.id)); }
  // A row that only works inside a project, on a target without one (R1-10, R3-18). Its
  // target can hold an unfilled {variable}, so a fold names modules, never targets.
  function leftOut(r) { return r.status === 'skipped' && /no repo target|needs a project target/.test(r.reason || ''); }
  function isChange(r) { return r.status !== 'same' && r.status !== 'skipped'; }
  // The plan's sum line. On a user target it says what the numbers mean (R1-10 step 2);
  // o.targetWord: what this screen calls its target control.
  function planSummary(plan, o) {
    const left = ((plan && plan.rows) || []).filter(leftOut).length;
    if (!(plan && plan.target && plan.target.user && left)) return countsText(plan && plan.counts) + '.';
    const c = plan.counts || {};
    const n = (c.new || 0) + (c.differs || 0) + (c.removed || 0);
    return n + ' change' + (n === 1 ? '' : 's') + ' to your Claude settings. ' + left + ' more only ' + (left === 1 ? 'works inside a project and is' : 'work inside a project and are')
      + ' left out. Pick a project under ' + ((o && o.targetWord) || 'Apply to') + ', to add them.';
  }
  function foldLine(n) { return n + ' item' + (n === 1 ? ' does' : 's do') + ' not apply to this target (they need a project)'; }
  // The profile browser's status line (R3-17): a switch writes nothing.
  function pickLine(line) { return line + ' Switches change your picks only. Nothing reaches your machine until Review, then Apply.'; }
  // The engine's refusals name the terminal's --ack flag; a screen says it in words.
  function refusedLine(line, plan) {
    const l = String(line || '');
    const title = (id) => { const x = ((plan && plan.highRisk) || []).find((y) => y.id === id); return x && x.title ? x.title : id; };
    let m = /^refused: (\S+) needs the typed acknowledgement --ack /.exec(l);
    if (m) return 'Refused: ' + title(m[1]) + ' needs you to type "' + ackPhrase(m[1]) + '" first. Nothing was written.';
    m = /^refused: (\S+) is high risk; add --ack /.exec(l);
    if (m) return 'Refused: ' + title(m[1]) + ' is high risk and was not confirmed. Nothing was written.';
    return l;
  }
  // One row of the missing-value card (R1-4, R3-6): a plain label, a hint, and the raw
  // name only when the profile declares nothing better. hintFor: the wizard's form hint.
  function missingRow(m, v, hintFor) {
    v = v || {};
    const why = m.why || v.why || null;
    const label = m.label || v.label || why || m.name;
    if (m.name === 'python') return { label, hint: 'Python was not found. Install Python 3, or skip the items that use it.' };
    const form = hintFor ? hintFor({ name: m.name, type: m.type || v.type, hint: v.hint }) : '';
    const hint = [why && why !== label ? why : '', /^must /.test(form) ? 'It ' + form + '.' : ''].filter(Boolean).join(' ');
    return { label, hint };
  }
  // Verification rows in place: [>] while running, then [+] / [x] / [-] skipped.
  function verifyGlyph(v) { return v.running ? '[>]' : v.skipped ? '[-]' : v.ok ? '[+]' : '[x]'; }
  function verifyWord(v) { return v.running ? 'running' : v.skipped ? 'skipped' : v.ok ? 'done' : 'failed'; }
  // Adopt report: status glyph + word per rule (design c.4 step 2).
  // Statuses as profile-adopt scan() writes them (STATUS_GLYPH there).
  const ADOPT = { conforms: ['[+]', 'conforms'], differs: ['[~]', 'differs'], missing: ['[ ]', 'missing'], conflicts: ['[x]', 'conflicts'], 'local-only': ['[-]', 'local'], local: ['[-]', 'local'], outside: ['[-]', 'outside'], off: ['[-]', 'off'] };
  function adoptGlyph(s) { return (ADOPT[s] || ['[ ]', s || '?'])[0]; }
  function adoptWord(s) { return (ADOPT[s] || ['[ ]', s || '?'])[1]; }
  // Adopt steps in words, never the internal op ids (UX-F21).
  const OP_WORD = { start: 'Copying and scanning', load: 'Opening this adoption', choose: 'Saving your choices', apply: 'Applying to the copy', setChecks: 'Finding the project checks', check: 'Running the function check', revert: 'Reverting the change', works: 'Recording that it works', promote: 'Making the copy your project', removeOriginal: 'Removing the original', 'remove-original': 'Removing the original', funcheck: 'Running the function check' };
  function opWord(op) { return OP_WORD[op] || String(op || ''); }
  // A result line that is only "<op id> done" reads as "<words> - done".
  function opLine(op, line) {
    const l = String(line || '');
    if (!l) return opWord(op) + ' - done';
    const m = /^([a-zA-Z-]+)\s+done\b(.*)$/.exec(l);
    if (m && OP_WORD[m[1]]) return OP_WORD[m[1]] + ' - done' + m[2];
    return l.replace(/^\[?([a-zA-Z-]+)\]?\.\.\.$/, (x, k) => (OP_WORD[k] ? OP_WORD[k] + '...' : x));
  }
  // Adopt defaults: the engine's own per-change default (missing + low risk + no break
  // risk + not blocked); report-only rows are never a choice.
  function adoptDefault(rule, ch) {
    if (ch.reportOnly) return false;
    if (typeof ch.default === 'boolean') return ch.default;
    return rule.status === 'missing' && (ch.risk || 'low') === 'low' && !ch.breakRisk && !ch.break_risk;
  }
  // Line ranges [[start, end], ...] as "3-5, 9".
  function rangeText(rs) { return Array.isArray(rs) && rs.length ? rs.map((r) => (r[0] === r[1] ? String(r[0]) : r[0] + '-' + r[1])).join(', ') : ''; }
  // "file:orig-lines -> copy-lines" for every file a change touches.
  function fileLine(ch) {
    const files = (ch.files || []).filter((f) => f && f.file);
    if (!files.length) return ch.file || '-';
    return files.map((f) => { const o = rangeText(f.orig); const c = rangeText(f.copy); return f.file + (o ? ':' + o : '') + (c ? ' -> ' + c : ''); }).join('; ');
  }
  function breakText(ch) { const b = ch.breakRisk; return b ? b.class + (b.reasons && b.reasons.length ? ': ' + b.reasons.join('; ') : '') : ''; }
  function verdictGlyph(v) { return v === 'WORSE' ? '[x]' : v === 'better' ? '[+]' : v === 'same' ? '[+]' : '[ ]'; }
  // One side of a function-check row (profile-adopt slimRow): exit, counts, seconds.
  function checkSide(x) {
    if (!x) return '-';
    const c = x.counts && x.counts.passed !== null && x.counts.passed !== undefined ? ', ' + x.counts.passed + ' pass / ' + (x.counts.failed || 0) + ' fail' : '';
    return (x.timedOut ? 'timed out' : 'exit ' + x.code) + c + (typeof x.ms === 'number' ? ', ' + (Math.round(x.ms / 100) / 10) + ' s' : '');
  }
  // R3-19: the "Leave out folders" box. The copy compares each name with a top-level path
  // and the route drops any other shape in silence, so a shape it cannot use is refused
  // here, never copied anyway.
  function excludeList(text) {
    const list = [];
    const bad = [];
    for (const raw of String(text || '').split(',')) {
      const x = raw.trim().replace(/[\\/]+$/, '');
      if (!x) continue;
      if (!/^[A-Za-z0-9._ -]{1,120}$/.test(x) || /^\.+$/.test(x)) bad.push(raw.trim());
      else if (!list.includes(x)) list.push(x);
    }
    return { list, bad };
  }
  // R3-20: an adoption's stored status in words.
  const ADOPT_STATUS = { scanned: 'scanned, nothing applied yet', applied: 'changes applied to the copy', 'check-failed': 'function check failed', checked: 'function check passed', confirmed: 'confirmed working, ready to promote', promoted: 'promoted', 'original-removed': 'promoted, original removed' };
  function adoptStatusWord(s) { return ADOPT_STATUS[s] || String(s || ''); }
  // R3-40: an advisor finding with its measurement and next step ({title, body, do}).
  function findingText(f) {
    if (typeof f === 'string') return f;
    if (!f || typeof f !== 'object') return '';
    if (f.text) return f.text;
    if (!f.title) return '';
    return [f.title, f.body, f.do].filter(Boolean).map((s) => (/[.!?]$/.test(String(s)) ? String(s) : s + '.')).join(' ');
  }
  const api = { excludeList, adoptStatusWord, findingText, moduleGlyph, moduleCount, riskWord, scopeWord, stateWord, listText, groupPlan, countsText, rowGlyph, ackPhrase, acksComplete, leftOut, isChange, planSummary, foldLine, pickLine, refusedLine, missingRow, verifyGlyph, verifyWord, adoptGlyph, adoptWord, adoptDefault, rangeText, fileLine, breakText, verdictGlyph, checkSide, opWord, opLine };
  if (typeof module === 'object' && module.exports) module.exports.Profile = api;
  else root.CCProfile = api;
})(this);

// ---------- shared DOM kit for the profile, setup and recovery screens ----------
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const PF = window.CCProfile;
  function token() { try { return sessionStorage.getItem('cc-token') || ''; } catch (e) { return ''; } }
  async function api(method, path, body) {
    const r = await fetch(path, { method, headers: Object.assign({ 'X-Console-Token': token() }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || ('HTTP ' + r.status)); e.status = r.status; e.body = j; throw e; }
    return j;
  }
  // h('div.cls#id', {attr}, children...) - small element builder; strings become text.
  function h(sel, attrs) {
    const m = /^([a-z0-9]+)((?:[.#][A-Za-z0-9_-]+)*)$/.exec(sel) || [null, 'div', ''];
    const e = document.createElement(m[1]);
    for (const part of (m[2] || '').match(/[.#][A-Za-z0-9_-]+/g) || []) { if (part[0] === '.') e.classList.add(part.slice(1)); else e.id = part.slice(1); }
    let kids = Array.prototype.slice.call(arguments, 2);
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids = [attrs].concat(kids); attrs = null; }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'on') { for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); continue; }
      if (k === 'text') { e.textContent = v; continue; }
      if (k === 'dataset') { Object.assign(e.dataset, v); continue; }
      if (k in e && typeof v !== 'string') e[k] = v; else e.setAttribute(k, v === true ? '' : String(v));
    }
    const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else e.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); };
    kids.forEach(add);
    return e;
  }
  function open(dlg) { if (!dlg.open) dlg.showModal(); }
  function note(el, text, bad) { el.textContent = text || ''; el.classList.toggle('pf-bad', !!bad); }
  // Re-render without losing the user's place (UX-B1, UX-F8): remember the focused
  // control by a stable key and the scroll offsets, run fn (sync or async), then put
  // focus back on the control's replacement and restore the scroll.
  function focusKey(el, box) {
    if (!el || !box || el === box || !box.contains(el)) return null;
    const tag = el.tagName.toLowerCase();
    if (el.id) return { sel: '#' + CSS.escape(el.id) };
    const ds = el.dataset || {};
    for (const k of ['item', 'task', 'var', 'id', 'path', 'change', 'prop', 'key']) if (ds[k] !== undefined) return { sel: tag + '[data-' + k + '="' + CSS.escape(ds[k]) + '"]' };
    if (el.type === 'radio' && el.name) return { sel: 'input[name="' + CSS.escape(el.name) + '"][value="' + CSS.escape(el.value) + '"]' };
    const al = el.getAttribute('aria-label');
    if (al) return { sel: tag + '[aria-label="' + CSS.escape(al) + '"]' };
    return { tag, text: (el.textContent || '').trim() };
  }
  function findKey(box, k) {
    if (!k) return null;
    if (k.sel) return box.querySelector(k.sel);
    return Array.from(box.querySelectorAll(k.tag)).find((x) => (x.textContent || '').trim() === k.text) || null;
  }
  function keep(box, scrollers, fn) {
    const k = focusKey(document.activeElement, box);
    const list = (scrollers || []).filter(Boolean);
    const tops = list.map((s) => s.scrollTop);
    const done = () => {
      list.forEach((s, i) => { s.scrollTop = tops[i]; });
      const n = findKey(box, k);
      if (n && n !== document.activeElement && !n.disabled) n.focus({ preventScroll: true });
    };
    const r = fn();
    if (r && typeof r.then === 'function') return r.then((x) => { done(); return x; });
    done();
    return r;
  }
  // Arrow keys move focus through a group of buttons (keyboard access).
  function arrowNav(box, sel) {
    box.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const list = Array.from(box.querySelectorAll(sel)).filter((x) => !x.disabled);
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      let n = i;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = Math.min(list.length - 1, i + 1);
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = Math.max(0, i - 1);
      if (e.key === 'Home') n = 0;
      if (e.key === 'End') n = list.length - 1;
      list[n].focus();
      if (list[n].getAttribute('role') === 'radio' || list[n].dataset.select === '1') list[n].click();
      e.preventDefault();
    });
  }
  async function targets() {
    let projects = [];
    try { projects = (await api('GET', '/api/projects')).projects || []; } catch (e) { projects = []; }
    return [{ value: 'user', label: 'This user (Claude settings only)' }].concat(projects.filter((p) => !p.retired).map((p) => ({ value: 'p:' + p.id, label: 'project: ' + p.name })));
  }
  function targetOf(v) { return v && v.startsWith('p:') ? { project: v.slice(2) } : { user: true }; }
  // Defaults to "This user" (or the caller's current value): never preselects a project
  // the user did not pick (UX-F22). o.projectsOnly: a "Pick a project" placeholder, no
  // user entry (adopt).
  function targetSelect(id, onChange, o) {
    o = o || {};
    const sel = h('select#' + id, { 'aria-label': o.label || 'Apply to' });
    targets().then((list) => {
      if (o.projectsOnly) { list = list.filter((t) => t.value !== 'user'); sel.appendChild(h('option', { value: '', text: 'Pick a project' })); }
      for (const t of list) sel.appendChild(h('option', { value: t.value, text: t.label }));
      const want = o.value && list.some((t) => t.value === o.value) ? o.value : (o.projectsOnly ? '' : 'user');
      sel.value = want;
      if (onChange) onChange(sel.value);
    });
    if (onChange) sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  }
  // The card for the values a plan reports missing (browser Review and the wizard Preview,
  // UX-F25, R1-4). onAgain(newValues) plans again. o: {titleOf(id), onSkip(name, on) and
  // canSkip(m) where the screen can skip (wizard), otherLine(m) where it cannot (browser),
  // skippedRows: values skipped here earlier, kept so the tick can be undone}.
  function missingCard(plan, vars, values, onAgain, o) {
    o = o || {};
    const SP = window.CCSetup;
    const need = plan.missing || [];
    const box = h('div.wz-input.pf-missing', h('div.wz-ctitle', { text: need.length ? 'One more thing is needed before this can be previewed' : 'Skipped for now' }));
    const titles = (m) => (o.titleOf ? m.items.map(o.titleOf) : m.items).join(', ');
    const declared = (m) => (vars || []).find((x) => x.name === m.name) || {};
    const skipTick = (m, on) => {
      const sk = h('input', { type: 'checkbox', checked: on, 'aria-label': 'Skip ' + PF.missingRow(m, declared(m)).label, dataset: { skip: m.name } });
      sk.addEventListener('change', () => o.onSkip(m.name, sk.checked));
      return h('label.check.small', sk, 'Skip - the items that use it stay off');
    };
    const lines = {};
    for (const m of need) {
      const v = declared(m);
      const r = PF.missingRow(m, v, SP && SP.hintFor);
      const inp = h('input.mono', { type: 'text', spellcheck: 'false', dataset: { var: m.name }, value: values[m.name] || '', 'aria-label': r.label });
      lines[m.name] = h('span.small.wz-val', { role: 'status' });
      const row = h('div', { title: 'Used by: ' + titles(m) }, h('label', r.label + ' ', inp), ' ', lines[m.name]);
      if (r.hint) row.appendChild(h('div.small.muted', { text: r.hint }));
      if (o.onSkip && (!o.canSkip || o.canSkip(m))) row.appendChild(h('div', skipTick(m, false)));
      else if (o.otherLine && o.otherLine(m)) row.appendChild(h('div.small.muted', { text: o.otherLine(m) }));
      box.appendChild(row);
    }
    for (const m of o.skippedRows || []) box.appendChild(h('div', { title: 'Used by: ' + titles(m) }, h('div', { text: PF.missingRow(m, declared(m)).label }), h('div', skipTick(m, true))));
    if (need.length) box.appendChild(h('button.small', { type: 'button', text: 'Preview again', on: { click: () => {
      const nv = Object.assign({}, values);
      let ok = true;
      for (const m of need) {
        const i = box.querySelector('input[data-var="' + CSS.escape(m.name) + '"]');
        if (!i || !i.value) continue;
        const v = Object.assign({}, declared(m), { name: m.name, type: m.type || declared(m).type, pattern: m.pattern || declared(m).pattern });
        const good = !SP || SP.validValue(v, i.value);
        note(lines[m.name], good ? '' : '[x] ' + (SP ? SP.hintFor(v) : ''), !good);
        if (good) nv[m.name] = i.value; else ok = false;
      }
      if (ok) onAgain(nv);
    } } }));
    return box;
  }
  // Plan view: per-module groups (collapsed), the diff, high-risk heading; shared by the
  // browser's Review and the wizard's Preview.
  function planView(plan, modules, o) {
    o = o || {};
    const box = h('div.pf-plan');
    box.appendChild(h('p.pf-sum', { text: 'Dry run - nothing written yet. ' + PF.planSummary(plan, { targetWord: o.targetWord }) }));
    // a value still missing is asked by its card, so no verdict line repeats it (R1-4)
    if (plan.verdict && plan.verdict.line && !(plan.missing && plan.missing.length)) box.appendChild(h('p.pf-bad', { role: 'alert', text: '[x] ' + plan.verdict.line }));
    if (plan.depsAdded && plan.depsAdded.length) box.appendChild(h('p.small', { text: 'Also on (needed by your choices): ' + plan.depsAdded.map((x) => x.title).join(', ') }));
    // The high-risk list, with no raw id where no phrase is typed. o.riskFirst: above the
    // module rows, followed by o.consent (the wizard's Preview, N1).
    const riskBlock = () => {
      if (plan.highRisk && plan.highRisk.length) {
        box.appendChild(h('h4', { text: 'High-risk items (' + plan.highRisk.length + ')' }));
        // With a yes under it, a long list scrolls in its own box, so the yes stays in view.
        const capped = !!(o.consent && o.consent.length);
        const ul = capped ? h('ul.pf-hr.pf-hr-capped', { tabindex: '0', 'aria-label': 'High-risk items' }) : h('ul.pf-hr');
        for (const x of plan.highRisk) {
          const li = h('li', h('span', { text: '! ' + x.title + (o.typedAcks ? ' (' + x.id + ')' : '') }));
          if (o.typedAcks) {
            const inp = h('input.pf-ack', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Type ' + PF.ackPhrase(x.id), placeholder: PF.ackPhrase(x.id), dataset: { id: x.id } });
            inp.addEventListener('input', () => { o.typed[x.id] = inp.value; if (o.onAck) o.onAck(); });
            li.appendChild(inp);
          }
          ul.appendChild(li);
        }
        box.appendChild(ul);
      }
      for (const el of o.consent || []) box.appendChild(el);
    };
    if (o.riskFirst) riskBlock();
    const rowEl = (r) => h('div.pf-row.mono', { text: PF.rowGlyph(r.status) + ' ' + r.status.padEnd(9) + ' ' + r.kind + ' ' + r.target + (r.reason ? ' - ' + r.reason : '') });
    const left = (plan.rows || []).filter(PF.leftOut);
    // Changing rows show by default; what stays as it is sits one click further (R3-18).
    for (const g of PF.groupPlan(Object.assign({}, plan, { rows: (plan.rows || []).filter((r) => !PF.leftOut(r)) }), modules)) {
      const det = h('details.pf-group');
      det.appendChild(h('summary', { text: g.title + ' - ' + PF.countsText(g.counts) }));
      for (const r of g.rows.filter(PF.isChange)) det.appendChild(rowEl(r));
      const same = g.rows.filter((r) => !PF.isChange(r));
      if (same.length) {
        const more = h('details.pf-same', h('summary.small', { text: same.length + ' not changing' }));
        for (const r of same) more.appendChild(rowEl(r));
        det.appendChild(more);
      }
      box.appendChild(det);
    }
    if (left.length) {
      const fold = h('details.pf-fold', h('summary.small', { text: PF.foldLine(left.length) }));
      for (const g of PF.groupPlan({ rows: left }, modules)) fold.appendChild(h('div.small.muted', { text: g.title + ' - ' + g.rows.length }));
      box.appendChild(fold);
    }
    if (!o.riskFirst) riskBlock();
    if (plan.diff) {
      const det = h('details.pf-diff');
      det.appendChild(h('summary', { text: 'Full diff' }));
      det.appendChild(h('pre.mono', { text: plan.diff }));
      box.appendChild(det);
    }
    return box;
  }
  function verifyRows(rows, onReport) {
    const box = h('div.pf-verify', { role: 'list' });
    for (const v of rows) {
      const row = h('div.pf-vrow' + (v.ok || v.skipped ? '' : '.pf-bad'), { role: 'listitem' }, h('span.mono', { text: PF.verifyGlyph(v) + ' ' + PF.verifyWord(v).padEnd(7) + ' ' + v.check + ' (' + v.item + ')' + (v.reason ? ' - ' + v.reason : '') }));
      if (!v.ok && !v.skipped && !v.running && onReport) row.appendChild(h('button.small', { type: 'button', text: 'Report a problem', on: { click: () => onReport({ id: 'verify:' + v.item, reason: v.check + ': ' + (v.reason || 'failed') }) } }));
      box.appendChild(row);
    }
    return box;
  }
  function report(step) { if (window.CCRecoveryUI) window.CCRecoveryUI.crash(step); }
  window.CCUI = { api, h, open, note, keep, arrowNav, targets, targetOf, targetSelect, missingCard, planView, verifyRows, report };
})();

// ---------- profile browser (dlg-profile) ----------
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const PF = window.CCProfile;
  const U = window.CCUI;
  const { h, api } = U;
  let st = null;
  let cur = null; // selected module id
  let target = 'user';
  let byId = {};
  const $ = (s) => document.querySelector(s);

  async function load() {
    st = await api('GET', '/api/profile');
    byId = {};
    if (st.available) for (const m of st.modules) for (const it of m.items) byId[it.id] = it;
    return st;
  }

  async function openBrowser(moduleId) {
    const dlg = $('#dlg-profile');
    U.open(dlg);
    try { await load(); } catch (e) { U.note($('#pf-line'), 'Setup profile unavailable: ' + e.message, true); return; }
    if (!st.available) { $('#pf-mods').textContent = ''; $('#pf-items').textContent = ''; U.note($('#pf-line'), st.reason || 'No setup profile in this build.', true); return; }
    $('#pf-ver').textContent = st.profile.version;
    if (!$('#pf-target').options.length) {
      for (const t of await U.targets()) $('#pf-target').appendChild(h('option', { value: t.value, text: t.label }));
      $('#pf-target').value = target;
    }
    cur = moduleId || cur || st.modules[0].id;
    render();
    const b = document.querySelector('#pf-mods button[data-id="' + cur + '"]');
    if (b) b.focus();
  }

  // Re-render keeping focus and scroll (UX-B1, UX-F8).
  function rerender() { U.keep($('#dlg-profile'), [$('#pf-items'), $('#pf-mods')], render); }

  function render() {
    U.note($('#pf-line'), PF.pickLine(st.status.line));
    const ul = $('#pf-mods');
    ul.textContent = '';
    // listbox > li role=presentation > option; one Tab stop (roving tabindex, UX-F12)
    for (const m of st.modules) {
      const b = h('button.pf-mod', { type: 'button', role: 'option', tabindex: m.id === cur ? '0' : '-1', 'aria-selected': m.id === cur ? 'true' : 'false', dataset: { id: m.id, select: '1' }, on: { click: () => { cur = m.id; render(); const x = document.querySelector('#pf-mods button[data-id="' + m.id + '"]'); if (x) x.focus(); } } },
        h('span.pf-g.mono', { text: PF.moduleGlyph(m) }), h('span.pf-n.num', { text: String(m.order) }), h('span.pf-t', { text: m.title }), h('span.pf-c.num', { text: PF.moduleCount(m) }));
      ul.appendChild(h('li', { role: 'presentation' }, b));
    }
    renderItems();
  }

  function renderItems() {
    const m = st.modules.find((x) => x.id === cur);
    const box = $('#pf-items');
    box.textContent = '';
    const head = h('div.pf-mhead', h('h4', { text: m.order + ' ' + m.title }), m.locked ? null : h('span.pf-c.num', { text: 'on ' + m.on + ' of ' + m.total }));
    if (m.locked) head.appendChild(h('span.pf-lock', { text: 'always on - a safety rule you cannot turn off' }));
    else {
      const cb = h('input', { type: 'checkbox', id: 'pf-modtoggle', checked: m.on > 0, 'aria-label': 'Module ' + m.title + ' on or off' });
      const word = h('span.pf-word', { text: m.on > 0 ? 'on' : 'off' });
      cb.addEventListener('change', () => toggle(m.id, cb.checked, $('#pf-modslot'), cb));
      head.appendChild(h('label.check.pf-modsw', cb, word));
    }
    box.appendChild(head);
    box.appendChild(h('p.small', { text: m.summary }));
    if (m.why) box.appendChild(h('p.small.muted', { text: 'Why the author uses it: ' + m.why }));
    box.appendChild(h('div.pf-slot#pf-modslot', { role: 'status' }));
    for (const it of m.items) box.appendChild(itemRow(it));
  }

  function itemRow(it) {
    const row = h('div.pf-item', { dataset: { id: it.id } });
    const slot = h('div.pf-slot', { role: 'status' });
    const top = h('div.pf-itop');
    if (it.locked) top.appendChild(h('span.pf-word.pf-always', { text: 'always on' }));
    else {
      const cb = h('input', { type: 'checkbox', checked: it.state === 'on', 'aria-label': it.title + ' on or off', dataset: { item: it.id } });
      cb.addEventListener('change', () => toggle(it.id, cb.checked, slot, cb));
      top.appendChild(h('label.check.pf-sw', cb, h('span.pf-word', { text: PF.stateWord(it) })));
    }
    const exp = h('button.pf-title', { type: 'button', 'aria-expanded': 'false', text: it.title });
    top.appendChild(exp);
    top.appendChild(h('span.pf-risk' + (it.risk === 'high' ? '.pf-high' : ''), { text: PF.riskWord(it.risk) }));
    const sw = PF.scopeWord(it);
    top.appendChild(h('span.pf-scope.small.muted', { text: sw || '' }));
    row.appendChild(top);
    const det = h('div.pf-det', { hidden: true },
      h('div', h('b', { text: 'Does: ' }), it.does),
      h('div', h('b', { text: 'Why the author uses it: ' }), it.why),
      h('div', h('b', { text: 'Needs: ' }), PF.listText(it.depends_on, byId), '   ', h('b', { text: 'Usually with: ' }), PF.listText(it.pairs_with, byId)),
      it.conflicts_with.length ? h('div', h('b', { text: 'Clashes with: ' }), PF.listText(it.conflicts_with, byId)) : null,
      h('div.pf-acts',
        h('button.small', { type: 'button', text: 'View', on: { click: () => viewItem(it.id, false) } }),
        h('button.small', { type: 'button', text: 'Diff', on: { click: () => diffItem(it.id) } }),
        h('button.small', { type: 'button', text: 'Edit', disabled: !(it.contributes || []).some((c) => c.template), on: { click: () => viewItem(it.id, true) } })));
    exp.addEventListener('click', () => { det.hidden = !det.hidden; exp.setAttribute('aria-expanded', det.hidden ? 'false' : 'true'); });
    row.appendChild(det);
    row.appendChild(slot);
    return row;
  }

  // Toggle with the inline confirm in the row's own fixed slot (no layout jump).
  async function toggle(id, on, slot, cb, confirm) {
    let r;
    try { r = await api('POST', '/api/profile/toggle', { id, on, confirm: !!confirm }); } catch (e) { if (cb) cb.checked = !on; U.note(slot, '[x] ' + e.message, true); return; }
    if (r.conflict) {
      if (cb) cb.checked = !on;
      slot.textContent = '';
      slot.appendChild(h('span', { text: '[?] Clashes with "' + r.conflict.b.title + '". Keep which? ' }));
      slot.appendChild(h('button.small', { type: 'button', text: 'Keep ' + r.conflict.a.title, title: r.conflict.a.why, on: { click: async () => { await api('POST', '/api/profile/toggle', { id: r.conflict.b.id, on: false, confirm: true }); await toggle(id, true, slot, null, true); } } }));
      slot.appendChild(h('button.small', { type: 'button', text: 'Keep ' + r.conflict.b.title, title: r.conflict.b.why, on: { click: () => { slot.textContent = ''; } } }));
      return;
    }
    if (r.needsConfirm) {
      if (cb) cb.checked = !on;
      slot.textContent = '';
      slot.appendChild(h('span', { text: r.line + '. ' }));
      slot.appendChild(h('button.small', { type: 'button', text: on ? 'Turn on all' : 'Turn off all', on: { click: () => toggle(id, on, slot, null, true) } }));
      slot.appendChild(h('button.small', { type: 'button', text: 'Cancel', on: { click: () => { slot.textContent = ''; } } }));
      return;
    }
    await load();
    rerender();
    // after "Turn on all" / "Keep ..." the slot button is gone: focus the toggled switch
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) {
      const t = document.querySelector('#pf-items input[data-item="' + CSS.escape(id) + '"]') || $('#pf-modtoggle');
      if (t) t.focus();
    }
  }

  // The View / Diff / Review / History pane: focus moves to its heading on open and
  // back to the button that opened it on close (UX-F11).
  let paneOpener = null;
  function paneOpen() {
    const pane = $('#pf-pane');
    const a = document.activeElement;
    if (a && a !== document.body && !pane.contains(a)) paneOpener = a;
    pane.hidden = false;
    return pane;
  }
  function paneClose() {
    const pane = $('#pf-pane');
    pane.hidden = true;
    const o = paneOpener;
    paneOpener = null;
    const back = o && o.isConnected && o.offsetParent ? o : $('#pf-review');
    if (back) back.focus();
  }
  function paneHead(title) {
    return h('div.pf-phead', h('h4', { tabindex: '-1', text: title }), h('button.small', { type: 'button', text: 'Close', on: { click: paneClose } }));
  }
  function paneFocus() { const t = $('#pf-pane .pf-phead h4'); if (t) t.focus(); }

  // View / edit pane: the module's .md and templates.
  async function viewItem(id, edit) {
    const pane = paneOpen();
    pane.textContent = '';
    let r;
    try { r = await api('GET', '/api/profile/item?id=' + encodeURIComponent(id)); } catch (e) { pane.appendChild(h('p.pf-bad', { text: e.message })); return; }
    pane.appendChild(paneHead((edit ? 'Edit: ' : 'View: ') + r.item.title));
    if (!r.templates.length) pane.appendChild(h('p.small.muted', { text: 'This item adds no template text (it sets a key, a variable or a task).' }));
    for (const t of r.templates) {
      pane.appendChild(h('div.small.muted', { text: t.template + ' - ' + (t.source === 'override' ? 'your edit' : 'shipped') }));
      if (!edit) { pane.appendChild(h('pre.mono.pf-tpl', { text: t.text })); continue; }
      const ta = h('textarea.mono.pf-ed', { spellcheck: 'false', 'aria-label': 'Template ' + t.template });
      ta.value = t.text;
      const line = h('p.small.pf-val', { role: 'status' });
      const check = async () => { try { const c = await api('POST', '/api/profile/check', { text: ta.value }); U.note(line, c.errors.length ? '[x] ' + c.errors[0] + (c.errors.length > 1 ? ' (+' + (c.errors.length - 1) + ' more)' : '') : '[+] plain text, known variables, no personal paths', c.errors.length > 0); } catch (e) { U.note(line, e.message, true); } };
      let tm = null;
      ta.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(check, 250); });
      const vars = h('ul.pf-vars', { 'aria-label': 'Variables (click to insert)' });
      for (const v of r.variables) vars.appendChild(h('li', h('button.small.mono', { type: 'button', text: '{' + v.name + '}', title: v.why || '', on: { click: () => { const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + '{' + v.name + '}' + ta.value.slice(ta.selectionEnd); ta.focus(); check(); } } })));
      pane.appendChild(h('div.pf-edwrap', ta, vars));
      pane.appendChild(line);
      pane.appendChild(h('div.dlg-actions',
        h('button', { type: 'button', text: 'Reset to shipped', on: { click: async () => { await api('POST', '/api/profile/edit', { id, template: t.template, reset: true }); viewItem(id, true); } } }),
        h('button', { type: 'button', text: 'Cancel', on: { click: paneClose } }),
        h('button.primary', { type: 'button', text: 'Save override', on: { click: async () => { try { await api('POST', '/api/profile/edit', { id, template: t.template, text: ta.value }); U.note(line, '[+] saved as your override (applies at the next apply)'); } catch (e) { U.note(line, '[x] ' + e.message, true); } } } })));
      check();
    }
    paneFocus();
  }

  async function diffItem(id) {
    const pane = paneOpen();
    pane.textContent = 'Planning...';
    try {
      const plan = await api('POST', '/api/profile/plan', { target: U.targetOf(target), only: [id] });
      pane.textContent = '';
      pane.appendChild(paneHead('Diff: ' + (byId[id] ? byId[id].title : id)));
      pane.appendChild(h('pre.mono.pf-tpl', { text: plan.diff || 'No change against the target.' }));
      paneFocus();
    } catch (e) { pane.textContent = e.message; }
  }

  // Review: the dry-run plan, typed acks for high-risk items, then Apply.
  async function review(values) {
    const pane = paneOpen();
    pane.textContent = 'Planning (dry run)...';
    values = values || {};
    let plan;
    try { plan = await api('POST', '/api/profile/plan', { target: U.targetOf(target), values }); } catch (e) { pane.textContent = e.message; return; }
    pane.textContent = '';
    // A value the plan needs (repo code, identity, ...) is asked right here, then re-planned.
    if (plan.missing && plan.missing.length) {
      const box = U.missingCard(plan, st.variables || [], values, (nv) => review(nv), {
        titleOf: (id) => (byId[id] ? byId[id].title : id),
        otherLine: (m) => (m.items.every((id) => byId[id] && !byId[id].locked) ? 'Or turn off the items that use it, then Review again.' : ''),
      });
      box.id = 'pf-missing';
      pane.appendChild(box);
    }
    const typed = {};
    const go = h('button.primary#pf-apply', { type: 'button', text: 'Apply' });
    const upd = () => { go.disabled = plan.empty || (plan.verdict && plan.verdict.code !== 0) || !PF.acksComplete(plan.highRisk, typed); };
    pane.insertBefore(paneHead('Review: ' + (target === 'user' || !$('#pf-target').selectedOptions[0] ? 'this user' : $('#pf-target').selectedOptions[0].textContent)), pane.firstChild);
    pane.appendChild(U.planView(plan, st.modules, { typedAcks: true, typed, onAck: upd, targetWord: 'Target' }));
    const res = h('div#pf-result', { role: 'status' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      res.textContent = '[>] applying...';
      try {
        const r = await api('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, acks: plan.highRisk.map((x) => x.id), typed });
        res.textContent = '';
        const miss = document.querySelector('#pf-missing');
        if (miss && r.ok) miss.remove();
        res.appendChild(h('p' + (r.ok ? '' : '.pf-bad'), { text: (r.ok ? '[+] ' : '[x] ') + PF.refusedLine(r.line, plan) }));
        if (r.ok) res.appendChild(U.verifyRows(r.verify, U.report));
        if (r.commit) res.appendChild(h('p.small.muted', { text: 'Nothing was committed. Suggested commit message: ' + r.commit.message }));
        if (!r.ok) res.appendChild(h('button.small', { type: 'button', text: 'Report a problem', on: { click: () => U.report({ id: 'apply', reason: r.line }) } }));
        await load();
        U.note($('#pf-line'), PF.pickLine(st.status.line));
      } catch (e) { res.textContent = '[x] ' + e.message; }
    });
    pane.appendChild(h('div.dlg-actions', go));
    pane.appendChild(res);
    upd();
    paneFocus();
  }

  async function history() {
    const pane = paneOpen();
    pane.textContent = '';
    const r = await api('GET', '/api/profile/tx');
    pane.appendChild(paneHead('History (applied changes)'));
    if (!r.tx.length) pane.appendChild(h('p.small.muted', { text: 'Nothing applied yet.' }));
    const res = h('p.small', { role: 'status' });
    for (const t of r.tx.slice().reverse()) {
      const row = h('div.pf-row.mono', { text: (t.reverted ? '[-] reverted ' : t.ok ? '[+] applied  ' : '[x] failed   ') + t.id + '  ' + t.written + ' write(s) ' });
      if (t.ok && !t.reverted) {
        row.appendChild(h('button.small', { type: 'button', text: 'Revert...', on: { click: async () => {
          const d = await api('POST', '/api/profile/revert', { tx: t.id });
          res.textContent = '';
          res.appendChild(h('span', { text: d.line + ' ' }));
          res.appendChild(h('button.small.danger', { type: 'button', text: 'Revert ' + t.id, on: { click: async () => { const x = await api('POST', '/api/profile/revert', { tx: t.id, confirm: true }); U.note(res, (x.ok ? '[+] ' : '[x] ') + x.line, !x.ok); await load(); rerender(); } } }));
        } } }));
      }
      pane.appendChild(row);
    }
    pane.appendChild(res);
    paneFocus();
  }

  function wire() {
    const dlg = $('#dlg-profile');
    if (!dlg) return;
    U.arrowNav($('#pf-mods'), 'button.pf-mod');
    $('#pf-target').addEventListener('change', () => { target = $('#pf-target').value; });
    $('#pf-review').addEventListener('click', () => review({}));
    $('#pf-tx').addEventListener('click', history);
    $('#pf-setup').addEventListener('click', () => { dlg.close(); if (window.CCSetupUI) window.CCSetupUI.open({}); });
    $('#pf-close').addEventListener('click', () => dlg.close());
  }
  window.CCProfileUI = { open: openBrowser, load, wire, get state() { return st; } };
})();

// ---------- adopt screens (dlg-adopt; lights up when the build has adopt) ----------
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const PF = window.CCProfile;
  const U = window.CCUI;
  const { h, api } = U;
  const $ = (s) => document.querySelector(s);
  let target = null;
  let last = null; // the last report answer {adoption, report}
  let adoption = null; // public adoption record (id, project, status, accepted, lastCheck)
  let picked = {};
  let phrases = {};

  async function openAdopt() {
    const dlg = $('#dlg-adopt');
    U.open(dlg);
    const body = $('#ad-body');
    body.textContent = '';
    U.note($('#ad-note'), '');
    let cap = { available: false };
    try { cap = await api('GET', '/api/profile/adopt'); } catch (e) { cap = { available: false }; }
    if (!cap.available) { body.appendChild(h('p.small', { text: '[-] Adopting a project needs the setup profile, which this build does not have. The rest of the console works without it.' })); return; }
    const sel = U.targetSelect('ad-target', (v) => { target = v; }, { projectsOnly: true, label: 'Project' });
    body.appendChild(h('p.small', { text: 'Adopt works on a copy of the project. Your original stays read-only until you promote the copy, and it is removed only by a separate, later step.' }));
    body.appendChild(h('div#ad-list'));
    body.appendChild(h('label', 'Project ', sel));
    body.appendChild(h('label', 'Leave out folders (comma separated) ', h('input#ad-exclude', { type: 'text', value: 'node_modules', autocomplete: 'off', spellcheck: 'false' })));
    body.appendChild(h('p.small.muted', { text: 'Folders at the top of the project, by name. They are not copied and the checks run without them; promoting the copy keeps them.' }));
    body.appendChild(h('p.small', { text: 'Copies the project into the console\'s data folder first, then scans the copy. Your project\'s files are not changed.' }));
    body.appendChild(h('div.dlg-actions', h('button.primary', { type: 'button', text: 'Copy and scan', on: { click: () => start() } })));
    body.appendChild(h('div#ad-out'));
    await loadList();
  }

  // R3-20: every adoption on disk stays reachable after the dialog closes.
  async function loadList() {
    const box = $('#ad-list');
    let r = null;
    try { r = await api('POST', '/api/profile/adopt', { op: 'list' }); } catch (e) { return; }
    if (!box || !r || !(r.adoptions || []).length) return;
    box.textContent = '';
    box.appendChild(h('h4', { text: 'Adoptions already started' }));
    for (const a of r.adoptions.slice().sort((x, y) => String(y.created).localeCompare(String(x.created)))) {
      box.appendChild(h('div.ad-row', h('span.ad-name', { text: a.project + ' (' + String(a.created || '').slice(0, 10) + ')' }), h('span.small.muted', { text: PF.adoptStatusWord(a.status) }),
        h('button.small', { type: 'button', text: 'Continue', dataset: { adoption: a.id }, on: { click: () => resumeAdoption(a.id) } })));
    }
  }

  async function resumeAdoption(id) {
    adoption = null;
    picked = {};
    phrases = {};
    const r = await call('load', { id });
    if (!r || !r.ok) return;
    last = r;
    // What was chosen before stays chosen: the defaults are for a first look only.
    const chosen = (r.adoption && r.adoption.accepted) || [];
    if (chosen.length) for (const c of (r.report && r.report.changes) || []) if (!c.reportOnly) picked[c.id] = chosen.includes(c.id);
    renderReport($('#ad-out'), r);
    await renderProgress(r.adoption || {});
  }

  // The step the adoption had reached: its next action, Promote and Remove original included.
  async function renderProgress(ad) {
    const st = $('#ad-step');
    if (ad.status === 'promoted' || ad.status === 'original-removed') {
      const row = $('#ad-apply-row');
      if (row) row.remove();
      st.appendChild(h('p.small', { text: PF.adoptStatusWord(ad.status) + ': the copy is your project now. To change more, start a new adoption.' }));
      if (ad.status === 'promoted') st.appendChild(removeBlock());
      return;
    }
    if ((ad.status === 'checked' || ad.status === 'confirmed') && ad.lastCheck) {
      st.appendChild(h('p.small', { text: 'Last function check: passed' + (ad.lastCheck.at ? ', ' + String(ad.lastCheck.at).slice(0, 10) : '') + '.' }));
      const out = h('div#ad-check');
      st.appendChild(out);
      renderCheck(out, { ok: true, result: { hash: ad.lastCheck.hash, verdict: ad.lastCheck.verdict, rows: [], bisect: [] } });
      out.appendChild(h('button', { type: 'button', text: 'Run the function check again', on: { click: () => runCheck() } }));
      return;
    }
    if (ad.status === 'applied' || ad.status === 'check-failed') {
      if (ad.status === 'check-failed') st.appendChild(h('p.small.pf-bad', { text: '[x] The last function check failed: promotion is blocked. Change what is ticked and apply again, or run the check again.' }));
      await proposeChecks(st);
    }
  }

  // One facade step; the answer is always {ok, code, line, ...}.
  async function call(op, extra) {
    U.note($('#ad-note'), '[>] ' + PF.opWord(op) + '...');
    let r;
    try { r = await api('POST', '/api/profile/adopt', Object.assign({ op }, adoption && op !== 'start' ? { id: adoption.id } : {}, extra || {})); } catch (e) { U.note($('#ad-note'), '[x] ' + e.message, true); return null; }
    U.note($('#ad-note'), (r.ok ? '[+] ' : '[x] ') + PF.opLine(op, r.line), !r.ok);
    if (r.adoption) adoption = r.adoption;
    return r;
  }

  async function start() {
    if (!target || target === 'user') { U.note($('#ad-note'), 'Pick a project.', true); return; }
    const ex = PF.excludeList(($('#ad-exclude') || {}).value);
    if (ex.bad.length) { U.note($('#ad-note'), '[x] Leave out folders takes names of top-level folders only, not paths: ' + ex.bad.join(', '), true); return; }
    adoption = null;
    picked = {};
    phrases = {};
    const r = await call('start', { project: target.slice(2), exclude: ex.list });
    if (r && r.ok) { last = r; renderReport($('#ad-out'), r); }
  }

  // R3-37: a change in words: its rule's title and file. The id stays in a title attribute.
  function changeName(id) {
    for (const mod of ((last && last.report) || {}).modules || []) {
      for (const rule of mod.items || []) {
        const ch = (rule.changes || []).find((x) => x.id === id);
        if (ch) return (rule.title || rule.item) + '  ' + PF.fileLine(ch);
      }
    }
    return id;
  }

  function renderReport(out, r) {
    out.textContent = '';
    const rep = (r && r.report) || { modules: [], counts: {}, local: [] };
    const c = rep.counts || {};
    out.appendChild(h('p.small', { text: 'Compared with your setup: ' + ['conforms', 'differs', 'missing', 'conflicts'].map((k) => (c[k] || 0) + ' ' + PF.adoptWord(k)).join(', ') + ((rep.local || []).length ? ', ' + rep.local.length + ' local (always kept)' : '') }));
    for (const mod of rep.modules || []) {
      const changes = [];
      for (const rule of mod.items || []) for (const ch of rule.changes || []) if (!ch.reportOnly) changes.push(ch);
      const msec = h('details.ad-module', { open: changes.length > 0 });
      msec.appendChild(h('summary', { text: (mod.title || mod.id) + ' (' + changes.length + ' change' + (changes.length === 1 ? '' : 's') + ')' }));
      if (changes.length) {
        const slot = h('div.pf-slot.ad-slot', { role: 'status' });
        const all = h('button.small', { type: 'button', text: 'Accept all for this module', on: { click: () => {
          const risky = changes.filter((x) => x.breakRisk && !x.blocked);
          if (risky.length && !all.dataset.second) { all.dataset.second = '1'; U.note(slot, 'Also accept ' + risky.length + ' change(s) with a break risk: ' + risky.map((x) => changeName(x.id)).join(', ') + '? Click Accept all again to confirm.'); return; }
          delete all.dataset.second;
          U.note(slot, '');
          for (const x of changes) { if (x.blocked) continue; picked[x.id] = true; const cb = msec.querySelector('input[data-change="' + CSS.escape(x.id) + '"]'); if (cb) cb.checked = true; }
        } } });
        msec.appendChild(all);
        msec.appendChild(slot);
      }
      for (const rule of mod.items || []) {
        const sec = h('details.ad-rule', { open: rule.status !== 'conforms' && rule.status !== 'off' && rule.status !== 'outside' });
        const real = (rule.changes || []).filter((x) => !x.reportOnly);
        sec.appendChild(h('summary', { text: PF.adoptGlyph(rule.status) + ' ' + PF.adoptWord(rule.status) + ' - ' + (rule.title || rule.item) + ' (' + real.length + ' change' + (real.length === 1 ? '' : 's') + ')' }));
        for (const n of rule.notes || []) sec.appendChild(h('div.small.muted', { text: 'Note: ' + n }));
        for (const ch of rule.changes || []) {
          const meta = h('span.small', { text: ch.reportOnly ? 'report only' : (ch.risk || 'low') + ' risk' + (ch.breakRisk ? ', ! break risk ' + PF.breakText(ch) : '') + (ch.blocked ? ', blocked: ' + ch.blocked : '') + (ch.conflict ? ', conflict: ' + ch.conflict : '') });
          if (ch.reportOnly) {
            sec.appendChild(h('div.ad-change.ad-ronly', h('span.mono', { text: '[-] ' + (rule.title || rule.item) + '  ' + PF.fileLine(ch), title: ch.id }), meta));
          } else {
            if (picked[ch.id] === undefined) picked[ch.id] = PF.adoptDefault(rule, ch);
            const cb = h('input', { type: 'checkbox', checked: picked[ch.id], disabled: !!ch.blocked, dataset: { change: ch.id }, 'aria-label': 'Change ' + (rule.title || rule.item) + ' ' + PF.fileLine(ch) + ' yes or no' });
            cb.addEventListener('change', () => { picked[ch.id] = cb.checked; });
            sec.appendChild(h('div.ad-change', h('label.check', cb, h('span.pf-word', { text: 'yes' })), h('span.mono', { text: (rule.title || rule.item) + '  ' + PF.fileLine(ch), title: ch.id }), meta));
            if (ch.needsPhrase) {
              const ph = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: ch.needsPhrase, dataset: { phrase: ch.item }, 'aria-label': 'High risk: type ' + ch.needsPhrase });
              ph.addEventListener('input', () => { phrases[ch.item] = ph.value; });
              sec.appendChild(h('label.small', 'High risk: type "' + ch.needsPhrase + '" ', ph));
            }
          }
          if (ch.why) sec.appendChild(h('div.small.muted', { text: 'Why: ' + ch.why }));
          const diff = (ch.files || []).map((f) => f.diff || '').filter(Boolean).join('');
          if (diff) sec.appendChild(h('pre.mono.ad-diff', { text: diff }));
        }
        msec.appendChild(sec);
      }
      out.appendChild(msec);
    }
    out.appendChild(h('div.dlg-actions#ad-apply-row',
      h('button.primary', { type: 'button', text: 'Apply chosen changes to the copy', on: { click: () => applyChosen() } })));
    out.appendChild(h('div#ad-step'));
  }

  async function applyChosen() {
    const rep = (last && last.report) || { changes: [] };
    const ids = Object.keys(picked).filter((k) => picked[k]);
    const byId = new Map((rep.changes || []).map((c) => [c.id, c]));
    const acks = [...new Set(ids.map((id) => byId.get(id)).filter((c) => c && c.needsPhrase && phrases[c.item] === c.needsPhrase).map((c) => c.item))];
    const breakConfirmed = ids.some((id) => byId.get(id) && byId.get(id).breakRisk);
    const ch = await call('choose', { accept: ids, acks, breakConfirmed });
    if (!ch) return;
    const st = $('#ad-step');
    st.textContent = '';
    for (const s of ch.skipped || []) st.appendChild(h('div.small', { text: '[-] not taken: ' + changeName(s.id) + ' - ' + s.why, title: s.id }));
    if (!ch.ids || !ch.ids.length) { st.appendChild(h('p.small', { text: 'Nothing chosen: the copy stays as the original.' })); return; }
    const ap = await call('apply', { confirm: true });
    if (!ap) return;
    st.appendChild(h('p.small' + (ap.ok ? '' : '.pf-bad'), { text: (ap.ok ? '[+] ' : '[x] ') + ap.line }));
    if (ap.ok) await proposeChecks(st);
  }

  // The project's own checks, detected, then confirmed by the user before they run.
  async function proposeChecks(st) {
    const r = await call('setChecks', { confirm: false });
    if (!r || !r.checks) return;
    const box = h('div#ad-checks');
    box.appendChild(h('p.small', { text: 'The project\'s own checks run on the original and on the copy, each in a throwaway folder:' }));
    for (const c of r.checks.list) box.appendChild(h('div.mono', { text: c.id + ': ' + c.cmd + '  (from ' + c.source + ')' }));
    if (!r.checks.list.length) box.appendChild(h('p.small', { text: 'No check found. Promotion stays blocked until a check passes.' }));
    box.appendChild(h('div.dlg-actions', h('button.primary', { type: 'button', text: 'Run the function check', disabled: !r.checks.list.length, on: { click: () => runCheck() } })));
    st.appendChild(box);
  }

  async function runCheck() {
    const ok = await call('setChecks', { confirm: true });
    if (!ok) return;
    const r = await call('check');
    if (!r) return;
    let out = $('#ad-check');
    if (!out) { out = h('div#ad-check'); $('#ad-step').appendChild(out); }
    renderCheck(out, r);
  }

  function renderCheck(out, r) {
    out.textContent = '';
    const res = (r && r.result) || { rows: [], bisect: [] };
    const tbl = h('table.ad-check', h('thead', h('tr', h('th', { text: 'Check' }), h('th', { text: 'Original' }), h('th', { text: 'Conformed copy' }), h('th', { text: 'Verdict' }))));
    const tb = h('tbody');
    for (const x of res.rows || []) tb.appendChild(h('tr' + (x.verdict === 'WORSE' ? '.pf-bad' : ''), h('td.mono', { text: x.id + ' (' + x.cmd + ')' }), h('td.mono', { text: PF.checkSide(x.original) }), h('td.mono', { text: PF.checkSide(x.copy) }), h('td.mono', { text: PF.verdictGlyph(x.verdict) + ' ' + (x.verdict || '-') })));
    tbl.appendChild(tb);
    if ((res.rows || []).length) out.appendChild(tbl);
    for (const x of res.rows || []) if (x.verdict === 'WORSE' && x.newlyFailing && x.newlyFailing.length) out.appendChild(h('div.small', { text: x.id + ' newly failing: ' + x.newlyFailing.join(', ') }));
    if (res.verdict === 'FAILED' || !r.ok) {
      out.appendChild(h('p.pf-bad', { text: '[x] Function check failed: promotion is blocked.' }));
      const culprits = [...new Set((res.bisect || []).flatMap((b) => b.culprits.map((c) => c.id)))];
      for (const id of culprits) {
        out.appendChild(h('button', { type: 'button', text: 'Revert change ' + changeName(id), title: id, dataset: { revert: id }, on: { click: async () => { const rv = await call('revert', { change: id, confirm: true }); if (rv && rv.ok) await runCheck(); } } }));
      }
      if (!culprits.length) out.appendChild(h('p.small', { text: 'Bisect could not name one change: untick changes and apply again.' }));
      return;
    }
    const hash = res.hash || '';
    out.appendChild(h('div.dlg-actions',
      h('button', { type: 'button', text: 'It works (copy ' + String(hash).slice(0, 12) + ')', on: { click: () => call('works', { word: 'works' }) } }),
      h('label', 'Promote by ', h('select#ad-method', h('option', { value: 'swap', text: 'folder swap' }), h('option', { value: 'git', text: 'git merge' }))),
      h('button.primary', { type: 'button', text: 'Make the conformed copy your project', on: { click: () => call('promote', { method: $('#ad-method').value, confirm: true }) } })));
    out.appendChild(removeBlock());
  }

  function removeBlock() {
    const name = adoption ? adoption.project : '';
    const phrase = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'remove original ' + name, 'aria-label': 'Type remove original ' + name });
    return h('details', h('summary', { text: 'Remove the original (later, separate, opt-in)' }),
      h('p.small', { text: 'Offered on a later run, at the earliest 24 h after promote. The original goes to the Recycle Bin or a zip archive; nothing is unlinked.' }),
      h('label', 'Method ', h('select#ad-rm', h('option', { value: 'recycle', text: 'Recycle Bin' }), h('option', { value: 'zip', text: 'zip archive' }))), phrase,
      h('button.danger', { type: 'button', text: 'Remove original', on: { click: () => call('removeOriginal', { phrase: phrase.value, method: $('#ad-rm').value, confirm: true }) } }));
  }

  function wire() {
    const c = $('#ad-close');
    if (c) c.addEventListener('click', () => $('#dlg-adopt').close());
  }
  window.CCAdoptUI = { open: openAdopt, wire, renderReport, renderCheck, get last() { return last; } };
})();

// ---------- machine-profile advisor (dlg-machine) ----------
(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const U = window.CCUI;
  const { h, api } = U;
  const $ = (s) => document.querySelector(s);
  let adv = null;
  let tx = null;

  async function openMachine() {
    U.open($('#dlg-machine'));
    const body = $('#mp-body');
    body.textContent = '';
    body.appendChild(h('p.small', { text: 'Reads hardware and Windows details into one file on this computer. Claude panes can read that file, so Claude may see it. Delete machine data removes it, to the Recycle Bin.' }));
    body.appendChild(h('p.small', { text: 'Suggest changes proposes changes. Every change is off until you tick it, is previewed first, backed up, read back and revertable.' }));
    body.appendChild(h('p.small.muted#mp-read-line', { role: 'status' }));
    body.appendChild(h('div.dlg-actions',
      h('button#mp-read', { type: 'button', text: 'Read machine', title: 'Read-only: nothing on the machine changes', on: { click: readMachine } }),
      h('button', { type: 'button', text: 'View machine data', on: { click: view } }),
      h('button.danger', { type: 'button', text: 'Delete machine data...', on: { click: del } }),
      h('button.primary#mp-advise', { type: 'button', text: 'Suggest changes', on: { click: advise } })));
    body.appendChild(h('div#mp-out'));
    api('GET', '/api/machine/read').then((r) => { readLine(r); }).catch(() => { readLine(null); });
  }

  // R3-14: Read machine moved here from Settings: the saved read, its date and its file.
  function readLine(r) {
    const n = $('#mp-read-line');
    if (!n) return;
    if (!r || !r.scanned) { n.textContent = 'Not read yet.' + (r && r.file ? ' The file would be ' + r.file : ''); return; }
    n.textContent = 'Read ' + String(r.scanned).slice(0, 10) + ': ' + (r.line || 'no details') + (r.file ? '. File: ' + r.file : '');
  }
  async function readMachine() {
    const b = $('#mp-read');
    const n = $('#mp-read-line');
    b.disabled = true;
    n.textContent = 'Reading the machine (read-only, about 10 s)...';
    try {
      const r = await api('POST', '/api/machine/read', {});
      if (r.ok) readLine(r);
      else n.textContent = r.error || 'Read machine failed.';
    } catch (e) { n.textContent = 'Read machine failed: ' + e.message; }
    b.disabled = false;
  }

  async function advise() {
    const out = $('#mp-out');
    out.textContent = '[>] reading...';
    try { adv = await api('POST', '/api/machine/advise', {}); } catch (e) { out.textContent = '[x] ' + e.message; return; }
    out.textContent = '';
    if (adv.findings && adv.findings.length) { out.appendChild(h('h4', { text: 'Findings (report only)' })); for (const f of adv.findings) out.appendChild(h('div.small', { text: '- ' + (window.CCProfile.findingText(f) || pairsText(f)) })); }
    out.appendChild(h('h4', { text: 'Proposed changes (' + (adv.proposals || []).length + ')' }));
    if (!(adv.proposals || []).length) out.appendChild(h('p.small.muted', { text: 'No change to propose.' }));
    for (const p of adv.proposals || []) {
      const cb = h('input', { type: 'checkbox', dataset: { prop: p.id }, 'aria-label': p.title + ' yes or no' });
      out.appendChild(h('div.mp-prop', h('label.check', cb, h('span.pf-word', { text: 'yes' })), h('span', { text: p.title + (p.app_title ? ' (' + p.app_title + ')' : '') }), h('span.small.muted', { text: p.why || '' })));
    }
    if (!(adv.proposals || []).length) return; // R3-40: no controls with nothing to act on
    const pv = h('div#mp-preview', { role: 'status' });
    out.appendChild(h('div.dlg-actions', h('button', { type: 'button', text: 'Preview selected', on: { click: () => preview(pv) } }), h('button.primary#mp-apply', { type: 'button', text: 'Apply selected', disabled: true, on: { click: () => apply(pv) } })));
    out.appendChild(pv);
  }
  const accepted = () => Array.from(document.querySelectorAll('#mp-out input[data-prop]')).filter((x) => x.checked).map((x) => x.dataset.prop);
  async function preview(pv) {
    const acc = accepted();
    pv.textContent = '';
    if (!acc.length) { U.note(pv, 'Tick at least one change.', true); return; }
    const r = await api('POST', '/api/machine/preview', { stamp: adv.stamp, accept: acc });
    for (const x of r.rows) pv.appendChild(h('div.mono', { text: (x.status === 'change' ? '[~] ' + x.label + ': ' + x.from + ' -> ' + x.to : x.status === 'same' ? '[+] ' + x.label + ': already ' + x.to : '[x] ' + x.label + ': refused - ' + x.reason) }));
    $('#mp-apply').disabled = false;
  }
  async function apply(pv) {
    const r = await api('POST', '/api/machine/apply', { stamp: adv.stamp, accept: accepted(), confirm: true });
    tx = r.tx;
    pv.appendChild(h('p' + (r.ok ? '' : '.pf-bad'), { text: r.ok ? '[+] applied (backup kept). Confirm the effect in the app.' : '[x] ' + (r.error || 'failed') }));
    if (r.ok && tx) pv.appendChild(h('button', { type: 'button', text: 'Revert this change', on: { click: async () => { const x = await api('POST', '/api/machine/revert', { tx, confirm: true }); pv.appendChild(h('p', { text: x.ok ? '[+] reverted' : '[x] ' + x.error })); } } }));
  }
  async function view() {
    const out = $('#mp-out');
    const d = await api('GET', '/api/machine/data');
    out.textContent = '';
    if (!(d.spec || d.inventory)) { out.appendChild(h('p.small', { text: 'No machine data stored.' })); return; }
    out.appendChild(pairsTable(d));
  }
  // Nested data as name / value rows (dotted names), never raw JSON (UX-N16).
  function flatPairs(o, pre, out) {
    out = out || [];
    if (o === null || typeof o !== 'object') { out.push([pre || 'value', String(o)]); return out; }
    const ents = Array.isArray(o) ? o.map((v, i) => [String(i + 1), v]) : Object.entries(o);
    if (!ents.length) out.push([pre || 'value', '-']);
    for (const [k, v] of ents) { const n = pre ? pre + '.' + k : k; if (v !== null && typeof v === 'object') flatPairs(v, n, out); else out.push([n, v === null || v === undefined ? '-' : String(v)]); }
    return out;
  }
  function pairsText(o) { return flatPairs(o).map(([k, v]) => k + ': ' + v).join(', '); }
  function pairsTable(o) {
    const tb = h('tbody');
    for (const [k, v] of flatPairs(o)) tb.appendChild(h('tr', h('td.mono', { text: k }), h('td.mono', { text: v })));
    return h('table.ad-check.mp-data', h('thead', h('tr', h('th', { text: 'Name' }), h('th', { text: 'Value' }))), tb);
  }
  async function del() {
    const out = $('#mp-out');
    out.textContent = '';
    out.appendChild(h('span', { text: 'Move the machine data folder to the Recycle Bin? ' }));
    out.appendChild(h('button.danger', { type: 'button', text: 'Delete machine data', on: { click: async () => { const r = await api('POST', '/api/machine/delete', { confirm: true }); out.textContent = r.recycled ? '[+] moved to the Recycle Bin' : '[-] ' + (r.reason || 'nothing to delete'); } } }));
  }
  function wire() {
    const c = $('#mp-close');
    if (c) c.addEventListener('click', () => $('#dlg-machine').close());
  }
  window.CCMachineUI = { open: openMachine, wire };
})();
