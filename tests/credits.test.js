'use strict';
// CON-CREDITS / CON-USAGE-2 on fake data: per-account keys from the user env (server side
// only), the Admin cost report summed per account (cents -> USD, paginated), regular keys
// and failures shown as states, Extra Usage kept apart, and NO key in any output.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../server/credits');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);
const ADMIN = 'sk-ant-adm' + 'in01-' + 'F'.repeat(40); // split: the public export's token scan
const REGULAR = 'sk-ant-api03-' + 'G'.repeat(40);
const ACCTS = [{ id: 'acct1', label: 'Account 1' }, { id: 'acct2', label: 'Account 2' }];

function fakeFetch(pages, calls, status) {
  return async (url, init) => {
    calls.push({ url, key: init.headers['x-api-key'], ver: init.headers['anthropic-version'] });
    if (status) return { ok: false, status, json: async () => ({ error: { message: 'bad key ' + init.headers['x-api-key'] } }) };
    const page = new URL(url).searchParams.get('page');
    return { ok: true, status: 200, json: async () => pages[page || 'first'] };
  };
}
const PAGES = {
  first: { data: [{ starting_at: '2026-10-01T00:00:00Z', results: [{ amount: '1234.5', currency: 'USD' }, { amount: '100', currency: 'USD' }] }], has_more: true, next_page: 'p2' },
  p2: { data: [{ starting_at: '2026-10-02T00:00:00Z', results: [{ amount: '65.5', currency: 'USD' }, { amount: '999', currency: 'EUR' }] }], has_more: false, next_page: null },
};

test('variable names, key kinds, month start, cost sum', () => {
  assert.strictEqual(C.varName('acct1'), 'CLAUDE_CONSOLE_ACCT1_API_KEY');
  assert.strictEqual(C.varName('my-acct'), 'CLAUDE_CONSOLE_MY_ACCT_API_KEY');
  assert.strictEqual(C.keyKind(ADMIN), 'admin');
  assert.strictEqual(C.keyKind(REGULAR), 'regular');
  assert.strictEqual(C.keyKind('x'), 'unknown');
  assert.strictEqual(C.keyKind(''), null);
  assert.strictEqual(C.monthStartIso(NOW), '2026-10-01T00:00:00Z');
  assert.deepStrictEqual(C.sumCostReport([PAGES.first, PAGES.p2]), { usd: 14, rows: 3 });
  assert.strictEqual(C.errCode(401), 'key rejected (401)');
});

test('per account: admin key reads month-to-date spend (paginated), regular key is a state, unset is unset', async () => {
  const calls = [];
  const notes = [];
  const svc = new C.CreditsService({ accounts: ACCTS, optIn: () => true, env: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN, CLAUDE_CONSOLE_ACCT2_API_KEY: REGULAR }, reg: async () => null, fetch: fakeFetch(PAGES, calls), now: () => NOW, egress: { check: (u, k) => notes.push([new URL(u).origin, k]) } });
  const s = await svc.refresh(false);
  assert.strictEqual(calls.length, 2, 'two pages, account 1 only');
  assert.ok(calls.every((c) => c.key === ADMIN && c.ver === '2023-06-01'));
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/organizations\/cost_report\?starting_at=2026-10-01T00%3A00%3A00Z&bucket_width=1d&limit=31$/);
  assert.match(calls[1].url, /&page=p2$/);
  assert.deepStrictEqual(notes[0], ['https://api.anthropic.com', 'credits'], 'every call passes egress.check(kind credits)');
  const [a1, a2] = s.accounts;
  assert.deepStrictEqual([a1.keyVar, a1.keySet, a1.keyKind, a1.api.usd, a1.api.error], ['CLAUDE_CONSOLE_ACCT1_API_KEY', true, 'admin', 14, null]);
  assert.deepStrictEqual([a2.keySet, a2.keyKind, a2.api], [true, 'regular', null]);
  const out = JSON.stringify(s);
  assert.ok(!out.includes(ADMIN) && !out.includes(REGULAR) && !out.includes('sk-ant'), 'no key in the client view');
  // cached for 15 min: a second refresh makes no call
  await svc.refresh(false);
  assert.strictEqual(calls.length, 2);
});

