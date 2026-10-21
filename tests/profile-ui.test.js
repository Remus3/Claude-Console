'use strict';
// CON-013 L5: setup-profile UI routes (server/profile-routes.js) against the seeded fake
// profile (tests/fixtures/profile-ui-seed.js) and in-memory adapters. Covers: browse
// state, item toggles with dependency confirm and conflicts, template edit with live
// validation, plan -> apply (dry run first, plan id, busy 409, high-risk acks, grouped
// consent), revert, secrets never echoed, the wizard path helpers and inputs, the crash
// report, stop everything / resume / recovery prompt, the machine-profile advisor,
// update offers, the adopt capability check, and the loopback rule on writes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tmpdir } = require('./helpers');
const S = require('./fixtures/profile-ui-seed');
const R = require('../server/profile-routes');
const recover = require('../installer/recover');

const SECRET = 'sk-test-THIS-MUST-NEVER-BE-ECHOED-0123456789';

function world(extra) {
  const root = tmpdir('cc-pui-');
  const profileDir = S.seedProfile(path.join(root, 'profile'));
  const dataDir = path.join(root, 'data');
  const runDir = path.join(root, 'run');
  const configDir = path.join(root, 'config');
  const repo = S.seedRepo(path.join(root, 'sample-api'));
  const docs = path.join(root, 'Documents');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const fakes = S.fakeAdapters({ binDir: path.join(root, 'bin') });
  const opened = [];
  const clips = [];
  const killed = [];
  const profile = Object.assign({
    profileDir, dataDir, runDir, configDir, adopt: null,
    deps: { env: fakes.env, tasks: fakes.tasks, git: fakes.git, recycle: fakes.recycle },
    secrets: fakes.secrets,
    detect: (name) => (name === 'python' ? 'python' : null),
    openUrl: async (u) => { opened.push(u); return true; },
    clipboard: async (t) => { clips.push(t); return true; },
    documents: docs,
    procInfo: (pid) => (killed.includes(pid) ? { alive: false } : { alive: true, name: 'cmd.exe', startMs: 1000, pid }),
    killTree: (pid) => { killed.push(pid); return true; },
    username: 'nobody-x', hostname: 'host-x', home: path.join(root, 'home'),
    projects: () => [{ id: 'sample-api', name: 'sample-api', dir: repo }],
    version: '0.1.3-test',
  }, extra || {});
  return { root, profileDir, dataDir, runDir, configDir, repo, docs, fakes, opened, clips, killed, profile };
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      try {
        if (!(await handler(req, res, url.pathname, req.method, url))) { res.writeHead(404); res.end('{}'); }
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function call(srv, method, p, body) {
  const r = await fetch('http://127.0.0.1:' + srv.address().port + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { j = null; }
  return { status: r.status, body: j, text };
}

async function withWorld(extra, fn) {
  const w = world(extra);
  const srv = await serve(R.createProfileRoutes({ profile: w.profile }));
  const seen = [];
  const c = async (m, p, b) => { const r = await call(srv, m, p, b); seen.push(r.text); return r; };
  try { await fn(w, c, seen); } finally { srv.close(); }
}

// ------------------------------------------------------------------ browse

test('GET /api/profile: 22 modules in order, items with does/why/risk/pairs, review step, capabilities', async () => {
  await withWorld({}, async (w, c) => {
    const r = await c('GET', '/api/profile');
    assert.strictEqual(r.status, 200);
    const b = r.body;
    assert.strictEqual(b.available, true);
    assert.deepStrictEqual(b.modules.map((m) => m.id), S.MODULES);
    assert.deepStrictEqual(b.modules.map((m) => m.order), S.MODULES.map((x, i) => i + 1));
    const floors = b.modules[0];
    assert.strictEqual(floors.locked, true);
    const sess = b.modules.find((m) => m.id === 'session');
    const env = sess.items.find((i) => i.id === 'conv-session-env');
    assert.strictEqual(env.risk, 'high');
    assert.deepStrictEqual(env.depends_on, ['conv-handoff-file']);
    assert.ok(env.does && env.why);
    assert.strictEqual(b.review.checkbox, "I've read this and I'm choosing what to enable");
    assert.ok(b.review.safeguards.length >= 7);
    assert.ok(b.presets.includes('remus3'));
    assert.deepStrictEqual(b.capabilities, { adopt: false, machine: true, crash: true, recover: true });
    assert.match(b.status.line, /^profile 1\.0\.0 - \d+ of 45 items on/);
    assert.strictEqual(b.firstRun, true);
    assert.strictEqual(b.offer, 'install', 'the wizard offers itself at install');
    assert.strictEqual((await c('POST', '/api/profile/offer/dismiss', {})).body.ok, true);
    assert.strictEqual((await c('GET', '/api/profile')).body.offer, null, 'once dismissed it stays closed');
  });
});

test('GET /api/profile without a profile in this build says so (no crash)', async () => {
  const w = world();
  fs.rmSync(path.join(w.profileDir, 'profile.json'));
  const srv = await serve(R.createProfileRoutes({ profile: w.profile }));
  try {
    const r = await call(srv, 'GET', '/api/profile');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.available, false);
  } finally { srv.close(); }
});

test('GET /api/profile/item: templates for the view / edit pane', async () => {
  await withWorld({}, async (w, c) => {
    const r = await c('GET', '/api/profile/item?id=conv-handoff-file');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.item.id, 'conv-handoff-file');
    assert.strictEqual(r.body.templates.length, 1);
    assert.match(r.body.templates[0].text, /^SESSION: 1/);
    assert.strictEqual(r.body.templates[0].source, 'shipped');
    assert.ok(r.body.variables.some((v) => v.name === 'repo_code'));
    assert.strictEqual((await c('GET', '/api/profile/item?id=nope')).status, 404);
  });
});

// ------------------------------------------------------------------ toggles

test('toggle: a dependency asks first, then turns on together; disabling lists dependants; locked refuses', async () => {
  await withWorld({}, async (w, c) => {
    // race-guards is off by default; item 2 depends on item 1.
    let r = await c('POST', '/api/profile/toggle', { id: 'race-guards-item-2', on: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.needsConfirm, true);
    assert.deepStrictEqual(r.body.also.map((x) => x.id), ['race-guards-item-1']);
    let st = (await c('GET', '/api/profile')).body;
    assert.strictEqual(st.modules.find((m) => m.id === 'race-guards').on, 0, 'nothing saved before the confirm');
    r = await c('POST', '/api/profile/toggle', { id: 'race-guards-item-2', on: true, confirm: true });
    assert.strictEqual(r.body.ok, true);
    st = (await c('GET', '/api/profile')).body;
    assert.strictEqual(st.modules.find((m) => m.id === 'race-guards').on, 2);
    r = await c('POST', '/api/profile/toggle', { id: 'race-guards-item-1', on: false });
    assert.strictEqual(r.body.needsConfirm, true);
    assert.deepStrictEqual(r.body.also.map((x) => x.id), ['race-guards-item-2']);
    r = await c('POST', '/api/profile/toggle', { id: 'floors', on: false, confirm: true });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /always on/);
    // module toggle
    r = await c('POST', '/api/profile/toggle', { id: 'board', on: true, confirm: true });
    assert.strictEqual(r.body.ok, true);
    st = (await c('GET', '/api/profile')).body;
    assert.strictEqual(st.modules.find((m) => m.id === 'board').on, 1);
    assert.ok(st.status.pending > 0, 'pending changes counted for the Review slot');
  });
});

test('toggle: a conflict shows both explanations and changes nothing', async () => {
  await withWorld({}, async (w, c) => {
    const r = await c('POST', '/api/profile/toggle', { id: 'md-wakeup-notes', on: true, confirm: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, false);
    assert.strictEqual(r.body.conflict.a.id, 'md-wakeup-notes');
    assert.strictEqual(r.body.conflict.b.id, 'docs-memory-item-2');
    assert.ok(r.body.conflict.a.why && r.body.conflict.b.why);
    const st = (await c('GET', '/api/profile')).body;
    assert.strictEqual(st.modules.find((m) => m.id === 'docs-memory').items.find((i) => i.id === 'md-wakeup-notes').state, 'off');
  });
});

// ------------------------------------------------------------------ edit

test('edit: live validation refuses non-ASCII, unknown variables and literal paths; save and reset an override', async () => {
  await withWorld({}, async (w, c) => {
    let r = await c('POST', '/api/profile/check', { text: 'caf\u00e9 {nope} C:\\Users\\x\n' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.errors.some((e) => /non-ASCII/.test(e)));
    assert.ok(r.body.errors.some((e) => /unknown variable \{nope\}/.test(e)));
    assert.ok(r.body.errors.some((e) => /literal path/.test(e)));
    r = await c('POST', '/api/profile/edit', { id: 'core-rules-item-1', text: 'bad \u00e9\n' });
    assert.strictEqual(r.status, 400);
    r = await c('POST', '/api/profile/edit', { id: 'core-rules-item-1', text: '# Mine\n\nRepo {repo_code}.\n' });
    assert.strictEqual(r.body.ok, true);
    r = await c('GET', '/api/profile/item?id=core-rules-item-1');
    assert.strictEqual(r.body.templates[0].source, 'override');
    assert.match(r.body.templates[0].text, /^# Mine/);
    r = await c('POST', '/api/profile/edit', { id: 'core-rules-item-1', reset: true });
    assert.strictEqual(r.body.ok, true);
    r = await c('GET', '/api/profile/item?id=core-rules-item-1');
    assert.strictEqual(r.body.templates[0].source, 'shipped');
  });
});

// ------------------------------------------------------------------ plan / apply / revert

test('plan -> apply: dry run first (plan id), high risk needs acks, apply writes, verify rows, revert restores', async () => {
  await withWorld({}, async (w, c) => {
    const target = { project: 'sample-api' };
    const values = { repo_code: 'SA', operator_ident: 'Sam Example <sam@example.com>' };
    let r = await c('POST', '/api/profile/apply', { confirm: true });
    assert.strictEqual(r.status, 400, 'apply without a plan id is refused');
    r = await c('POST', '/api/profile/plan', { target, values });
    assert.strictEqual(r.status, 200);
    const plan = r.body;
    assert.match(plan.planId, /^[0-9a-f]{16}$/);
    assert.ok(plan.counts.new > 0);
    assert.match(plan.diff, /sample-api|SA-NEXT-SESSION\.txt/);
    assert.ok(plan.highRisk.some((x) => x.id === 'conv-session-env'));
    assert.ok(!JSON.stringify(plan).includes('"value"'), 'no machine values in the plan answer');
    assert.ok(!fs.existsSync(path.join(w.repo, 'SA-NEXT-SESSION.txt')), 'dry run wrote nothing');
    r = await c('POST', '/api/profile/apply', { planId: plan.planId });
    assert.strictEqual(r.status, 400, 'confirm required');
    r = await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true });
    assert.strictEqual(r.body.ok, false);
    assert.match(r.body.line, /high risk/);
    r = await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, acks: plan.highRisk.map((x) => x.id) });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(r.body.tx);
    assert.ok(Array.isArray(r.body.verify) && r.body.verify.length > 0);
    assert.ok(r.body.verify.every((v) => v.check !== 'verify'), 'verify ran: ' + JSON.stringify(r.body.verify[0]));
    assert.ok(fs.existsSync(path.join(w.repo, 'SA-NEXT-SESSION.txt')));
    assert.strictEqual(w.fakes.env.m.get('PYTHONUTF8'), '1');
    r = await c('GET', '/api/profile/tx');
    assert.strictEqual(r.body.tx.length, 1);
    r = await c('POST', '/api/profile/revert', { tx: 'last' });
    assert.strictEqual(r.body.dryRun, true);
    assert.ok(fs.existsSync(path.join(w.repo, 'SA-NEXT-SESSION.txt')), 'revert dry run changes nothing');
    r = await c('POST', '/api/profile/revert', { tx: 'last', confirm: true });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(!fs.existsSync(path.join(w.repo, 'SA-NEXT-SESSION.txt')));
    assert.ok(!w.fakes.env.m.has('PYTHONUTF8'));
  });
});

