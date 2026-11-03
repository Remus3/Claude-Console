'use strict';
// R1-13: the server's window opener. Nothing is started: spawn and the Edge search are
// injected, so no browser and no cmd.exe run here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { openWindow } = require('../server/server');
const { tmpdir } = require('./helpers');

function fake() {
  const calls = [];
  return { calls, spawn: (file, args, opts) => { calls.push({ file, args, opts }); return { unref() {} }; } };
}

test('openWindow: the configured Edge when it still exists', () => {
  const edge = path.join(tmpdir('cc-open-'), 'msedge.exe');
  fs.writeFileSync(edge, '');
  const f = fake();
  openWindow({ edgePath: edge, runDir: tmpdir('cc-open-') }, 7811, 'tok', { spawn: f.spawn, findEdge: () => { throw new Error('not searched'); } });
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].file, edge);
  assert.ok(f.calls[0].args.includes('--app=http://127.0.0.1:7811/#t=tok'));
});

test('openWindow: an Edge installed after the console is found', () => {
  const f = fake();
  openWindow({ edgePath: path.join(tmpdir('cc-open-'), 'gone.exe'), runDir: tmpdir('cc-open-') }, 7811, 'tok', { spawn: f.spawn, findEdge: () => 'C:\\later\\msedge.exe' });
  assert.strictEqual(f.calls[0].file, 'C:\\later\\msedge.exe');
});

test('openWindow: no Edge opens the default browser, the plain tab the docs promise', () => {
  const f = fake();
  openWindow({ edgePath: null, runDir: tmpdir('cc-open-') }, 7811, 'a&b', { spawn: f.spawn, findEdge: () => null });
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].file, 'cmd.exe');
  assert.deepStrictEqual(f.calls[0].args, ['/c', 'start', '', 'http://127.0.0.1:7811/#t=a^&b']);
  assert.strictEqual(f.calls[0].opts.windowsHide, true);
  assert.strictEqual(f.calls[0].opts.detached, true);
});
