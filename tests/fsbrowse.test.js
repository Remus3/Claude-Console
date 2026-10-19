'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listDrives, listDir, normalizeDir } = require('../server/fsbrowse');
const { createConsoleServer } = require('../server/server');
const { tmpdir, writeFile, makeFixture } = require('./helpers');

function tree() {
  const root = tmpdir('cc-fs-');
  for (const d of ['beta', 'Alpha', 'gamma dir', path.join('beta', 'inner')]) fs.mkdirSync(path.join(root, d), { recursive: true });
  writeFile(path.join(root, 'file.txt'), 'secret contents');
  writeFile(path.join(root, 'zeta.md'), 'x');
  return root;
}

test('normalizeDir: absolute drive paths only, dot-dot folded', () => {
  assert.strictEqual(normalizeDir('c:'), 'C:\\');
  assert.strictEqual(normalizeDir('C:/'), 'C:\\');
  assert.strictEqual(normalizeDir('C:\\Work\\..\\Work\\.\\x\\\\'), 'C:\\Work\\x');
  assert.strictEqual(normalizeDir('C:\\..\\..\\Windows'), 'C:\\Windows');
  assert.strictEqual(normalizeDir('"C:\\Program Files"'), 'C:\\Program Files');
  for (const bad of ['', '   ', 'relative\\dir', '..\\x', '\\\\server\\share', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0', '/etc', 'C:\\a\0b', 'C:\\a|b', 'C:\\a?b', 'C:rel', null, 42]) {
    assert.throws(() => normalizeDir(bad), (e) => e.status === 400, String(bad));
  }
});

test('listDir: subfolders only, sorted, parent, no file names', () => {
  const root = tree();
  const r = listDir(root);
  assert.strictEqual(r.path, normalizeDir(root));
  assert.strictEqual(r.parent, path.win32.dirname(r.path));
  assert.deepStrictEqual(r.dirs.map((d) => d.name), ['Alpha', 'beta', 'gamma dir']);
  assert.ok(!JSON.stringify(r).includes('file.txt') && !JSON.stringify(r).includes('secret'));
  assert.deepStrictEqual(listDir(path.join(root, 'beta', '..', 'beta')).dirs.map((d) => d.name), ['inner']);
  const drive = listDir(r.path.slice(0, 3));
  assert.strictEqual(drive.parent, null);
  assert.ok(drive.dirs.length > 0);
});

test('listDir: missing, file, access denied, other errors, cap', () => {
  const root = tree();
  assert.throws(() => listDir(path.join(root, 'nope')), (e) => e.status === 404);
  assert.throws(() => listDir(path.join(root, 'file.txt')), (e) => e.status === 400 || e.status === 404);
  const denied = (code) => () => { const e = new Error(code); e.code = code; throw e; };
  const a = listDir(root, { readdir: denied('EPERM') });
  assert.strictEqual(a.error, 'access denied');
  assert.deepStrictEqual(a.dirs, []);
  assert.strictEqual(listDir(root, { readdir: denied('EACCES') }).error, 'access denied');
  assert.match(listDir(root, { readdir: denied('EBUSY') }).error, /EBUSY/);
  const capped = listDir(root, { max: 2 });
  assert.strictEqual(capped.dirs.length, 2);
  assert.strictEqual(capped.truncated, true);
});

test('listDir: a junction is flagged as a link, not followed', () => {
  const root = tree();
  try {
    fs.symlinkSync(path.join(root, 'beta'), path.join(root, 'jbeta'), 'junction');
  } catch (e) {
    return; // junctions unavailable here
  }
  const j = listDir(root).dirs.find((d) => d.name === 'jbeta');
  assert.ok(j && j.link === true);
  assert.strictEqual(listDir(root).dirs.find((d) => d.name === 'beta').link, false);
});

test('listDrives: existing letters only', () => {
  const ds = listDrives();
  assert.ok(ds.includes(path.parse(tmpdir()).root.toUpperCase()));
  assert.ok(ds.every((d) => /^[A-Z]:\\$/.test(d)));
  assert.deepStrictEqual(listDrives({ stat: (p) => { if (p === 'Q:\\') return { isDirectory: () => true }; throw new Error('x'); } }), ['Q:\\']);
});

test('GET /api/fs/drives and /api/fs/list over HTTP', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  const root = tree();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token };
  assert.strictEqual((await fetch(base + '/api/fs/drives')).status, 401);
  assert.strictEqual((await fetch(base + '/api/fs/list?path=C:\\')).status, 401);
  const d = await (await fetch(base + '/api/fs/drives', { headers: H })).json();
  assert.ok(d.drives.includes('C:\\'));
  const q = (p) => fetch(base + '/api/fs/list?path=' + encodeURIComponent(p), { headers: H });
  const r = await q(root + '\\beta\\..');
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.deepStrictEqual(j.dirs.map((x) => x.name), ['Alpha', 'beta', 'gamma dir']);
  assert.strictEqual((await q('relative')).status, 400);
  assert.strictEqual((await q('\\\\server\\share')).status, 400);
  assert.strictEqual((await q(root + '\\missing')).status, 404);
  assert.strictEqual((await fetch(base + '/api/fs/list', { headers: H })).status, 400);
  assert.strictEqual((await fetch(base + '/api/fs/list?path=C:\\', { method: 'POST', headers: H })).status, 404, 'no write verbs');
});
