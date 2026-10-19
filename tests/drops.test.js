'use strict';
// Composer attachments: upload endpoint, safe names, size cap, Recycle-Bin prune.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const D = require('../server/drops');
const { createConsoleServer } = require('../server/server');
const { makeFixture, tmpdir } = require('./helpers');

test('safeName keeps a readable basename and the extension, nothing unsafe', () => {
  assert.strictEqual(D.safeName('C:\\Users\\x\\Screen Shot 1.png'), 'Screen Shot 1.png');
  assert.strictEqual(D.safeName('../../etc/passwd'), 'passwd');
  assert.strictEqual(D.safeName('a<b>:c"|?*.txt'), 'a_b_c_.txt');
  assert.strictEqual(D.safeName(''), 'file');
  assert.strictEqual(D.safeName('...'), 'file');
  assert.strictEqual(D.safeName('con.txt'), '_con.txt');
  assert.strictEqual(D.safeName('\u00e9t\u00e9.md'), '_t_.md');
  const long = D.safeName('x'.repeat(200) + '.jpeg');
  assert.ok(long.length <= 80 && long.endsWith('.jpeg'));
  assert.match(D.uniqueName('a b.png', Date.now()), /^\d{6}-[0-9a-f]{6}-a b\.png$/);
});

test('oldDropDirs / pruneDrops: only day folders older than 14 days, through the recycler', async () => {
  const dir = tmpdir('cc-drops-');
  const now = new Date(2026, 9, 20, 12, 0, 0).getTime();
  for (const n of ['2026-10-01', '2026-10-05', '2026-10-06', '2026-10-20', 'notes', '2026-13-99x']) fs.mkdirSync(path.join(dir, n));
  const old = D.oldDropDirs(dir, now, 14).map((p) => path.basename(p));
  assert.deepStrictEqual(old, ['2026-10-01', '2026-10-05']);
  const seen = [];
  const done = await D.pruneDrops(dir, { now, recycle: async (p) => { seen.push(path.basename(p)); return true; } });
  assert.deepStrictEqual(seen, ['2026-10-01', '2026-10-05']);
  assert.strictEqual(done.length, 2);
  assert.ok(fs.existsSync(path.join(dir, '2026-10-01')), 'the injected recycler did the removal, nothing unlinked directly');
  assert.deepStrictEqual(D.oldDropDirs(path.join(dir, 'missing'), now), []);
});

test('upload endpoint saves under drops/<day>/ and returns the absolute path', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  const dropsDir = path.join(fx.root, 'drops');
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, dropsDir, uploadMaxBytes: 4096 });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const up = (name, body, headers) => fetch(base + '/api/upload?name=' + encodeURIComponent(name), { method: 'POST', headers: Object.assign({ 'X-Console-Token': srv.token, 'Content-Type': 'application/octet-stream' }, headers || {}), body });

  await t.test('image upload', async () => {
    const r = await up('my shot.png', Buffer.from('PNGDATA'));
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.ok(path.isAbsolute(j.path));
    assert.strictEqual(path.dirname(path.dirname(j.path)), dropsDir);
    assert.strictEqual(path.basename(path.dirname(j.path)), D.dayDir(Date.now()));
    assert.ok(j.path.endsWith('-my shot.png'));
    assert.strictEqual(j.image, true);
    assert.strictEqual(j.size, 7);
    assert.strictEqual(fs.readFileSync(j.path, 'utf8'), 'PNGDATA');
  });

  await t.test('other files are not images; names are sanitised', async () => {
    const j = await (await up('..\\..\\evil.ps1', Buffer.from('x'))).json();
    assert.strictEqual(j.image, false);
    assert.strictEqual(path.dirname(path.dirname(j.path)), dropsDir);
    assert.ok(j.path.endsWith('-evil.ps1'));
  });

  await t.test('token and same-origin required', async () => {
    const r1 = await fetch(base + '/api/upload?name=a.txt', { method: 'POST', body: 'x' });
    assert.strictEqual(r1.status, 401);
    const r2 = await up('a.txt', Buffer.from('x'), { Origin: 'http://evil.example' });
    assert.strictEqual(r2.status, 403);
  });

  await t.test('over the size cap: 413, nothing left on disk', async () => {
    const before = fs.readdirSync(path.join(dropsDir, D.dayDir(Date.now()))).length;
    const r = await up('big.bin', Buffer.alloc(5000, 1));
    assert.strictEqual(r.status, 413);
    assert.match((await r.json()).error, /cap/);
    await new Promise((res) => setTimeout(res, 100));
    assert.strictEqual(fs.readdirSync(path.join(dropsDir, D.dayDir(Date.now()))).length, before);
  });

  await t.test('empty body refused; info reports the cap', async () => {
    assert.strictEqual((await up('e.txt', Buffer.alloc(0))).status, 400);
    const info = await (await fetch(base + '/api/info', { headers: { 'X-Console-Token': srv.token } })).json();
    assert.strictEqual(info.uploadMaxBytes, 4096);
  });
});
