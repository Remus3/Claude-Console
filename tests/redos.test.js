'use strict';
// CON-SEC: trailing-separator trims run in linear time (CodeQL js/polynomial-redos,
// public alerts 1 and 2). A run of separators followed by another character must
// not make the trim quadratic.
const test = require('node:test');
const assert = require('node:assert');
const { labelFromPath } = require('../server/tools');
const { norm, trimTrailingSlashes } = require('../server/discovery');

const N = 60000;

test('labelFromPath still strips trailing separators', () => {
  assert.strictEqual(labelFromPath('C:\\x\\foo.txt\\\\//', false), 'foo');
  assert.strictEqual(labelFromPath('C:/x/Dir///', true), 'Dir');
  assert.strictEqual(labelFromPath('', false), '');
});

test('labelFromPath is linear on many separators', () => {
  const t0 = Date.now();
  assert.strictEqual(labelFromPath('/'.repeat(N) + 'a', false), 'a');
  assert.strictEqual(labelFromPath('\\/'.repeat(N) + 'a.b', false), 'a');
  assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + ' ms');
});

test('trimTrailingSlashes is linear and exact', () => {
  assert.strictEqual(trimTrailingSlashes('c:/a/b///'), 'c:/a/b');
  assert.strictEqual(trimTrailingSlashes('///'), '');
  assert.strictEqual(trimTrailingSlashes('c:/a'), 'c:/a');
  const t0 = Date.now();
  assert.strictEqual(trimTrailingSlashes('/'.repeat(N) + 'x'), '/'.repeat(N) + 'x');
  assert.ok(Date.now() - t0 < 500, 'took ' + (Date.now() - t0) + ' ms');
});

test('norm keeps its shape', () => {
  const n = norm(__dirname + '\\');
  assert.ok(!n.endsWith('/'));
  assert.strictEqual(n, n.toLowerCase());
  assert.ok(!n.includes('\\'));
});
