'use strict';
// CON-USAGE: the top-bar usage strip. Pure model (fixed-format cells, '--' when a
// source is missing, numbers only) and the server-side slot toggles.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const U = require('../public/app.js').Usage;
const usage = require('../server/usage');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const NOW = 1790000000000;
const MIN = 60000;

test('time to reset: m under 1 h, XhMMm under 1 day, XdYh beyond, -- when unknown', () => {
  assert.strictEqual(U.left(NOW + 37 * MIN + 59000, NOW), '37m');
  assert.strictEqual(U.left(NOW + (7 * 60 + 37) * MIN, NOW), '7h37m');
  assert.strictEqual(U.left(NOW + (3 * 60 + 5) * MIN, NOW), '3h05m');
  assert.strictEqual(U.left(NOW + ((4 * 24 + 7) * 60 + 12) * MIN, NOW), '4d7h');
  assert.strictEqual(U.left(NOW - 5000, NOW), '0m');
  assert.strictEqual(U.left(null, NOW), '--');
  assert.strictEqual(U.left(undefined, NOW), '--');
  // the widest values fit the fixed 6ch / 4ch cells
  assert.ok(U.left(NOW + (23 * 60 + 59) * MIN, NOW).length <= 6);
  assert.ok(U.left(NOW + 6 * 24 * 60 * MIN + 23 * 60 * MIN, NOW).length <= 6);
  assert.strictEqual(U.pct(1), '100%');
  assert.strictEqual(U.pct(0.333), '33%');
  assert.strictEqual(U.pct(null), '--');
  assert.strictEqual(U.usd(152.321), '$152.32');
  assert.strictEqual(U.usd(undefined), '--');
});

test('model: slots follow the configured account order; missing account and sources are --', () => {
  const quota = { accounts: [
    { id: 'acct2', label: 'Account 2', quota: { unified7d: 0.52, unified7dReset: NOW + 4 * 24 * 3600000, unified5h: 0.19, unified5hReset: NOW + 90 * MIN, unified7dFable: 0.01, unified7dFableReset: NOW + 30 * MIN, unifiedStatus: 'allowed' } },
    { id: 'acct1', label: 'Account 1', quota: { unified7d: 0.97, unified7dReset: NOW + 3 * 3600000, unified5h: 0, unified5hReset: null, unified7dFable: 0.75, unifiedStatus: 'rejected' } },
  ] };
  const m = U.model(quota, [{ id: 'acct1' }, { id: 'acct2' }], NOW);
  assert.deepStrictEqual(m.accs.map((a) => a.label), ['Acc 1', 'Acc 2', 'Acc 3']);
  const [a1, a2, a3] = m.accs;
  assert.deepStrictEqual(a1.wins.map((w) => [w.label, w.pct, w.left, w.band]), [['7d', '97%', '3h00m', 'bad'], ['5h', '0%', '--', ''], ['Fable', '75%', '--', 'warn']]);
  assert.strictEqual(a1.status, 'rejected');
  assert.deepStrictEqual(a2.wins.map((w) => [w.pct, w.left]), [['52%', '4d0h'], ['19%', '1h30m'], ['1%', '30m']]);
  assert.strictEqual(a2.status, null);
  assert.strictEqual(a3.present, false);
  assert.ok(a3.wins.every((w) => w.pct === '--' && w.left === '--'));
  // CON-CREDITS: one API chip and one Extra Usage chip per account, '--' with no source
  assert.deepStrictEqual(m.api.map((c) => [c.tag, c.text]), [['A1', '--'], ['A2', '--']]);
  assert.deepStrictEqual(m.extra.map((c) => [c.tag, c.text]), [['A1', '--'], ['A2', '--']]);
  // numbers only: no label, id or name from the quota source leaks into the cells
  assert.ok(!JSON.stringify(m.accs).includes('Account'));
  // per-account numbers, never summed: A1 admin spend, A2 regular key (!), extras apart
  const credits = { accounts: [
    { id: 'acct1', keySet: true, keyKind: 'admin', keyVar: 'V1', api: { usd: 12.5, at: NOW, error: null }, extra: { used: 152.32, limit: 175 } },
    { id: 'acct2', keySet: true, keyKind: 'regular', keyVar: 'V2', api: null, extra: null },
  ] };
  const m2 = U.model(null, [{ id: 'acct1' }, { id: 'acct2' }], NOW, credits);
  assert.deepStrictEqual(m2.api.map((c) => [c.text, c.cls]), [['$12.50', ''], ['?', 'warn']]);
  assert.deepStrictEqual(m2.extra.map((c) => [c.text, c.cls]), [['$152/175', 'warn'], ['--', '']]);
  assert.match(m2.api[1].title, /not an Admin key/);
  const m3 = U.model(null, [{ id: 'acct1' }], NOW, { accounts: [{ id: 'acct1', keySet: true, keyKind: 'admin', api: { usd: null, error: 'key rejected (401)' } }] });
  assert.deepStrictEqual([m3.api[0].text, m3.api[0].cls, m3.api[0].title], ['x', 'bad', 'Acc 1 API: key rejected (401)']);
  assert.ok(m2.accs.every((a) => !a.present));
  // compact summary = highest visible used %
  assert.strictEqual(U.summary(m, {}), '97%');
  assert.strictEqual(U.summary(m, { acc1: false }), '52%');
  assert.strictEqual(U.summary(m, { w7d: false, acc2: false, w5h: true, fable: true }), '75%');
  assert.strictEqual(U.summary(U.model(null, [], NOW), {}), '--');
  assert.strictEqual(U.isOn({}, 'acc3'), false);
  assert.strictEqual(U.isOn({ acc3: true }, 'acc3'), true);
  assert.strictEqual(U.isOn({}, 'api'), false);
  assert.strictEqual(U.isOn({}, 'w7d'), true);
  assert.strictEqual(U.isOn({ api: true }, 'api'), true);
});