test('apply: a stale plan id is refused (409) and a second apply while one runs is busy (409)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const P = require('../installer/profile');
  const openEngine = (o) => { const e = P.openEngine(o); const ap = e.apply; e.apply = async (p, a) => { await gate; return ap(p, a); }; return e; };
  await withWorld({ openEngine }, async (w, c) => {
    const p1 = (await c('POST', '/api/profile/plan', { target: { project: 'sample-api' }, values: { repo_code: 'SA' }, only: ['core-rules'] })).body;
    // the target changes after the plan: the stored plan no longer matches
    fs.mkdirSync(path.join(w.repo, 'docs', 'profile'), { recursive: true });
    fs.writeFileSync(path.join(w.repo, 'docs', 'profile', 'core-rules-1.md'), 'someone else\n');
    let r = await c('POST', '/api/profile/apply', { planId: p1.planId, confirm: true });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /changed since the preview/);
    fs.rmSync(path.join(w.repo, 'docs'), { recursive: true });
    const p2 = (await c('POST', '/api/profile/plan', { target: { project: 'sample-api' }, values: { repo_code: 'SA' }, only: ['core-rules'] })).body;
    const first = c('POST', '/api/profile/apply', { planId: p2.planId, confirm: true });
    await new Promise((r2) => setTimeout(r2, 100));
    r = await c('POST', '/api/profile/apply', { planId: p2.planId, confirm: true });
    assert.strictEqual(r.status, 409);
    assert.match(r.body.error, /busy|running/);
    release();
    assert.strictEqual((await first).body.ok, true);
  });
});

