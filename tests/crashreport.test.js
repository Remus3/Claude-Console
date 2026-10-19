'use strict';
// CON-013 L3 (addendum e.2): the crash report is built only from allowed content, goes
// through the extended scrubber, is refused when a needle survives, is shown before
// anything happens, and each of its three actions needs an explicit confirm. No network:
// openUrl / clipboard are fakes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { tmpdir } = require('./helpers');
const CR = require('../installer/crashreport');
const { scrub, needleHits } = require('../installer/contribute');
const cli = require('../installer/cli');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// Seeded needles, all fake.
const USER = 'zelda_tester';
const HOST = 'ZELDA-PC9';
const FAKE_KEY = 'sk-test-FAKE0000aaaa1111bbbb2222';
const GHP = 'ghp_' + 'A1b2C3d4'.repeat(4);

function seeded() {
  const root = tmpdir('cc-crash-');
  const home = path.join(root, 'Users', USER, 'AppData', 'Local', 'Programs', 'claude-console');
  const run = path.join(home, 'run');
  const data = path.join(home, 'data');
  w(path.join(run, 'server.log'), [
    'server: started on 127.0.0.1:7800/?token=abcdef0123456789',
    'pane: C:\\Users\\' + USER + '\\repo\\x.js failed for ' + USER + '@example.com',
    'key ' + FAKE_KEY + ' and ' + GHP + ' and AKIA' + 'FAKEFAKEFAKE0000',
    'host ' + HOST + ' artifact https://claude.ai/' + 'artifact/abc-123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh',
    'machine data ' + path.join(data, 'machine', 'spec.json') + ' read',
    'hex ' + 'a'.repeat(32) + ' X-Console-Token: tok123456789',
  ].join('\n') + '\n');
  for (let i = 0; i < 300; i++) fs.appendFileSync(path.join(run, 'server.log'), 'line ' + i + ' ' + 'x'.repeat(60) + '\n');
  return { root, home, run, data };
}

test('scrub: user and host names anywhere, tokens, 32+ hex, artifact URLs, console token, machine data', () => {
  const s = seeded();
  const t = scrub(fs.readFileSync(path.join(s.run, 'server.log'), 'utf8'), { home: s.home, username: USER, hostname: HOST, token: 'tok123456789', machineDir: path.join(s.data, 'machine') });
  for (const needle of [USER, HOST, FAKE_KEY, GHP, 'AKIAFAKE', 'abcdef0123456789', 'example.com', 'claude.ai/artifact', 'eyJhbGci', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tok123456789', 'spec.json']) {
    assert.ok(!t.includes(needle), 'scrubbed: ' + needle);
  }
  assert.match(t, /<MACHINE-DATA>/);
  assert.match(t, /token=<TOKEN>/);
  assert.match(t, /X-Console-Token: <TOKEN>/);
  assert.strictEqual(scrub('id 123e4567-e89b-12d3-a456-426614174000 ghp_' + 'a'.repeat(30)), 'id <ID> <TOKEN>', 'the old contract still holds');
  assert.deepStrictEqual(needleHits('all clean', ['zz']), []);
  assert.deepStrictEqual(needleHits('has Zz inside', ['zz']), ['zz']);
});

test('report: allowed content only, last 200 log lines, stack without paths, needles = 0', () => {
  const s = seeded();
  const rep = CR.buildReport({ version: '0.1.3', channel: 'stable', step: { id: 'profile-verify', exit: 9009, reason: 'python not found\nsecond line dropped', stack: 'Error: x\n    at run (C:\\Users\\' + USER + '\\app\\installer\\x.js:12:3)\n    at file:///C:/Users/' + USER + '/app/y.js:3:4' },
    runDir: s.run, dataDir: s.data, home: s.home, profileState: 'profile 1.0.0 - 38 of 147 items on', lastTx: { id: '20261019-010203-001', status: 'failed' },
    os: 'win32 10.0.19045 x64', node: 'v24.0.0', git: true, username: USER, hostname: HOST });
  assert.ok(rep.ok, rep.reason);
  const t = rep.text;
  assert.match(t, /^Claude Console crash report\nversion: 0\.1\.3  channel: stable\nos: win32 10\.0\.19045 x64\nnode: v24\.0\.0\ngit: yes\nfailing step: profile-verify \(exit 9009\): python not found\n/);
  assert.ok(!t.includes('second line dropped'));
  assert.match(t, /at run \(x\.js:12:3\)/);
  assert.match(t, /profile: profile 1\.0\.0 - 38 of 147 items on/);
  assert.match(t, /last tx: 20261019-010203-001 failed/);
  assert.match(t, /last 200 console log line\(s\):/);
  assert.ok(t.includes('line 299 ') && !t.includes('line 99 '), 'only the last 200 lines');
  for (const needle of [USER, HOST, FAKE_KEY, GHP, s.root, os.homedir()]) assert.ok(!t.toLowerCase().includes(String(needle).toLowerCase()), 'no ' + needle);
  assert.strictEqual(rep.bytes, Buffer.byteLength(t));
});

test('report: refused when a needle survives the scrub (local needles file)', () => {
  const s = seeded();
  w(path.join(s.run, 'extra.log'), 'mentions project-nightingale here\n');
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(s.run, 'extra.log'), later, later);
  w(path.join(s.data, 'privacy-needles.txt'), 'project-nightingale\n');
  const rep = CR.buildReport({ version: '0.1.3', runDir: s.run, dataDir: s.data, home: s.home, username: USER, hostname: HOST });
  assert.strictEqual(rep.ok, false);
  assert.strictEqual(rep.text, null);
  assert.match(rep.reason, /still holds 1 private value/);
});

