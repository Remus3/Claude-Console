'use strict';
// Privacy guarantee, runtime half (CON-013 addendum e.1): installer/egress.js installGuard
// wraps http/https, net, tls, dgram and fetch, records every attempt and refuses any
// non-loopback one. The isolated server is then driven through its read routes, the
// profile routes that exist in this build and the update routes. Asserted: every attempt
// is loopback, except ONE update-check call to api.github.com, only with updates enabled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const egress = require('../installer/egress');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-egress-'));
const savedLad = process.env.LOCALAPPDATA;
process.env.LOCALAPPDATA = path.join(tmp, 'localappdata'); // the update cache stays in tmp
const guard = egress.installGuard({ permit: (host) => egress.isLoopback(host) });
process.on('exit', () => {
  guard.restore();
  process.env.LOCALAPPDATA = savedLad;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* hygiene sweep */ }
});

const { createConsoleServer } = require('../server/server');
const GETS = ['/api/info', '/api/projects', '/api/status', '/api/settings', '/api/layout', '/api/panes', '/api/tools',
  '/api/commands', '/api/health', '/api/resources', '/api/updates', '/api/updates/preflight', '/api/usage-prefs', '/api/credits?refresh=1'];
const PROFILE_ROUTES = [['GET', '/api/profile'], ['POST', '/api/profile/plan'], ['POST', '/api/profile/adopt/scan']];

async function startServer(name, updates, extra) {
  const d = path.join(tmp, name);
  fs.mkdirSync(path.join(d, 'repo', '.git'), { recursive: true });
  return createConsoleServer({ ...(extra || {}), port: 0, dataDir: path.join(d, 'data'), runDir: path.join(d, 'run'), dropsDir: path.join(d, 'drops'),
    overrides: { scanRoots: [], extraProjects: [path.join(d, 'repo')], updates, plugins: { main: { enabled: false } } },
    healthSuiteHolders: () => 0, desktopDirs: [path.join(d, 'Desktop')] });
}

function call(srv, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: '127.0.0.1', port: srv.port, path: p, method,
      headers: Object.assign({ 'X-Console-Token': srv.token }, data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const outside = () => guard.attempts.filter((a) => !egress.isLoopback(a.host));

test('updates off: the read surface, profile routes and an update check make no outside attempt', async () => {
  guard.attempts.length = 0;
  const srv = await startServer('off', { check: false, repo: 'Remus3/Claude-Console' });
  try {
    for (const p of GETS) await call(srv, 'GET', p);
    for (const [m, p] of PROFILE_ROUTES) await call(srv, m, p, m === 'POST' ? {} : undefined);
    const c = await call(srv, 'POST', '/api/updates/check', {});
    assert.strictEqual(c.status, 200);
    assert.match(c.text, /check-off/);
  } finally { await srv.close(); }
  assert.ok(guard.attempts.length > GETS.length, 'the guard saw the loopback calls');
  assert.deepStrictEqual(outside(), []);
});

test('updates on: exactly one update-check call, to api.github.com, refused here', async () => {
  guard.attempts.length = 0;
  const srv = await startServer('on', { check: true, repo: 'Remus3/Claude-Console', auto: false });
  let c;
  try {
    for (const p of GETS) await call(srv, 'GET', p);
    c = await call(srv, 'POST', '/api/updates/check', {});
  } finally { await srv.close(); }
  const out = outside();
  assert.strictEqual(out.length, 1, JSON.stringify(out));
  assert.strictEqual(out[0].host, 'api.github.com');
  assert.strictEqual(out[0].allowed, false);
  assert.match(c.text, /egress refused|error/, 'the console reports the failed check instead of crashing');
});

// CON-API-PUBLIC: the credits reader ships, but with an Admin key set and the opt-in OFF
// (the default) it reads nothing and calls nothing; with it ON the one host is api.anthropic.com.
test('credits: a key set but the opt-in off makes no outside attempt; on, only api.anthropic.com', async () => {
  const key = 'sk-ant-adm' + 'in01-' + 'Z'.repeat(40);
  guard.attempts.length = 0;
  let srv = await startServer('cr-off', { check: false }, { creditsEnv: { CLAUDE_CONSOLE_ACCT1_API_KEY: key } });
  try {
    const c = await call(srv, 'GET', '/api/credits?refresh=1');
    assert.match(c.text, /"optIn":false/);
  } finally { await srv.close(); }
  assert.deepStrictEqual(outside(), []);
  srv = await startServer('cr-on', { check: false }, { creditsEnv: { CLAUDE_CONSOLE_ACCT1_API_KEY: key } });
  try {
    await call(srv, 'POST', '/api/credits/settings', { enabled: true });
    await call(srv, 'POST', '/api/credits/settings', { enabled: false });
  } finally { await srv.close(); }
  const out = outside();
  assert.ok(out.length >= 1 && out.every((a) => a.host === 'api.anthropic.com'), JSON.stringify(out));
});

test('the guard bites: planted fetch, socket and udp attempts are recorded and refused', async () => {
  guard.attempts.length = 0;
  await assert.rejects(async () => globalThis.fetch('https://telemetry.example.net/collect'), /egress refused/);
  assert.throws(() => require('net').connect(443, '203.0.113.9'), /egress refused/);
  assert.throws(() => require('dgram').createSocket('udp4'), /egress refused/);
  assert.strictEqual(outside().length, 3);
});
