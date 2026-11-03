'use strict';
// CON-SCROLLBACK: the server's replay ring (what a page reload or reconnect rebuilds a
// pane from) follows the Settings scrollback lines instead of a fixed 400 KB, which held
// only a few minutes of a busy claude pane (measured 2026-10-25: two live panes had both
// filled 400 KB, 37 and 143 minutes old, no alternate screen and no clear-scrollback).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { PaneManager, Pane, ringBytesFor, RING_BYTES_PER_LINE, RING_MAX_BYTES } = require('../server/panes');

test('ring bytes: lines x bytes-per-line, floored at cfg.scrollbackBytes, capped', () => {
  assert.strictEqual(RING_BYTES_PER_LINE, 200);
  assert.strictEqual(ringBytesFor(9000, 400000), 1800000);
  assert.strictEqual(ringBytesFor(1000, 400000), 400000, 'never below the config floor');
  assert.strictEqual(ringBytesFor(100000, 400000), RING_MAX_BYTES);
});

test('setRingLines sizes new and open panes; push trims to the new size', () => {
  const m = new PaneManager({ scrollbackBytes: 1000 }, {});
  clearInterval(m.timer);
  const p = new Pane({ kind: 'shell', cwd: '.' }, m);
  m.panes.set('x', p);
  assert.strictEqual(p.maxBytes, 1000);
  assert.strictEqual(m.setRingLines(9000), 1800000);
  assert.strictEqual(p.maxBytes, 1800000);
  const q = new Pane({ kind: 'shell', cwd: '.' }, m);
  assert.strictEqual(q.maxBytes, 1800000, 'a new pane takes the current size');
  m.setRingLines(1);
  for (let i = 0; i < 20; i++) p.push('x'.repeat(100));
  assert.ok(p.bufBytes <= 1000, String(p.bufBytes));
  assert.strictEqual(m.setRingLines(NaN), ringBytesFor(10000, 1000), 'bad input = the default 10000 lines');
});

test('server wires the ring to Settings (start and every PUT); the label is honest', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(src, /panes\.setRingLines\(settings\(\)\.scrollback\)/);
  assert.match(src, /panes\.setRingLines\(saved\.scrollback\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="sb-note"[^>]*>Scrollback: how many lines each pane keeps to scroll back through\. After a reload a busy pane may come back with fewer\. \/clear empties it\./);
});
