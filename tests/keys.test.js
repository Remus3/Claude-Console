'use strict';
// CON-UX-KEYS (S49 intake): one Settings checkbox per pane key-strip button (Esc, ^C,
// Enter, S-Tab, arrows) plus a NEW Ctrl-X button; an unchecked button is hidden. The
// comma-separated quick chips become a list: toggle, edit, remove, add. Both stored per
// machine in data/settings.json. Ctrl-X: the installed claude.exe keymap has no bare
// Ctrl-X action - Ctrl-X is a chord prefix and "ctrl+x ctrl+s" is chat:sendNow (send the
// typed / queued message now), so the button sends Ctrl-X then Ctrl-S as two key events.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const K = require('../public/app.js').Keys;
const { sanitizeKeyStrip, sanitizeChips, UI_DEFAULTS } = require('../server/uiprefs');

const PUB = path.join(__dirname, '..', 'public');

test('key strip: the eight existing keys in order plus Ctrl-X (send now chord)', () => {
  assert.deepStrictEqual(K.KEYS.map((k) => k.id), ['esc', 'ctrlc', 'enter', 'ctrlx', 'stab', 'up', 'down', 'left', 'right']);
  const seq = Object.fromEntries(K.KEYS.map((k) => [k.id, k.seq]));
  assert.deepStrictEqual(seq.esc, ['\x1b']);
  assert.deepStrictEqual(seq.ctrlc, ['\x03']);
  assert.deepStrictEqual(seq.ctrlx, ['\x18', '\x13']);
  assert.deepStrictEqual(seq.left, ['\x1b[D']);
  const x = K.KEYS.find((k) => k.id === 'ctrlx');
  assert.strictEqual(x.label, '^X^S');
  assert.match(x.title, /Ctrl\+X Ctrl\+S/);
  assert.match(x.title, /send/i);
  for (const k of K.KEYS) assert.ok(/^[\x20-\x7e]*$/.test(k.title), k.id + ' title ASCII');
  assert.deepStrictEqual(K.KEYS.slice(-4).map((k) => k.label), ['\u2191', '\u2193', '\u2190', '\u2192']);
});

test('public sources stay ASCII (arrow labels as \\u escapes)', () => {
  for (const f of ['app.js', 'app.css', 'index.html']) {
    const b = fs.readFileSync(path.join(PUB, f));
    assert.ok(b.every((x) => x < 128), f + ' has a non-ASCII byte');
  }
});

test('key strip settings: every key shown by default; garbage falls back; client = server', () => {
  const all = Object.fromEntries(K.KEYS.map((k) => [k.id, true]));
  assert.deepStrictEqual(K.normalizeStrip(null), all);
  assert.deepStrictEqual(UI_DEFAULTS.keyStrip, all);
  const s = { esc: false, up: 'no', bogus: false };
  assert.deepStrictEqual(K.normalizeStrip(s), Object.assign({}, all, { esc: false }));
  assert.deepStrictEqual(sanitizeKeyStrip(s), K.normalizeStrip(s));
});

test('quick chips: list of { text, on }; old comma-split strings migrate; client = server', () => {
  assert.deepStrictEqual(UI_DEFAULTS.quickChips, [{ text: 'continue', on: true }, { text: '/done', on: true }, { text: '/clear', on: true }]);
  assert.deepStrictEqual(K.normalizeChips(['continue', '  /done ', '']), [{ text: 'continue', on: true }, { text: '/done', on: true }]);
  assert.deepStrictEqual(K.normalizeChips([{ text: 'go', on: false }, { text: 'x\u0007y', on: true }, { on: true }, 7]), [{ text: 'go', on: false }, { text: 'x y', on: true }]);
  assert.strictEqual(K.normalizeChips(Array.from({ length: 30 }, (_, i) => 'c' + i)).length, 12);
  assert.strictEqual(K.normalizeChips(['x'.repeat(500)])[0].text.length, 200);
  assert.deepStrictEqual(K.normalizeChips('nope'), []);
  for (const v of [null, ['a', { text: 'b', on: false }], [{ text: 'x\u0007y' }]]) assert.deepStrictEqual(sanitizeChips(v), K.normalizeChips(v), JSON.stringify(v));
  assert.deepStrictEqual(K.normalizeChips(undefined), UI_DEFAULTS.quickChips, 'absent = defaults');
});

test('Settings: one checkbox per key, a chip list with add; no comma-separated input', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<fieldset[^>]*id="set-keys"/);
  for (const k of K.KEYS) assert.match(html, new RegExp('<input type="checkbox" name="key-' + k.id + '"'), k.id);
  assert.match(html, /<ul id="set-chips"/);
  assert.match(html, /id="chip-add"/);
  assert.ok(!/comma separated/i.test(html));
  assert.ok(!/name="quickChips"/.test(html));
});