test('apply with a wizard draft: grouped consent stands in for the per-item acks and the selection is saved with the review tick', async () => {
  await withWorld({}, async (w, c) => {
    const pre = (await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3', skipped: ['headless_base_url', 'secret:anthropic-key'] })).body;
    assert.ok(pre.offNeeds.some((x) => x.item === 'hl-kill-switch'));
    const draft = Object.assign({}, pre.selection, { review_ack: { version: '1.0.0', at: '2026-10-18T00:00:00Z' } });
    const values = { repo_code: 'SA', operator_ident: 'Sam Example <sam@example.com>' };
    const plan = (await c('POST', '/api/profile/plan', { target: { project: 'sample-api' }, draft, values })).body;
    assert.ok(plan.highRisk.length > 0);
    assert.ok(plan.tasks.length > 0, 'the preview lists the scheduled tasks it registers');
    const names = plan.tasks.map((t) => t.name);
    let r = await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, groupedConsent: true });
    assert.strictEqual(r.body.ok, false, 'the grouped high-risk consent alone does not consent to tasks');
    r = await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, groupedConsent: true, taskConsent: { mode: 'grouped', yes: true, listed: names.slice(1) } });
    assert.match(r.body.line, /did not list/);
    r = await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, groupedConsent: true, taskConsent: { mode: 'grouped', yes: true, listed: names } });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    const st = (await c('GET', '/api/profile')).body;
    assert.strictEqual(st.selection.path, 'preset');
    assert.strictEqual(st.selection.preset, 'remus3');
    assert.ok(st.selection.review_ack);
    assert.strictEqual(st.firstRun, false);
  });
});

