'use strict';
// CON-TASKKILL: `taskkill /T` followed reused parent pids into unrelated processes (the
// 0.1.3 suite's silent whole-file exits). installer/safekill.js ends only VERIFIED
// descendants (created at or after their parent) of a root created at or after the spawn.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const S = require('../installer/safekill');

const ROWS = [
  { pid: 100, ppid: 1, created: 1000 }, // our spawned shell (root)
  { pid: 101, ppid: 100, created: 1100 }, // its real child
  { pid: 102, ppid: 101, created: 1200 }, // grandchild
  { pid: 200, ppid: 100, created: 500 }, // UNRELATED: its old parent 100 died, pid reused by our root
  { pid: 201, ppid: 200, created: 600 }, // and that one's child
  { pid: 300, ppid: 7, created: 1300 },
];

test('verified tree: real descendants only; a process older than its "parent" is pid reuse', () => {
  assert.deepStrictEqual(S.verifiedTree(ROWS, 100, 1000), [100, 101, 102]);
  assert.deepStrictEqual(S.verifiedTree(ROWS, 101, 0), [101, 102]);
});

test('a root created before our spawn is a reused pid: nothing is killed; a gone root: nothing', () => {
  assert.deepStrictEqual(S.verifiedTree(ROWS, 100, 1000 + S.SLACK_MS + 1), []);
  assert.deepStrictEqual(S.verifiedTree(ROWS, 999, 0), []);
});

test('killTreeSync ends each verified pid alone, deepest first, root last; no process list = the root only', () => {
  const killed = [];
  const out = S.killTreeSync(100, 1000, { list: () => ROWS, kill: (p) => { killed.push(p); return true; } });
  assert.deepStrictEqual(killed, [102, 101, 100]);
  assert.deepStrictEqual(out, [102, 101, 100]);
  const k2 = [];
  S.killTreeSync(100, 0, { list: () => null, kill: (p) => { k2.push(p); return true; } }); // no spawn time given
  assert.deepStrictEqual(k2, [100]);
});

test('async killTree: same rule', async () => {
  const killed = [];
  await S.killTree(100, 1000, { list: async () => ROWS, kill: async (p) => { killed.push(p); return true; } });
  assert.deepStrictEqual(killed, [102, 101, 100]);
});

test('parse: pid|ppid|created lines; garbage -> null', () => {
  assert.deepStrictEqual(S.parseList('4|0|0\r\n11|4|1790000000000\nnoise\n'), [{ pid: 4, ppid: 0, created: 0 }, { pid: 11, ppid: 4, created: 1790000000000 }]);
  assert.strictEqual(S.parseList('nope'), null);
});

test('no taskkill /T anywhere in the console tree (code, scripts, packaged kit, templates)', () => {
  const root = path.join(__dirname, '..');
  const skip = new Set(['node_modules', '.git', 'run', 'drops', 'tests']);
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(p); continue; }
      const array = /\.(js|cjs|mjs|py)$/i.test(e.name); // an argument list: ['/PID', p, '/T', '/F']
      const shell = /\.(ps1|cmd|bat|sh|vbs)$/i.test(e.name); // a command line, comments aside
      if (!array && !shell) continue;
      fs.readFileSync(p, 'utf8').split('\n').forEach((l, i) => {
        const bad = array ? /['"]\/T['"]/.test(l) : (!/^\s*(#|rem\b|')/i.test(l) && /taskkill[^\n]*\s\/T\b/i.test(l));
        if (bad) hits.push(path.relative(root, p) + ':' + (i + 1));
      });
    }
  };
  walk(root);
  assert.deepStrictEqual(hits, []);
  assert.match(fs.readFileSync(path.join(root, 'installer', 'profile-funcheck.js'), 'utf8'), /killTree\(child\.pid, t0\)/);
});

test('real process (Windows): a spawned node tree ends, this test process survives', { skip: process.platform !== 'win32' }, async () => {
  const t0 = Date.now();
  const child = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)"], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const ended = S.killTreeSync(child.pid, t0);
  assert.ok(ended.includes(child.pid), 'root ended');
  assert.ok(ended.length >= 2, 'its child ended too: ' + ended.join(','));
  assert.ok(!ended.includes(process.pid) && !ended.includes(process.ppid));
  await new Promise((r) => child.once('exit', r));
});
