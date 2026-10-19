'use strict';
// CON-RES: the top-bar resource readout. Sampler line parsing, Task Manager
// semantics (RAM in use, drive active time, NET of link speed), fail-soft '--',
// the long-lived child's lifecycle (spawned only while a page is connected, killed
// on stop and on close), the token-gated API and the pure page model.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const R = require('../server/resources');
const RS = require('../public/app.js').Res;
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const GB = 1024 * 1024 * 1024;
const fakeOs = { totalmem: () => 32 * GB, freemem: () => 8 * GB };
const fakeStatfs = (p) => {
  if (p === 'C:\\') return { bsize: 4096, blocks: 1000, bavail: 250 };
  if (p === 'E:\\') return { bsize: 4096, blocks: 1000, bavail: 1000 };
  throw new Error('ENOENT');
};
const LINE = '{"cpu":12.6,"gpu":140,"disks":[{"l":"C","a":3.4},{"l":"DE","a":-0.2}],"net":{"pct":0.01,"rx":1000,"tx":2000,"bw":2500000000}}';

function fakeChild() {
  const ch = new EventEmitter();
  ch.stdout = new EventEmitter();
  ch.stdout.setEncoding = () => {};
  ch.killed = false;
  ch.kill = () => { ch.killed = true; setImmediate(() => ch.emit('exit', null)); };
  return ch;
}

test('sampler line: percents clamped to 0..100, multi-letter disks split, bad JSON is null', () => {
  const p = R.parseLine(LINE);
  assert.strictEqual(p.cpu, 13);
  assert.strictEqual(p.gpu, 100);
  assert.deepStrictEqual(p.disks, { C: 3, D: 0, E: 0 });
  assert.deepStrictEqual(p.net, { pct: 0, rx: 1000, tx: 2000, bw: 2500000000 });
  assert.strictEqual(R.parseLine('not json'), null);
  assert.strictEqual(R.parseLine('[1]'), null);
  const q = R.parseLine('{"cpu":null,"gpu":"x","disks":"no","net":null}');
  assert.deepStrictEqual(q, { cpu: null, gpu: null, disks: {}, net: null });
});

test('RAM = in use / total physical; capacity only for letters that exist', () => {
  assert.strictEqual(R.ramPct(fakeOs), 75);
  assert.strictEqual(R.ramPct({ totalmem: () => 0, freemem: () => 0 }), null);
  const c = R.capacities(fakeStatfs, R.LETTERS);
  assert.deepStrictEqual(Object.keys(c), ['C', 'E']);
  assert.strictEqual(c.C.used, 75);
  assert.strictEqual(c.E.used, 0);
});

test('child lifecycle: spawned while viewed, lines published, stale = --, killed when idle and on stop', async () => {
  let t = 1000000;
  const kids = [];
  const snaps = [];
  let viewers = 1;
  const s = new R.ResourceSampler({ resources: { idleStopSec: 5, staleSec: 3 } }, {
    spawn: (file, args, o) => {
      assert.match(file, /powershell\.exe$/i);
      assert.ok(args.includes('-File') && args.includes(R.SCRIPT));
      assert.strictEqual(o.windowsHide, true);
      assert.strictEqual(o.shell, false);
      const ch = fakeChild();
      kids.push(ch);
      return ch;
    },
    os: fakeOs, statfs: fakeStatfs, now: () => t, viewers: () => viewers, onSnap: (x) => snaps.push(x), parentPid: 4242,
  });
  assert.ok(fs.existsSync(R.SCRIPT));
  // nothing runs before a page has looked
  viewers = 0;
  s.tick();
  assert.strictEqual(kids.length, 0);
  viewers = 1;
  s.tick();
  assert.strictEqual(kids.length, 1);
  assert.ok(kids[0].stdout);
  // before the first line: RAM known, counters '--'
  let last = snaps[snaps.length - 1];
  assert.strictEqual(last.live, false);
  assert.strictEqual(last.ram, 75);
  assert.strictEqual(last.cpu, null);
  assert.deepStrictEqual(last.drives.map((d) => d.letter), ['C', 'E']);
  // a line split across chunks
  kids[0].stdout.emit('data', LINE.slice(0, 20));
  kids[0].stdout.emit('data', LINE.slice(20) + '\n');
  last = snaps[snaps.length - 1];
  assert.strictEqual(last.live, true);
  assert.strictEqual(last.cpu, 13);
  assert.strictEqual(last.gpu, 100);
  assert.deepStrictEqual(last.drives.map((d) => [d.letter, d.active, d.used]), [['C', 3, 75], ['E', 0, 0]]);
  assert.strictEqual(last.net.pct, 0);
  // numbers and letters only: no names anywhere in the snapshot
  assert.doesNotMatch(JSON.stringify(last), /[a-z]{3,}\d|realtek|nvidia|luid|pid_/i);
  // stale sampler: counters fall back to '--'
  t += 4000;
  s.tick();
  last = snaps[snaps.length - 1];
  assert.strictEqual(last.cpu, null);
  assert.strictEqual(last.live, false);
  // no viewer for idleStopSec: the child is killed
  viewers = 0;
  t += 6000;
  s.tick();
  assert.strictEqual(kids[0].killed, true);
  // a dead child is respawned only after a backoff
  viewers = 1;
  s.tick();
  assert.strictEqual(kids.length, 2);
  kids[1].emit('exit', 1);
  s.tick();
  assert.strictEqual(kids.length, 2);
  t += 3000;
  s.tick();
  assert.strictEqual(kids.length, 3);
  s.stop();
  assert.strictEqual(kids[2].killed, true);
});