test('the registry is read when the process env lacks the variable; nothing set = unset', async () => {
  const asked = [];
  const svc = new C.CreditsService({ accounts: ACCTS, optIn: () => true, env: {}, reg: async (n) => { asked.push(n); return n.includes('ACCT2') ? ADMIN : null; }, fetch: fakeFetch(PAGES, []), now: () => NOW });
  const s = await svc.refresh(false);
  assert.deepStrictEqual(asked, ['CLAUDE_CONSOLE_ACCT1_API_KEY', 'CLAUDE_CONSOLE_ACCT2_API_KEY']);
  assert.deepStrictEqual(s.accounts.map((a) => [a.keySet, a.keyKind]), [[false, null], [true, 'admin']]);
});

test('a rejected key becomes a fixed error code (the API text, which could echo the key, is dropped)', async () => {
  const svc = new C.CreditsService({ accounts: ACCTS.slice(0, 1), optIn: () => true, env: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, reg: async () => null, fetch: fakeFetch(PAGES, [], 401), now: () => NOW });
  const s = await svc.refresh(false);
  assert.deepStrictEqual(s.accounts[0].api, { usd: null, at: NOW, error: 'key rejected (401)' });
  assert.ok(!JSON.stringify(s).includes(ADMIN));
  const net = new C.CreditsService({ accounts: ACCTS.slice(0, 1), optIn: () => true, env: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, reg: async () => null, fetch: async () => { throw new Error('ECONNRESET ' + ADMIN); }, now: () => NOW });
  const n = await net.refresh(false);
  assert.strictEqual(n.accounts[0].api.error, 'network error');
  assert.ok(!JSON.stringify(n).includes(ADMIN));
});

test('Extra Usage comes per account from the quota numbers, apart from the API spend', () => {
  const svc = new C.CreditsService({ accounts: ACCTS, env: {}, reg: async () => null, now: () => NOW, quota: () => ({ accounts: [{ id: 'acct2', quota: { extraUsedUsd: 40.5, extraLimitUsd: 100 } }] }) });
  const s = svc.snapshot();
  assert.deepStrictEqual(s.accounts.map((a) => a.extra), [null, { used: 40.5, limit: 100 }]);
});

test('server: /api/credits and /api/status carry the client view; a test server reads no real key', async (t) => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, resources: false, creditsEnv: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, creditsFetch: fakeFetch(PAGES, []) });
  t.after(() => srv.close());
  const get = async (p) => (await fetch('http://127.0.0.1:' + srv.port + p, { headers: { 'X-Console-Token': srv.token } })).json();
  const c = await get('/api/credits');
  assert.strictEqual(c.enabled, true);
  const st = await get('/api/status');
  assert.ok(st.credits && Array.isArray(st.credits.accounts));
  assert.ok(!JSON.stringify(c).includes('sk-ant') && !JSON.stringify(st).includes('sk-ant'));
  const plain = await createConsoleServer({ port: 0, dataDir: makeFixture().dataDir, runDir: fx.runDir + '2', overrides: fx.overrides, resources: false });
  t.after(() => plain.close());
  const pc = await (await fetch('http://127.0.0.1:' + plain.port + '/api/credits', { headers: { 'X-Console-Token': plain.token } })).json();
  assert.strictEqual(pc.enabled, false, 'no real env / registry read in a test server');
});

// CON-API-PUBLIC (ruling 2026-10-21, option A): the reader ships in the public build, OFF
// by default. It reads keys and calls api.anthropic.com only after the user's explicit
// opt-in (console.local.json credits.enabled, Settings), and the call passes egress.check
// with kind 'credits', which refuses while the opt-in is off.
const egress = require('../installer/egress');

