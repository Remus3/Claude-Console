'use strict';
// Console UI preferences kept per machine in data/settings.json (S49 operator intake,
// CON-UX-*). Each value is sanitized on read and on PUT, so a hand-edited or stale
// settings file never breaks the page. The client (public/app.js) holds the same
// defaults; tests/typescale.test.js pins the two together.

// CON-UX-TYPESCALE: one base size (px) plus a per-level offset (px, half-pixel steps).
const TYPE_LEVELS = ['header', 'sub', 'body', 'secondary', 'mono', 'badge'];
const TYPE_DEFAULTS = { base: 15, header: 1, sub: 0, body: 0, secondary: -2, mono: -3, badge: -3.5 };

// CON-UX-PANEROWS: pane / card workflow rows - row count (0 hides) and shown states.
const FLOW_STATES = ['running', 'stale', 'failed', 'pending', 'idle', 'done'];
const FLOW_ROWS_DEFAULT = 6;
const FLOW_STATES_DEFAULT = { running: true, stale: true, failed: true, pending: true, idle: true, done: false };

// CON-UX-KEYS: one show flag per pane key-strip button (ids as in app.js CCKeys.KEYS),
// and the quick chips as a list of { text, on } (was a comma-split string list).
const KEY_IDS = ['esc', 'ctrlc', 'enter', 'ctrlx', 'stab', 'up', 'down', 'left', 'right'];
const CHIPS_DEFAULT = [{ text: 'continue', on: true }, { text: '/done', on: true }, { text: '/clear', on: true }];

const UI_DEFAULTS = {
  typeScale: TYPE_DEFAULTS,
  flowRows: FLOW_ROWS_DEFAULT,
  flowStates: FLOW_STATES_DEFAULT,
  keyStrip: Object.fromEntries(KEY_IDS.map((k) => [k, true])),
  quickChips: CHIPS_DEFAULT,
};

function sanitizeKeyStrip(v) {
  const s = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of KEY_IDS) out[k] = typeof s[k] === 'boolean' ? s[k] : true;
  return out;
}
function sanitizeChips(v) {
  if (v === undefined) return CHIPS_DEFAULT.map((c) => Object.assign({}, c));
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

function sanitizeFlowRows(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : FLOW_ROWS_DEFAULT;
  return Math.max(0, Math.min(12, n));
}
function sanitizeFlowStates(v) {
  const s = v && typeof v === 'object' ? v : {};
  const out = {};
  for (const k of FLOW_STATES) out[k] = typeof s[k] === 'boolean' ? s[k] : FLOW_STATES_DEFAULT[k];
  return out;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function half(v) {
  return Math.round(v * 2) / 2;
}

function sanitizeTypeScale(v) {
  const s = v && typeof v === 'object' ? v : {};
  const out = {};
  const b = num(s.base);
  out.base = b === null ? TYPE_DEFAULTS.base : Math.max(10, Math.min(24, half(b)));
  for (const lv of TYPE_LEVELS) {
    const o = num(s[lv]);
    out[lv] = o === null ? TYPE_DEFAULTS[lv] : Math.max(-8, Math.min(8, half(o)));
  }
  return out;
}

// Applied to the merged settings object (defaults + file + PUT body).
function sanitizeUiPrefs(s) {
  s.typeScale = sanitizeTypeScale(s.typeScale);
  s.flowRows = sanitizeFlowRows(s.flowRows);
  s.flowStates = sanitizeFlowStates(s.flowStates);
  s.keyStrip = sanitizeKeyStrip(s.keyStrip);
  s.quickChips = sanitizeChips(s.quickChips);
  return s;
}

module.exports = {
  UI_DEFAULTS, TYPE_LEVELS, FLOW_STATES, KEY_IDS,
  sanitizeTypeScale, sanitizeFlowRows, sanitizeFlowStates, sanitizeKeyStrip, sanitizeChips, sanitizeUiPrefs,
};