test('actions: nothing without confirm; issue URL under 8 KB with a truncation note; save; ask Claude', async () => {
  const s = seeded();
  const rep = CR.buildReport({ version: '0.1.3', runDir: s.run, dataDir: s.data, home: s.home, username: USER, hostname: HOST, git: false });
  const opened = [];
  const clip = [];
  const deps = { openUrl: (u) => opened.push(u), clipboard: (t) => clip.push(t), documents: path.join(s.root, 'Documents'), now: new Date('2026-10-19T01:02:03Z') };
  for (const act of ['issue', 'claude', 'save']) assert.strictEqual((await CR.runAction(rep, act, deps)).ok, false, act + ' needs confirm');
  assert.deepStrictEqual([opened.length, clip.length], [0, 0]);
  const i = await CR.runAction(rep, 'issue', Object.assign({ confirm: true }, deps));
  assert.ok(i.ok && i.truncated, 'the 200-line report does not fit the URL');
  assert.ok(opened[0].length <= CR.URL_MAX);
  assert.ok(opened[0].startsWith('https://github.com/Remus3/Claude-Console/issues/new?title='));
  assert.match(decodeURIComponent(opened[0]), /truncated: attach the saved report file/);
  const c = await CR.runAction(rep, 'claude', Object.assign({ confirm: true }, deps));
  assert.strictEqual(c.via, 'clipboard');
  assert.ok(clip[0].startsWith(CR.PREAMBLE + '\n\nClaude Console crash report'));
  const sv = await CR.runAction(rep, 'save', Object.assign({ confirm: true }, deps));
  assert.strictEqual(path.basename(sv.file), 'claude-console-report-20261019-010203.txt');
  assert.strictEqual(fs.readFileSync(sv.file, 'utf8'), rep.text);
  assert.strictEqual((await CR.runAction(rep, 'mail', Object.assign({ confirm: true }, deps))).ok, false);
  const small = { ok: true, text: 'Claude Console crash report\nfailing step: x\n' };
  const u = CR.issueUrl(small);
  assert.strictEqual(u.truncated, false);
});

test('cli crash-report: preview first, then one action with --yes', async () => {
  const s = seeded();
  const lines = [];
  const opened = [];
  const deps = { out: (x) => lines.push(x), openUrl: (u) => opened.push(u), dataDir: s.data, profileDir: path.join(s.root, 'no-profile'), gitPresent: true };
  let code = await cli.run(['crash-report', '--step', 'apply', '--home', s.home], deps);
  assert.strictEqual(code, 0);
  assert.match(lines[0], /^Crash report preview \(\d+ bytes; nothing sent\):$/);
  assert.match(lines[lines.length - 1], /pick one: --action issue/);
  assert.strictEqual(opened.length, 0);
  lines.length = 0;
  code = await cli.run(['crash-report', '--action', 'issue', '--home', s.home], deps);
  assert.strictEqual(opened.length, 0, 'an action without --yes only previews');
  code = await cli.run(['crash-report', '--action', 'issue', '--yes', '--home', s.home], deps);
  assert.strictEqual(code, 0);
  assert.strictEqual(opened.length, 1);
});