test('prefs: booleans only, author defaults (7d, Acc 1, Acc 2), unknown keys dropped', () => {
  assert.deepStrictEqual(usage.sanitizeUsagePrefs(null), usage.DEFAULT_USAGE_PREFS);
  assert.deepStrictEqual(usage.USAGE_KEYS.filter((k) => usage.DEFAULT_USAGE_PREFS[k]), ['w7d', 'acc1', 'acc2']);
  const p = usage.sanitizeUsagePrefs({ acc1: false, api: 'no', extra: true, evil: true, __proto__: { x: 1 } });
  assert.strictEqual(p.acc1, false);
  assert.strictEqual(usage.DEFAULT_USAGE_PREFS.acc3, false);
  assert.strictEqual(usage.DEFAULT_USAGE_PREFS.acc2, true);
  assert.strictEqual(p.api, false);
  assert.strictEqual(p.extra, true);
  assert.ok(!('evil' in p));
  assert.deepStrictEqual(Object.keys(p).sort(), usage.USAGE_KEYS.slice().sort());
});

test('prefs: Acc 2 defaults off without a second login of its own', () => {
  const exists = (d) => d === path.resolve('H:/acct2').toLowerCase();
  const o = { home: 'H:/home', exists };
  assert.strictEqual(usage.hasSecondAccount({ acct1: { configDir: null } }, o), false);
  assert.strictEqual(usage.hasSecondAccount({ acct1: { configDir: null }, acct2: { configDir: null } }, o), false);
  assert.strictEqual(usage.hasSecondAccount({ acct1: { configDir: null }, acct2: { configDir: 'H:/missing' } }, o), false);
  assert.strictEqual(usage.hasSecondAccount({ acct1: { configDir: 'H:/acct2' }, acct2: { configDir: 'H:/acct2' } }, o), false);
  assert.strictEqual(usage.hasSecondAccount({ acct1: { configDir: null }, acct2: { configDir: 'H:/acct2' } }, o), true);
  assert.strictEqual(usage.defaultsFor({ acct1: { configDir: null }, acct2: { configDir: null } }, o).acc2, false);
  assert.strictEqual(usage.defaultsFor({ acct1: { configDir: null }, acct2: { configDir: 'H:/acct2' } }, o).acc2, true);
  // a stored choice still wins over the default
  assert.strictEqual(usage.sanitizeUsagePrefs({ acc2: true }, null, usage.defaultsFor({ acct1: {} }, o)).acc2, true);
});

test('GET/PUT /api/usage-prefs persists in data/usage.local.json across a restart', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const opts = { port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides };
  let srv = await createConsoleServer(opts);
  t.after(() => srv && srv.close());
  const call = async (method, p, body, extra) => {
    const r = await fetch('http://127.0.0.1:' + srv.port + p, { method, headers: Object.assign({ 'X-Console-Token': srv.token, 'Content-Type': 'application/json' }, extra || {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  assert.strictEqual((await fetch('http://127.0.0.1:' + srv.port + '/api/usage-prefs')).status, 401);
  assert.deepStrictEqual((await call('GET', '/api/usage-prefs')).body.slots, usage.DEFAULT_USAGE_PREFS);
  assert.strictEqual((await call('PUT', '/api/usage-prefs', { slots: { fable: false } }, { Origin: 'http://evil.example' })).status, 403);
  const put = await call('PUT', '/api/usage-prefs', { slots: { fable: false, acc2: false, junk: 1 } });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.body.slots.fable, false);
  assert.strictEqual(put.body.slots.acc2, false);
  assert.ok(!('junk' in put.body.slots));
  // a second patch merges over the first
  assert.strictEqual((await call('PUT', '/api/usage-prefs', { slots: { fable: true } })).body.slots.acc2, false);
  const file = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'usage.local.json'), 'utf8'));
  assert.deepStrictEqual(file.slots, Object.assign({}, usage.DEFAULT_USAGE_PREFS, { acc2: false, fable: true }));
  await srv.close();
  srv = await createConsoleServer(opts);
  const after = (await call('GET', '/api/usage-prefs')).body.slots;
  assert.strictEqual(after.acc2, false);
  assert.strictEqual(after.fable, true);
});
