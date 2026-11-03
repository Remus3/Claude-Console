'use strict';
// kit v26 KIT-ROUTE-ACCOUNTS helpers (server/route-accounts.js): console accounts ->
// kit entries, the one CLI argv, the v1/v2 rule, the live route read back to ids.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const RA = require('../server/route-accounts');
const { tmpdir, writeFile } = require('./helpers');

const PIN = ['11111111', '2222', '3333', '4444', '555555555555'].join('-');
const accounts = {
  a1: { label: 'Account 1', configDir: 'C:\\x\\a1' },
  a2: { label: 'Account 2', configDir: 'C:\\x\\a2', headlessProxy: true },
  a3: { label: 'Account 3', configDir: 'C:\\x\\a3', headlessPin: PIN },
};
const dir = (id) => accounts[id].configDir;

test('entries: proxy account, pinned account, own login; bad lists refused', () => {
  assert.deepStrictEqual(RA.entriesFor(['a2', 'a3', 'a1'], accounts, dir).entries, [{ via: 'proxy' }, { via: 'proxy', pin: PIN }, { via: 'config', dir: 'C:\\x\\a1' }]);
  assert.match(RA.entriesFor([], accounts, dir).error, /choose/);
  assert.match(RA.entriesFor(['a1', 'a2', 'a3', 'a1'], accounts, dir).error, /at most 3/);
  assert.match(RA.entriesFor(['a1', 'a1'], accounts, dir).error, /twice/);
  assert.match(RA.entriesFor(['nope'], accounts, dir).error, /not configured/);
  assert.match(RA.entriesFor(['__proto__'], accounts, dir).error, /not configured/);
  const twin = { b1: { configDir: 'C:\\x\\A1' }, b2: { configDir: 'C:\\x\\a1' } };
  assert.match(RA.entriesFor(['b1', 'b2'], twin, (id) => twin[id].configDir).error, /same account/);
  assert.deepStrictEqual(RA.entryOf({ headlessPin: 'not-a-uuid' }, 'D'), { via: 'config', dir: 'D' });
});

test('v1 when expressible, else v2 (the kit rule)', () => {
  const P = { via: 'proxy' }; const C = { via: 'config', dir: 'd' }; const X = { via: 'proxy', pin: PIN };
  assert.strictEqual(RA.needsV2([P]), false);
  assert.strictEqual(RA.needsV2([C]), false);
  assert.strictEqual(RA.needsV2([P, C]), false);
  assert.strictEqual(RA.needsV2([C, P]), false);
  assert.strictEqual(RA.needsV2([X]), true);
  assert.strictEqual(RA.needsV2([C, { via: 'config', dir: 'e' }]), true);
  assert.strictEqual(RA.needsV2([P, C, { via: 'config', dir: 'e' }]), true);
});

test('argv: one --account per entry in order, then the switch', () => {
  assert.deepStrictEqual(RA.argvFor([{ via: 'proxy' }, { via: 'config', dir: 'D' }], true), ['route', 'set', '--account', 'proxy', '--account', 'config:D', '--fallback']);
  assert.deepStrictEqual(RA.argvFor([{ via: 'proxy', pin: PIN }], false), ['route', 'set', '--account', 'proxy:' + PIN, '--no-fallback']);
});

test('live route: v1 armed (the live shape) and v2 read back to console ids; missing or odd files read null', () => {
  const root = tmpdir('cc-ra-');
  const f = path.join(root, 'route.json');
  assert.strictEqual(RA.liveRoute(f, accounts, dir), null);
  fs.writeFileSync(f, JSON.stringify({ version: 1, mode: 'split', fallback: { armed: true, mode: 'single', config_dir: 'C:\\x\\a1' } }));
  assert.deepStrictEqual(RA.liveRoute(f, accounts, dir), { version: 1, armed: true, entries: [{ via: 'proxy', pinned: false, id: 'a2' }, { via: 'config', pinned: false, id: 'a1' }] });
  fs.writeFileSync(f, JSON.stringify({ version: 2, accounts: [{ via: 'proxy', pin: PIN }, { via: 'config', config_dir: 'C:\\elsewhere' }] }));
  assert.deepStrictEqual(RA.liveRoute(f, accounts, dir), { version: 2, armed: false, entries: [{ via: 'proxy', pinned: true, id: 'a3' }, { via: 'config', pinned: false, id: null }] });
  fs.writeFileSync(f, '{"version": 7}');
  assert.strictEqual(RA.liveRoute(f, accounts, dir), null);
});

test('kit minimum from the roster; unreadable = null (v2 stays refused)', () => {
  const root = tmpdir('cc-ra-');
  const t1 = path.join(root, 't1'); const t2 = path.join(root, 't2');
  writeFile(path.join(t1, 'ops', 'fleet_kit', 'MANIFEST.json'), JSON.stringify({ version: 26 }));
  writeFile(path.join(t2, 'ops', 'fleet_kit', 'MANIFEST.json'), JSON.stringify({ version: 25 }));
  writeFile(path.join(root, 'ops', 'fleet_roster.json'), JSON.stringify({ repos: [{ code: 'HOME', root }, { code: 'T1', root: t1 }, { code: 'T2', root: t2 }, { code: 'OLD', root: 'x', retired: 'y' }] }));
  assert.strictEqual(RA.fleetKitMin(root), 25);
  writeFile(path.join(t2, 'ops', 'fleet_kit', 'MANIFEST.json'), JSON.stringify({ version: 26 }));
  assert.strictEqual(RA.fleetKitMin(root), 26);
  assert.strictEqual(RA.fleetKitMin(path.join(root, 'none')), null);
});