test('FB-1021: user-scope settings apply to another account dir (files only, its own lock); unknown account refused', async () => {
  const acct2 = path.join(tmpdir('cc-pui-a2-'), 'acct2cfg');
  fs.mkdirSync(acct2, { recursive: true });
  const w = world({ accountDirs: () => ({ acct2: { dir: acct2, label: 'Account 2' } }) });
  // one item gains a user settings key next to its repo file
  const mf = path.join(w.profileDir, 'modules', 'core-rules', 'module.json');
  const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
  mj.items[0].contributes.push({ kind: 'json-merge', target: 'user:settings.json', value: { effortLevel: 'high' }, mode: 'add' });
  fs.writeFileSync(mf, JSON.stringify(mj, null, 2) + '\n');
  const srv = await serve(R.createProfileRoutes({ profile: w.profile }));
  const c = (m, p, b) => call(srv, m, p, b);
  try {
    const st = (await c('GET', '/api/profile')).body;
    assert.deepStrictEqual(st.accounts, [{ id: 'acct2', label: 'Account 2' }]);
    assert.ok(!JSON.stringify(st.accounts).includes('acct2cfg'), 'no dir leaves the server');
    assert.strictEqual((await c('POST', '/api/profile/plan', { target: { account: 'nope' } })).status, 400);
    const id = mj.items[0].id;
    const plan = (await c('POST', '/api/profile/plan', { target: { account: 'acct2' }, only: [id, 'out-no-flicker'] })).body;
    assert.ok(plan.rows.some((r) => r.item === id && r.kind === 'json-merge' && r.status === 'new'), JSON.stringify(plan.rows));
    assert.ok(plan.rows.some((r) => r.item === 'out-no-flicker' && r.status === 'skipped' && /machine-wide/.test(r.reason)), 'env stays with the main account');
    const r = (await c('POST', '/api/profile/apply', { planId: plan.planId, confirm: true, acks: plan.highRisk.map((x) => x.id) })).body;
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(acct2, 'settings.json'), 'utf8')).effortLevel, 'high');
    assert.ok(!fs.existsSync(path.join(w.configDir, 'settings.json')), 'the primary account dir is untouched');
    assert.ok(!w.fakes.env.m.has('CLAUDE_CODE_NO_FLICKER'), 'no env var from the other-account apply');
    const locks = fs.readdirSync(path.join(w.dataDir, 'profile', 'locks'));
    assert.ok(locks.some((n) => /^user-[0-9a-f]{12}\.json$/.test(n)) && !locks.includes('user.json'), locks.join(','));
    const lk = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'profile', 'locks', locks.find((n) => n.startsWith('user-'))), 'utf8'));
    assert.strictEqual(path.resolve(lk.configDir), path.resolve(acct2));
    // the primary plan still reads its own (empty) user lock: the item is new there
    const p0 = (await c('POST', '/api/profile/plan', { target: {}, only: [id] })).body;
    assert.ok(p0.rows.some((x) => x.item === id && x.kind === 'json-merge' && x.status === 'new'));
  } finally { srv.close(); }
});

// CON-FB-2ND: a contribution marked account "second" (hl-account-quiet's quiet keys) lands
// only in another account's dir; the main account's plan skips it with a reason. "main" is
// the reverse. The shipped hl-account-quiet item carries the mark.
test('CON-FB-2ND: account "second" contributions skip the main account and land on the other one', async () => {
  const acct2 = path.join(tmpdir('cc-pui-a2q-'), 'acct2cfg');
  fs.mkdirSync(acct2, { recursive: true });
  const w = world({ accountDirs: () => ({ acct2: { dir: acct2, label: 'Account 2' } }) });
  const mf = path.join(w.profileDir, 'modules', 'core-rules', 'module.json');
  const mj = JSON.parse(fs.readFileSync(mf, 'utf8'));
  mj.items[0].contributes.push({ kind: 'json-merge', target: 'user:settings.json', value: { feedbackDrafts: 'quiet' }, mode: 'add', account: 'second' });
  mj.items[0].contributes.push({ kind: 'json-merge', target: 'user:settings.json', value: { effortLevel: 'high' }, mode: 'add', account: 'main' });
  fs.writeFileSync(mf, JSON.stringify(mj, null, 2) + '\n');
  const id = mj.items[0].id;
  const srv = await serve(R.createProfileRoutes({ profile: w.profile }));
  const c = (m, p, b) => call(srv, m, p, b);
  try {
    const p0 = (await c('POST', '/api/profile/plan', { target: {}, only: [id] })).body;
    assert.ok(p0.rows.some((x) => x.item === id && x.kind === 'json-merge' && x.status === 'skipped' && /second account only/.test(x.reason)), JSON.stringify(p0.rows));
    const r0 = (await c('POST', '/api/profile/apply', { planId: p0.planId, confirm: true, acks: p0.highRisk.map((x) => x.id) })).body;
    assert.strictEqual(r0.ok, true, JSON.stringify(r0));
    const main = JSON.parse(fs.readFileSync(path.join(w.configDir, 'settings.json'), 'utf8'));
    assert.strictEqual(main.feedbackDrafts, undefined, 'no quiet key on the main account');
    assert.strictEqual(main.effortLevel, 'high');
    const p2 = (await c('POST', '/api/profile/plan', { target: { account: 'acct2' }, only: [id] })).body;
    assert.ok(p2.rows.some((x) => x.item === id && x.status === 'skipped' && /main account only/.test(x.reason)), JSON.stringify(p2.rows));
    const r2 = (await c('POST', '/api/profile/apply', { planId: p2.planId, confirm: true, acks: p2.highRisk.map((x) => x.id) })).body;
    assert.strictEqual(r2.ok, true, JSON.stringify(r2));
    const sec = JSON.parse(fs.readFileSync(path.join(acct2, 'settings.json'), 'utf8'));
    assert.deepStrictEqual([sec.feedbackDrafts, sec.effortLevel], ['quiet', undefined]);
  } finally { srv.close(); }
  const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'profile', 'modules', 'headless', 'module.json'), 'utf8'));
  const q = shipped.items.find((x) => x.id === 'hl-account-quiet');
  assert.ok(q.contributes.every((x) => x.account === 'second'), 'hl-account-quiet targets the second account only');
});

