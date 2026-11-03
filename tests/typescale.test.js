'use strict';
// CON-UX-TYPESCALE: app-wide type scale. Six absolute px sizes (CON-SET-PX; was a base
// plus per-level offsets, migrated to the same rendered px) drive six CSS custom properties (header, subheader, body, secondary, mono, badges/meters);
// app.css takes every UI font size from them; the scale is stored per machine in
// data/settings.json (typeScale), reset restores the defaults; pane A-/A+ unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../public/app.js').Type;
const { sanitizeTypeScale, UI_DEFAULTS } = require('../server/uiprefs');

const PUB = path.join(__dirname, '..', 'public');
const css = () => fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');

test('default scale values (pre-scale sizes; header +1 px for CON-UX-TOPBAR)', () => {
  assert.deepStrictEqual(T.vars(T.DEFAULTS), {
    '--fs-header': '16px', '--fs-sub': '15px', '--fs-body': '15px', '--fs-secondary': '13px', '--fs-mono': '12px', '--fs-badge': '11.5px',
  });
});

test('client and server agree on the default scale', () => {
  assert.deepStrictEqual(T.DEFAULTS, UI_DEFAULTS.typeScale);
});

test('each level moves on its own', () => {
  const v0 = T.vars(T.DEFAULTS);
  for (const lv of T.LEVELS) {
    const s = Object.assign({}, T.DEFAULTS, { [lv]: T.DEFAULTS[lv] + 2 });
    const v = T.vars(s);
    for (const k of Object.keys(v0)) {
      if (k === '--fs-' + lv) assert.strictEqual(parseFloat(v[k]), parseFloat(v0[k]) + 2, k);
      else assert.strictEqual(v[k], v0[k], lv + ' moved ' + k);
    }
  }
});

test('normalize: garbage and missing levels fall back, values are clamped to 8..32 px', () => {
  assert.deepStrictEqual(T.normalize(null), T.DEFAULTS);
  assert.deepStrictEqual(T.normalize({ header: 99, mono: 2, body: 'x', bogus: 1 }), Object.assign({}, T.DEFAULTS, { header: 32, mono: 8 }));
  assert.strictEqual(T.normalize({ secondary: 12.26 }).secondary, 12.5, 'half-pixel steps');
  assert.ok(!('base' in T.normalize({})), 'no base level any more');
});

test('CON-SET-PX: a legacy saved scale (base + offsets) converts to the same rendered px', () => {
  const legacy = { base: 15, header: 1, sub: 0, body: 0, secondary: -2, mono: -3, badge: -3.5 };
  assert.deepStrictEqual(T.normalize(legacy), T.DEFAULTS);
  assert.deepStrictEqual(T.normalize({ base: 17, header: 2, mono: 'x' }), { header: 19, sub: 17, body: 17, secondary: 15, mono: 14, badge: 13.5 });
  // the old render floor (8px) and offset clamp (+-8) still hold for an old file
  assert.strictEqual(T.normalize({ base: 10, mono: -8 }).mono, 8);
  assert.strictEqual(T.normalize({ base: 15, header: 99 }).header, 23);
  // the rendered vars of a legacy scale equal what the old offset code produced
  const old = (s) => Object.fromEntries(T.LEVELS.map((lv) => ['--fs-' + lv, Math.max(8, s.base + s[lv]) + 'px']));
  assert.deepStrictEqual(T.vars(legacy), old(legacy));
});

test('server sanitizer matches the client normalize', () => {
  for (const s of [null, 'x', { base: 18, header: 3 }, { base: 'x', header: 99, mono: -99, bogus: 1 }, { secondary: 12.26 }, { header: 40, mono: 3 }, { base: 15, header: 1, sub: 0, body: 0, secondary: -2, mono: -3, badge: -3.5 }]) {
    assert.deepStrictEqual(sanitizeTypeScale(s), T.normalize(s), JSON.stringify(s));
  }
});

test('app.css: no fixed px font sizes left; every UI size reads a level', () => {
  const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
  const fixed = src.split('\n').filter((l) => /font-size:\s*[\d.]+px/.test(l) || /\bfont:\s*(\d+\s+)?[\d.]+px/.test(l));
  assert.deepStrictEqual(fixed, []);
  for (const lv of T.LEVELS) assert.match(src, new RegExp('var\\(--fs-' + lv + '\\)'), lv + ' level is used');
  // the :root fallbacks equal the default scale, so the page looks right before JS runs
  const v = T.vars(T.DEFAULTS);
  for (const [k, px] of Object.entries(v)) assert.match(src, new RegExp(k + ':\\s*' + px.replace('.', '\\.') + ';'), k);
  assert.ok(!/--ui-size/.test(src), 'the flat --ui-size is gone');
});

test('Settings: one px input per level (no base, no offsets) and a reset button; pane A-/A+ kept', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<fieldset[^>]*id="set-type"/);
  assert.doesNotMatch(html, /name="ts-base"/);
  assert.doesNotMatch(html, /offsets from the base/);
  assert.match(html, /Text size in px/);
  for (const lv of T.LEVELS) assert.match(html, new RegExp('name="ts-' + lv + '" type="number" min="8" max="32"'), lv);
  assert.match(html, /id="ts-reset"/);
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(js, /menu\(fr, 'A-'/);
  assert.match(js, /menu\(fr, 'A\+'/);
});

// CON-UX-TOPBAR (accept case of the type scale): the top row is slightly larger by
// default - header level +1 px over the base, the usage and resource meters one px
// over the badges level, and roomier top-bar buttons and meter chips.
test('CON-UX-TOPBAR: larger top row by default', () => {
  const v = T.vars(T.DEFAULTS);
  assert.strictEqual(parseFloat(v['--fs-header']), parseFloat(v['--fs-body']) + 1);
  const src = css();
  assert.match(src, /#topbar \{ font-size: var\(--fs-header\);/);
  assert.match(src, /#usage-strip \{[^}]*font-size: calc\(var\(--fs-badge\) \+ 1px\)/);
  assert.match(src, /#res-strip \{[^}]*font-size: calc\(var\(--fs-badge\) \+ 1px\)/);
  assert.match(src, /#topbar \.top-actions > button \{ padding: 5px 12px; \}/);
  assert.match(src, /#res-items \.res-item \{[^}]*padding: 2px 6px;/);
});