test('egress: api.anthropic.com is an opt-in credits host, refused until the opt-in is on', () => {
  const h = (egress.policy().hosts || []).find((x) => x.host === 'api.anthropic.com');
  assert.ok(h && h.kind === 'credits' && h.optIn === true, 'policy lists the host as opt-in');
  const f = (egress.policy().files || []).find((x) => x.file === 'server/credits.js');
  assert.ok(f && f.class === 'opt-in' && f.hosts.includes('api.anthropic.com'), 'credits.js listed with its host');
  egress.setOptIn('credits', false);
  assert.strictEqual(egress.allowed('https://api.anthropic.com/v1/x', 'credits'), false);
  assert.throws(() => egress.check('https://api.anthropic.com/v1/x', 'credits'), /egress refused/);
  egress.setOptIn('credits', true);
  assert.strictEqual(egress.allowed('https://api.anthropic.com/v1/x', 'credits'), true);
  assert.strictEqual(egress.allowed('https://api.anthropic.com/v1/x', 'update'), false, 'kind still matters');
  egress.setOptIn('credits', false);
  assert.strictEqual(egress.allowed('https://api.anthropic.com/v1/x', 'credits'), false);
});

test('opt-in off: no key read, no call, a snapshot that says so', async () => {
  const calls = [];
  const asked = [];
  const svc = new C.CreditsService({ accounts: ACCTS, optIn: () => false, env: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, reg: async (n) => { asked.push(n); return null; }, fetch: fakeFetch(PAGES, calls), now: () => NOW });
  const s = await svc.refresh(true);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(asked.length, 0);
  assert.strictEqual(s.optIn, false);
  assert.ok(s.accounts.every((a) => a.api === null && a.keySet === false));
});

test('opt-in on but no key variable set: no call', async () => {
  const calls = [];
  const svc = new C.CreditsService({ accounts: ACCTS, optIn: () => true, env: {}, reg: async () => null, fetch: fakeFetch(PAGES, calls), now: () => NOW });
  const s = await svc.refresh(true);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(s.optIn, true);
});

test('the call goes through egress.check: a refused check makes no fetch and a fixed error', async () => {
  const calls = [];
  const svc = new C.CreditsService({ accounts: ACCTS.slice(0, 1), optIn: () => true, env: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, reg: async () => null, fetch: fakeFetch(PAGES, calls), now: () => NOW,
    egress: { check: () => { throw new Error('egress refused: ' + ADMIN); } } });
  const s = await svc.refresh(true);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(s.accounts[0].api.error, 'egress refused (opt-in off)');
  assert.ok(!JSON.stringify(s).includes(ADMIN));
});

test('server: credits start off; POST /api/credits/settings turns them on (console.local.json) and off', async (t) => {
  const fs = require('fs');
  const path = require('path');
  const fx = makeFixture();
  const calls = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, resources: false, creditsEnv: { CLAUDE_CONSOLE_ACCT1_API_KEY: ADMIN }, creditsFetch: fakeFetch(PAGES, calls) });
  t.after(() => { srv.close(); egress.setOptIn('credits', false); });
  const req = async (m, p, b) => (await fetch('http://127.0.0.1:' + srv.port + p, { method: m, headers: Object.assign({ 'X-Console-Token': srv.token }, b ? { 'Content-Type': 'application/json' } : {}), body: b ? JSON.stringify(b) : undefined })).json();
  let c = await req('GET', '/api/credits?refresh=1');
  assert.strictEqual(c.optIn, false);
  assert.strictEqual(calls.length, 0, 'no call before the opt-in');
  const bad = await req('POST', '/api/credits/settings', { enabled: 'yes' });
  assert.ok(bad.error);
  c = await req('POST', '/api/credits/settings', { enabled: true });
  assert.strictEqual(c.optIn, true);
  const local = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'console.local.json'), 'utf8'));
  assert.deepStrictEqual(local.credits, { enabled: true });
  c = await req('GET', '/api/credits?refresh=1');
  assert.ok(calls.length >= 1, 'reads after the opt-in');
  assert.strictEqual(c.accounts[0].api.usd, 14);
  assert.ok(!JSON.stringify(c).includes('sk-ant'));
  c = await req('POST', '/api/credits/settings', { enabled: false });
  assert.strictEqual(c.optIn, false);
  assert.strictEqual(egress.allowed('https://api.anthropic.com/', 'credits'), false, 'policy follows the switch');
});