test('FB-1021: the preset answer lists what it leaves off with a reason; review records the choice', async () => {
  await withWorld({}, async (w, c) => {
    const pre = (await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3' })).body;
    assert.ok(Array.isArray(pre.presetOff));
    const wk = pre.presetOff.find((x) => x.item === 'md-wakeup-notes');
    assert.ok(wk && wk.title && wk.why, JSON.stringify(pre.presetOff.slice(0, 3)));
    assert.ok(!pre.presetOff.some((x) => x.item.startsWith('floors-')), 'locked items are never listed off');
    const r = (await c('POST', '/api/profile/wizard', { op: 'record', selection: pre.selection, path: 'preset', skipped: ['headless_base_url'], values: { repo_code: 'SA', operator_ident: 'Sam Example <sam@example.com>' }, tasks: null })).body;
    assert.strictEqual(r.ok, true);
    const rec = JSON.parse(fs.readFileSync(path.join(w.dataDir, 'profile', 'wizard-review.json'), 'utf8'));
    assert.strictEqual(rec.preset, 'remus3');
    assert.deepStrictEqual(rec.skipped, ['headless_base_url']);
    assert.deepStrictEqual(rec.values, ['repo_code', 'operator_ident'], 'value names only');
    assert.ok(!JSON.stringify(rec).includes('sam@example.com'));
    assert.strictEqual(rec.tasks, 'unanswered');
    assert.strictEqual(rec.on.length, pre.on);
    assert.strictEqual((await c('GET', '/api/profile')).body.firstRun, true, 'a record is not an applied selection');
  });
});

// ------------------------------------------------------------------ wizard helpers + inputs

test('wizard: custom baseline from the preset, back to the preset counts the dropped toggles, inputs list what is needed', async () => {
  await withWorld({}, async (w, c) => {
    const pre = (await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3' })).body.selection;
    const cus = (await c('POST', '/api/profile/wizard', { op: 'custom', selection: pre })).body.selection;
    assert.strictEqual(cus.path, 'custom');
    assert.strictEqual(cus.items['hl-kill-switch'], 'on');
    assert.strictEqual((await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3' })).body.states['md-wakeup-notes'], 'off', 'effective states come with every wizard selection');
    cus.items['hl-kill-switch'] = 'off';
    cus.items['board-item-1'] = 'off';
    const back = (await c('POST', '/api/profile/wizard', { op: 'back', custom: cus, preset: pre })).body;
    assert.strictEqual(back.dropped, 2);
    const inp = (await c('POST', '/api/profile/wizard', { op: 'inputs', selection: pre })).body;
    const envNames = inp.env.map((e) => e.name);
    assert.ok(envNames.includes('PYTHONUTF8') && envNames.includes('CLAUDE_CODE_NO_FLICKER') && envNames.includes('CLAUDE_HEADLESS_BASE_URL'));
    const py = inp.env.find((e) => e.name === 'PYTHONUTF8');
    assert.ok(py.does && py.why && py.items.includes('conv-session-env'));
    assert.strictEqual(py.current, 'not set');
    assert.deepStrictEqual(inp.secrets.map((s) => s.name), ['anthropic-key']);
    assert.ok(inp.variables.some((v) => v.name === 'operator_ident' && v.items.includes('attr-operator-ident')));
    assert.ok(inp.variables.some((v) => v.name === 'headless_base_url'));
    assert.deepStrictEqual(inp.tasks.map((t) => t.name).sort(), ['ClaudeProfile-Insights', 'ClaudeProfile-TempHygiene']);
    assert.strictEqual(inp.account.needed, true);
    // skipping an input in path B turns its dependants off, named
    const cus2 = (await c('POST', '/api/profile/wizard', { op: 'custom', selection: pre })).body.selection;
    const sk = (await c('POST', '/api/profile/wizard', { op: 'skip', selection: cus2, skipped: ['secret:anthropic-key'] })).body;
    assert.deepStrictEqual(sk.offNeeds.map((x) => x.item).sort(), ['hl-api-key', 'hl-kill-switch']);
    assert.strictEqual(sk.selection.items['hl-api-key'], 'off');
    // saying no to an env variable or a task turns its items off, named
    const sk2 = (await c('POST', '/api/profile/wizard', { op: 'skip', selection: cus2, skipped: ['env:PYTHONUTF8', 'task:ClaudeProfile-Insights'] })).body;
    assert.deepStrictEqual(sk2.offNeeds.map((x) => x.item + '=' + x.needs.join('+')).sort(), ['conv-session-env=env:PYTHONUTF8', 'insights-task=task:ClaudeProfile-Insights']);
    // a draft toggle never touches selection.json and pulls dependencies in
    const tg = (await c('POST', '/api/profile/wizard', { op: 'toggle', selection: cus2, id: 'race-guards-item-1', on: false })).body;
    assert.strictEqual(tg.selection.items['race-guards-item-2'], 'off');
    assert.deepStrictEqual(tg.also.map((x) => x.id), ['race-guards-item-2']);
    // ask: the wizard's inline confirm (UX-F7): names what follows, changes nothing yet
    const ask = (await c('POST', '/api/profile/wizard', { op: 'toggle', selection: cus2, id: 'race-guards-item-1', on: false, ask: true })).body;
    assert.strictEqual(ask.needsConfirm, true);
    assert.match(ask.line, /^Turning this off also turns off: /);
    assert.deepStrictEqual(ask.also.map((x) => x.id), ['race-guards-item-2']);
    assert.notStrictEqual(ask.selection.items['race-guards-item-1'], 'off');
    assert.ok(!fs.existsSync(path.join(w.dataDir, 'profile', 'selection.json')));
    // preset buttons show a display title, not the raw preset name (UX-N8)
    const st = (await c('GET', '/api/profile')).body;
    assert.match(st.presetTitles.remus3, /^Remus3/);
  });
});

test('secrets: stored masked, never echoed by any route', async () => {
  await withWorld({}, async (w, c, seen) => {
    let r = await c('POST', '/api/profile/secret', { name: 'anthropic-key', value: SECRET });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.strictEqual(r.body.display, 'set (' + SECRET.length + ' chars)');
    r = await c('POST', '/api/profile/secret', { name: 'Bad Name', value: 'x' });
    assert.strictEqual(r.body.ok, false);
    const pre = (await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3' })).body.selection;
    const inp = (await c('POST', '/api/profile/wizard', { op: 'inputs', selection: pre })).body;
    assert.strictEqual(inp.secrets[0].display, 'set (' + SECRET.length + ' chars)');
    await c('GET', '/api/profile');
    await c('POST', '/api/profile/plan', { target: { user: true }, draft: pre, values: { repo_code: 'SA' } });
    for (const t of seen) assert.ok(!t.includes(SECRET), 'a response echoed the secret');
  });
});

// ------------------------------------------------------------------ update

test('update: an untouched preset user is offered the latest preset with a diff; a customised user gets the merge view', async () => {
  const root = tmpdir('cc-pui-upd-');
  const updateDir = S.seedProfile(path.join(root, 'new'), { version: '1.1.0', extraItem: true });
  await withWorld({ updateDir }, async (w, c) => {
    let r = await c('GET', '/api/profile/update');
    assert.strictEqual(r.body.mode, 'custom', 'no selection yet: only a new-items count');
    const pre = (await c('POST', '/api/profile/wizard', { op: 'preset', name: 'remus3' })).body.selection;
    fs.mkdirSync(path.join(w.dataDir, 'profile'), { recursive: true });
    fs.writeFileSync(path.join(w.dataDir, 'profile', 'selection.json'), JSON.stringify(pre));
    r = await c('GET', '/api/profile/update');
    assert.strictEqual(r.body.mode, 'preset');
    assert.ok(r.body.diff.some((d) => d.item === 'lessons-new-rule' && d.change === 'added'));
    assert.match(r.body.line, /Update to the latest remus3 settings/);
    const cus = Object.assign({}, pre, { items: Object.assign({}, pre.items, { 'board-item-1': 'off' }) });
    fs.writeFileSync(path.join(w.dataDir, 'profile', 'selection.json'), JSON.stringify(cus));
    r = await c('GET', '/api/profile/update');
    assert.strictEqual(r.body.mode, 'merge');
    assert.ok(Array.isArray(r.body.conflicts));
  });
});

// ------------------------------------------------------------------ crash report

test('crash report: exact preview first, then one confirmed action (issue on Remus3/Claude-Console, ask Claude, save)', async () => {
  await withWorld({}, async (w, c) => {
    fs.writeFileSync(path.join(w.runDir, 'server.log'), 'line one\nERROR something failed for nobody-x at ' + w.profile.home + '\n');
    let r = await c('POST', '/api/profile/crash', { step: { id: 'apply', exit: 1, reason: 'read-back mismatch' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.ok, true);
    assert.ok(r.body.bytes > 0);
    assert.match(r.body.text, /failing step: apply \(exit 1\): read-back mismatch/);
    assert.ok(!r.body.text.includes('nobody-x'), 'user name scrubbed');
    const id = r.body.id;
    r = await c('POST', '/api/profile/crash/action', { id, action: 'issue' });
    assert.strictEqual(r.body.ok, false, 'needs confirm');
    r = await c('POST', '/api/profile/crash/action', { id, action: 'issue', confirm: true });
    assert.strictEqual(r.body.ok, true);
    assert.match(w.opened[0], /^https:\/\/github\.com\/Remus3\/Claude-Console\/issues\/new\?/);
    r = await c('POST', '/api/profile/crash/action', { id, action: 'claude', confirm: true });
    assert.strictEqual(r.body.via, 'pane');
    assert.match(r.body.text, /^This is a Claude Console crash report\./);
    r = await c('POST', '/api/profile/crash/action', { id, action: 'save', confirm: true });
    assert.ok(r.body.file && fs.existsSync(r.body.file) && r.body.file.startsWith(w.docs));
    r = await c('POST', '/api/profile/crash/action', { id: 'nope', action: 'save', confirm: true });
    assert.strictEqual(r.status, 404);
  });
});

// ------------------------------------------------------------------ stop everything / help

test('stop everything: dry run line first, then stops recorded spawns only; resume; recovery prompt copies and opens claude.ai', async () => {
  await withWorld({}, async (w, c) => {
    recover.registerSpawn(w.runDir, { pid: 4242, kind: 'pane', name: 'cmd.exe', startMs: 1000 });
    let r = await c('POST', '/api/recover/stop', {});
    assert.strictEqual(r.body.dryRun, true);
    assert.match(r.body.line, /stop 1 console process tree/);
    assert.deepStrictEqual(w.killed, []);
    r = await c('POST', '/api/recover/stop', { confirm: true });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    assert.deepStrictEqual(w.killed, [4242]);
    assert.ok(fs.existsSync(recover.markerFile(w.dataDir)), 'hooks-off marker written');
    r = await c('POST', '/api/recover/resume', { confirm: true });
    assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
    assert.ok(!fs.existsSync(recover.markerFile(w.dataDir)));
    r = await c('POST', '/api/recover/prompt', {});
    assert.match(r.body.text, /## Undo steps/);
    r = await c('POST', '/api/recover/prompt/go', {});
    assert.strictEqual(r.body.ok, false, 'needs confirm');
    r = await c('POST', '/api/recover/prompt/go', { confirm: true });
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(w.opened, ['https://claude.ai/new']);
    assert.match(w.clips[0], /## Undo steps/);
  });
});

// ------------------------------------------------------------------ machine profile

test('machine advisor: advise (read-only), preview per change, apply only the accepted ids, revert, delete', async () => {
  const calls = [];
  const machine = {
    advise: () => ({ schema: 1, stamp: '20261018-120000', created: 'x', findings: ['RAM 32 GB: suite slots 4 fit'], proposals: [
      { id: 'game.res', kind: 'app-config', title: 'Render scale 100', why: 'matches the screen', target: { file: 'x.ini', key: 'a' }, to: 1 },
      { id: 'game.vsync', kind: 'app-config', title: 'VSync off', why: 'lower latency', target: { file: 'x.ini', key: 'b' }, to: 0 }] }),
    preview: (adv) => ({ rows: adv.proposals.map((p) => ({ id: p.id, status: 'change', from: 0, to: p.to, label: p.title })) }),
    apply: async (dataDir, adv, o) => { calls.push(['apply', adv.proposals.map((p) => p.id), o.accept]); return { ok: true, txDir: path.join(dataDir, 'machine', 'tx', 't1') }; },
    revert: async (txDir) => { calls.push(['revert', path.basename(txDir)]); return { ok: true }; },
    deleteData: async () => { calls.push(['delete']); return { recycled: true }; },
  };
  await withWorld({ machine }, async (w, c) => {
    let r = await c('POST', '/api/machine/advise', {});
    assert.strictEqual(r.body.proposals.length, 2);
    assert.ok(r.body.proposals.every((p) => p.default === undefined || p.default === 'off'));
    r = await c('POST', '/api/machine/preview', { stamp: '20261018-120000', accept: ['game.vsync'] });
    assert.deepStrictEqual(r.body.rows.map((x) => x.id), ['game.vsync']);
    r = await c('POST', '/api/machine/apply', { stamp: '20261018-120000', accept: ['game.vsync'] });
    assert.strictEqual(r.body.ok, false, 'needs confirm');
    r = await c('POST', '/api/machine/apply', { stamp: '20261018-120000', accept: ['game.vsync'], confirm: true });
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(calls[0][2], ['game.vsync']);
    r = await c('POST', '/api/machine/revert', { tx: r.body.tx, confirm: true });
    assert.strictEqual(r.body.ok, true);
    assert.deepStrictEqual(calls[1], ['revert', 't1']);
    r = await c('POST', '/api/machine/delete', { confirm: true });
    assert.strictEqual(r.body.recycled, true);
  });
});

// ------------------------------------------------------------------ adopt capability

test('adopt capability: on with the openAdopt facade (the real module by default), off without it', async () => {
  // The adopt steps themselves are served by server/adopt-routes.js on the real L3x
  // module (tests/profile-ui-adopt.test.js); the profile routes only report the capability.
  await withWorld({ adopt: undefined }, async (w, c) => {
    assert.strictEqual((await c('GET', '/api/profile')).body.capabilities.adopt, true, 'the shipped profile-adopt exports openAdopt');
  });
  await withWorld({ adopt: { cliAdopt: async () => 0 } }, async (w, c) => {
    assert.strictEqual((await c('GET', '/api/profile')).body.capabilities.adopt, false, 'a module without openAdopt is no adopt');
  });
  await withWorld({ adopt: { openAdopt: () => ({}) } }, async (w, c) => {
    assert.strictEqual((await c('GET', '/api/profile')).body.capabilities.adopt, true);
  });
});

// ------------------------------------------------------------------ loopback

test('writes are refused from a non-loopback peer (403); reads still answer', async () => {
  const w = world();
  const srv = await serve(R.createProfileRoutes({ profile: w.profile, isLoopback: () => false }));
  try {
    assert.strictEqual((await call(srv, 'POST', '/api/profile/toggle', { id: 'board', on: true, confirm: true })).status, 403);
    assert.strictEqual((await call(srv, 'POST', '/api/profile/apply', { planId: 'x', confirm: true })).status, 403);
    assert.strictEqual((await call(srv, 'POST', '/api/recover/stop', { confirm: true })).status, 403);
    assert.strictEqual((await call(srv, 'POST', '/api/profile/secret', { name: 'a', value: 'b' })).status, 403);
    assert.strictEqual((await call(srv, 'GET', '/api/profile')).status, 200);
    assert.strictEqual((await call(srv, 'GET', '/api/other')).status, 404);
  } finally { srv.close(); }
});

// ------------------------------------------------------------------ through server.js

test('server.js: profile routes behind the token, panes recorded for stop-all, machine health steps mounted off, UI files served', { timeout: 60000 }, async (t) => {
  const { createConsoleServer } = require('../server/server');
  const { makeFixture } = require('./helpers');
  const fx = makeFixture();
  const w = world();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd' }),
    profile: { profileDir: w.profileDir, deps: { env: w.fakes.env, tasks: w.fakes.tasks, git: w.fakes.git, recycle: w.fakes.recycle }, secrets: w.fakes.secrets, adopt: null } });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  assert.strictEqual((await fetch(base + '/api/profile')).status, 401);
  const st = await (await fetch(base + '/api/profile', { headers: H })).json();
  assert.strictEqual(st.available, true);
  assert.strictEqual(st.modules.length, 22);
  for (const f of ['/profile.js', '/profile.css', '/setup-paths.js', '/recovery.js']) assert.strictEqual((await fetch(base + f)).status, 200, f);
  const hs = await (await fetch(base + '/api/health', { headers: H })).json();
  const mach = hs.steps.filter((s) => s.group === 'Machine');
  assert.deepStrictEqual(mach.map((s) => s.id), ['machine.temp', 'machine.disk', 'machine.scratch']);
  assert.ok(mach.every((s) => s.default === false && s.deletes === null));
  // a shell pane is recorded in run/spawned, and the record goes when it exits
  const pane = await (await fetch(base + '/api/panes', { method: 'POST', headers: H, body: JSON.stringify({ kind: 'shell', shell: 'cmd' }) })).json();
  const recs = recover.listSpawned(fx.runDir);
  const rec = recs.find((r) => r.pid === pane.pid);
  assert.ok(rec, 'pane pid recorded: ' + JSON.stringify(recs));
  assert.strictEqual(rec.kind, 'pane');
  assert.strictEqual(rec.name.toLowerCase(), 'cmd.exe');
  assert.ok(Number.isInteger(rec.startMs));
  await fetch(base + '/api/panes/' + pane.id, { method: 'DELETE', headers: H });
  const end = Date.now() + 10000;
  while (Date.now() < end && recover.listSpawned(fx.runDir).some((r) => r.pid === pane.pid)) await new Promise((r) => setTimeout(r, 200));
  assert.ok(!recover.listSpawned(fx.runDir).some((r) => r.pid === pane.pid), 'record removed on exit');
  // a test server never gets real OS hooks: the crash issue action refuses
  const cr = await (await fetch(base + '/api/profile/crash', { method: 'POST', headers: H, body: '{}' })).json();
  const act = await fetch(base + '/api/profile/crash/action', { method: 'POST', headers: H, body: JSON.stringify({ id: cr.id, action: 'issue', confirm: true }) });
  assert.strictEqual(act.status, 500);
  assert.match((await act.json()).error, /disabled on a test server/);
});
