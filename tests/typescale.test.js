'use strict';
// CON-UX-TYPESCALE: app-wide type scale. One base size plus a per-level offset drives
// six CSS custom properties (header, subheader, body, secondary, mono, badges/meters);
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

test('each level moves on its own; the base moves them all', () => {
  const v0 = T.vars(T.DEFAULTS);
  for (const lv of T.LEVELS) {
    const s = Object.assign({}, T.DEFAULTS, { [lv]: T.DEFAULTS[lv] + 2 });
    const v = T.vars(s);
    for (const k of Object.keys(v0)) {
      if (k === '--fs-' + lv) assert.strictEqual(parseFloat(v[k]), parseFloat(v0[k]) + 2, k);
      else assert.strictEqual(v[k], v0[k], lv + ' moved ' + k);
    }
  }
  const up = T.vars(Object.assign({}, T.DEFAULTS, { base: T.DEFAULTS.base + 1 }));
  for (const k of Object.keys(v0)) assert.strictEqual(parseFloat(up[k]), parseFloat(v0[k]) + 1, k);
});

test('normalize: garbage and missing levels fall back, values are clamped', () => {
  assert.deepStrictEqual(T.normalize(null), T.DEFAULTS);
  assert.deepStrictEqual(T.normalize({ base: 'x', header: 99, mono: -99, bogus: 1 }), Object.assign({}, T.DEFAULTS, { header: 8, mono: -8 }));
  assert.strictEqual(T.normalize({ base: 3 }).base, 10);
  assert.strictEqual(T.normalize({ base: 300 }).base, 24);
  assert.strictEqual(T.normalize({ secondary: -1.26 }).secondary, -1.5, 'half-pixel steps');
  // a level never renders below 8px
  assert.strictEqual(T.vars({ base: 10, header: 0, sub: 0, body: 0, secondary: -8, mono: -8, badge: -8 })['--fs-mono'], '8px');
});

test('server sanitizer matches the client normalize', () => {
  for (const s of [null, 'x', { base: 18, header: 3 }, { base: 'x', header: 99, mono: -99, bogus: 1 }, { secondary: -1.26 }]) {
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

test('Settings: one input per level, a base input and a reset button; pane A-/A+ kept', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<fieldset[^>]*id="set-type"/);
  assert.match(html, /name="ts-base"/);
  for (const lv of T.LEVELS) assert.match(html, new RegExp('name="ts-' + lv + '"'), lv);
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