test('spawn failure fails soft (no throw, RAM still published)', () => {
  const snaps = [];
  const s = new R.ResourceSampler({}, { spawn: () => { throw new Error('ENOENT'); }, os: fakeOs, statfs: fakeStatfs, viewers: () => 1, onSnap: (x) => snaps.push(x) });
  s.tick();
  assert.strictEqual(snaps[0].ram, 75);
  assert.strictEqual(snaps[0].cpu, null);
  s.stop();
});

test('disabled sampler never spawns', () => {
  let n = 0;
  const s = new R.ResourceSampler({ resources: { enabled: false } }, { spawn: () => { n++; return fakeChild(); }, viewers: () => 1 });
  s.start();
  s.tick();
  s.stop();
  assert.strictEqual(n, 0);
});

test('page model: fixed items, -- when missing, bands, tooltips with numbers only', () => {
  const none = RS.items(null);
  assert.deepStrictEqual(none.map((x) => x.label), ['CPU', 'RAM', 'GPU', 'NET']);
  assert.ok(none.every((x) => x.text === '--' && x.band === 'na'));
  const it = RS.items({ cpu: 7, ram: 61, ramTotalBytes: 32 * GB, gpu: 90, drives: [{ letter: 'C', active: 30, used: 75, totalBytes: 100 * GB, freeBytes: 25 * GB }, { letter: 'E', active: null, used: 0 }, { letter: 'Z', active: 1 }], net: { pct: 2, rx: 125000, tx: 250000, bw: 1e9 } });
  assert.deepStrictEqual(it.map((x) => x.label + ' ' + x.text), ['CPU 7%', 'RAM 61%', 'GPU 90%', 'C: 30%', 'E: --', 'NET 2%']);
  assert.deepStrictEqual(it.map((x) => x.band), ['low', 'mid', 'high', 'ok', 'na', 'low']);
  assert.match(it[1].title, /19\.5 GB of 32\.0 GB in use/);
  assert.match(it[3].title, /active time 30%.*capacity 75% used \(75\.0 GB of 100 GB\)/);
  assert.match(it[5].title, /send 2\.0 Mbps, receive 1\.0 Mbps/);
  assert.match(it[5].title, /link 1\.0 Gbps/);
  // the drop order covers every item and keeps CPU for last
  for (const x of it) assert.ok(RS.DROP.includes(x.key), x.key);
  assert.strictEqual(RS.DROP[RS.DROP.length - 1], 'cpu');
  // the core is what is dropped last
  assert.deepStrictEqual(RS.DROP.slice(-RS.CORE.length).sort(), RS.CORE.slice().sort());
  assert.strictEqual(RS.band(24.9), 'low');
  assert.strictEqual(RS.band(25), 'ok');
  assert.strictEqual(RS.band(60), 'mid');
  assert.strictEqual(RS.band(85), 'high');
});

test('server: GET /api/resources needs the token; /ws/events pushes {t: res}', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  const kids = [];
  const srv = await createConsoleServer({
    port: 0, hom: false, dataDir: fx.dataDir, runDir: fx.runDir,
    overrides: Object.assign({}, fx.overrides, { resources: { enabled: true, tickMs: 100 } }),
    resSpawn: () => { const ch = fakeChild(); kids.push(ch); return ch; }, resOs: fakeOs, resStatfs: fakeStatfs,
  });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  assert.strictEqual((await fetch(base + '/api/resources')).status, 401);
  const r = await fetch(base + '/api/resources', { headers: { 'X-Console-Token': srv.token } });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.strictEqual(j.enabled, true);
  assert.strictEqual(j.ram, 75);
  assert.strictEqual(kids.length, 1);
  // a foreign Origin on the events socket is refused
  await new Promise((resolve) => {
    const bad = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/events?t=' + srv.token, { headers: { Origin: 'http://evil.example' } });
    bad.on('error', () => resolve());
    bad.on('open', () => { bad.close(); assert.fail('foreign origin accepted'); });
  });
  const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/events?t=' + srv.token);
  const got = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no res message')), 5000);
    ws.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.t === 'res' && m.res.live) { clearTimeout(to); resolve(m.res); }
    });
    ws.on('open', () => setTimeout(() => kids[0].stdout.emit('data', LINE + '\n'), 50));
  });
  ws.close();
  assert.strictEqual(got.cpu, 13);
  await srv.close();
  assert.strictEqual(kids[0].killed, true);
});
