'use strict';
// CON-013 L5: the pure client helpers of the setup profile UI (public/profile.js,
// public/setup-paths.js, public/recovery.js) and the page-file rules: ASCII + LF, colours
// only from tokens, the type scale, every dialog and entry point present.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PF = require('../public/profile.js').Profile;
const SP = require('../public/setup-paths.js').Setup;
const RV = require('../public/recovery.js').Recovery;

test('WP-8 helpers: Leave out folders, adoption status words, a finding with its next step, the open-stop line', () => {
  assert.deepStrictEqual(PF.excludeList(' node_modules , dist/, node_modules,, '), { list: ['node_modules', 'dist'], bad: [] });
  assert.deepStrictEqual(PF.excludeList(''), { list: [], bad: [] });
  assert.deepStrictEqual(PF.excludeList('a/b, ..,c+d, ok'), { list: ['ok'], bad: ['a/b', '..', 'c+d'] }, 'a shape the route would drop in silence is refused');
  assert.strictEqual(PF.adoptStatusWord('check-failed'), 'function check failed');
  assert.strictEqual(PF.adoptStatusWord('later-state'), 'later-state');
  assert.strictEqual(PF.findingText({ title: 'Memory runs below its rated speed', body: 'Modules rated 5600 MT/s are running at 5200 MT/s.', do: 'Check the firmware.' }), 'Memory runs below its rated speed. Modules rated 5600 MT/s are running at 5200 MT/s. Check the firmware.');
  assert.strictEqual(PF.findingText('RAM 32 GB'), 'RAM 32 GB');
  assert.strictEqual(PF.findingText({ other: 1 }), '');
  assert.strictEqual(RV.openStopLine('resume would: re-enable 1 task(s) - confirm to go ahead'), 'A stop is still open. resume would: re-enable 1 task(s)');
});

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

test('browser: module glyph + word + count, never colour alone', () => {
  assert.strictEqual(PF.moduleGlyph({ locked: true, on: 8, total: 8 }), '[+]');
  assert.strictEqual(PF.moduleCount({ locked: true, on: 8, total: 8 }), 'always on');
  assert.strictEqual(PF.moduleGlyph({ on: 0, total: 6 }), '[ ]');
  assert.strictEqual(PF.moduleGlyph({ on: 3, total: 6 }), '[~]', 'partly on: [~] (UX-N9), never the idle [-]');
  assert.strictEqual(PF.moduleGlyph({ on: 6, total: 6 }), '[+]');
  assert.strictEqual(PF.moduleCount({ on: 3, total: 6 }), '3/6');
  assert.strictEqual(PF.riskWord('high'), '! high risk');
  assert.strictEqual(PF.riskWord('medium'), 'medium');
  assert.strictEqual(PF.riskWord('low'), 'low');
  assert.strictEqual(PF.scopeWord({ windowsOnly: true, scope: 'template' }), 'Windows only, template');
  assert.strictEqual(PF.stateWord({ locked: true }), 'always on');
  assert.strictEqual(PF.stateWord({ state: 'off' }), 'off');
  assert.strictEqual(PF.listText(['a', 'b'], { a: { title: 'A' } }), 'A, b');
  assert.strictEqual(PF.listText([], {}), '-');
});

test('review: plan grouped per module in profile order; typed acks complete only when every phrase matches', () => {
  const modules = [{ id: 'b', title: 'B', order: 2, items: [{ id: 'b1' }] }, { id: 'a', title: 'A', order: 1, items: [{ id: 'a1' }, { id: 'a2' }] }];
  const g = PF.groupPlan({ rows: [{ item: 'b1', status: 'new' }, { item: 'a2', status: 'differs' }, { item: 'a1', status: 'new' }] }, modules);
  assert.deepStrictEqual(g.map((x) => x.module), ['a', 'b']);
  assert.deepStrictEqual(g[0].counts, { differs: 1, new: 1 });
  assert.strictEqual(PF.countsText({ new: 2, differs: 1, same: 0 }), '2 new, 1 differs');
  assert.strictEqual(PF.countsText({}), 'nothing to change');
  const hr = [{ id: 'x' }, { id: 'y' }];
  assert.strictEqual(PF.acksComplete(hr, { x: 'apply x' }), false);
  assert.strictEqual(PF.acksComplete(hr, { x: 'apply x', y: ' apply y ' }), true);
  assert.strictEqual(PF.acksComplete([], {}), true);
  assert.strictEqual(PF.verifyGlyph({ running: true }), '[>]');
  assert.strictEqual(PF.verifyGlyph({ ok: true }), '[+]');
  assert.strictEqual(PF.verifyGlyph({ ok: false }), '[x]');
  assert.strictEqual(PF.verifyWord({ skipped: true }), 'skipped');
});

test('adopt: glyph + word per status, defaults pre-check only missing + low risk + no break risk, file:line', () => {
  assert.strictEqual(PF.adoptGlyph('conforms') + ' ' + PF.adoptWord('conforms'), '[+] conforms');
  assert.strictEqual(PF.adoptGlyph('differs') + ' ' + PF.adoptWord('differs'), '[~] differs');
  assert.strictEqual(PF.adoptGlyph('missing') + ' ' + PF.adoptWord('missing'), '[ ] missing');
  assert.strictEqual(PF.adoptGlyph('conflicts') + ' ' + PF.adoptWord('conflicts'), '[x] conflicts');
  assert.strictEqual(PF.adoptGlyph('local-only') + ' ' + PF.adoptWord('local-only'), '[-] local');
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low' }), true);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', break_risk: 'path-read' }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { risk: 'low' }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'high' }), false);
  // The real L3x shapes: the engine's own default wins; report-only rows are no choice.
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', default: false }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { risk: 'low', default: true }), true);
  assert.strictEqual(PF.adoptDefault({ status: 'missing' }, { risk: 'low', breakRisk: { class: 'crlf-required', reasons: [] } }), false);
  assert.strictEqual(PF.adoptDefault({ status: 'differs' }, { reportOnly: true, default: true }), false);
  assert.strictEqual(PF.adoptGlyph('off') + ' ' + PF.adoptWord('off'), '[-] off');
  assert.strictEqual(PF.rangeText([[12, 14], [20, 20]]), '12-14, 20');
  assert.strictEqual(PF.fileLine({ files: [{ file: 'CLAUDE.md', orig: [[12, 14]], copy: [[12, 18]] }] }), 'CLAUDE.md:12-14 -> 12-18');
  assert.strictEqual(PF.fileLine({ files: [{ file: 'a.md', orig: [], copy: [[1, 3]] }, { file: 'docs/b.md', orig: [[4, 4]], copy: [] }] }), 'a.md -> 1-3; docs/b.md:4');
  assert.strictEqual(PF.fileLine({ file: 'NOTES.md', files: [] }), 'NOTES.md');
  assert.strictEqual(PF.breakText({ breakRisk: { class: 'path-read', reasons: ['read by app/render.js:14'] } }), 'path-read: read by app/render.js:14');
  assert.strictEqual(PF.checkSide({ code: 0, ok: true, ms: 1200, timedOut: false, counts: { passed: 10, failed: 0, skipped: 0 } }), 'exit 0, 10 pass / 0 fail, 1.2 s');
  assert.strictEqual(PF.checkSide({ code: null, timedOut: true, ms: 10000, counts: null }), 'timed out, 10 s');
  assert.strictEqual(PF.verdictGlyph('WORSE'), '[x]');
});

test('wizard: Step x of y, y from what the path needs, update path, rail words', () => {
  const inputs = { env: [{ name: 'PYTHONUTF8' }, { name: 'ANTHROPIC_API_KEY', secret: 'k' }], secrets: [{ name: 'k' }], variables: [{ name: 'repo_code' }, { name: 'headless_base_url' }], tasks: [{ name: 'T' }], account: { needed: true } };
  const two = { accounts: 2 };
  assert.deepStrictEqual(SP.stepsFor('preset', inputs, two), ['path', 'glance', 'env', 'keys', 'account', 'details', 'tasks', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor('custom', inputs, two), ['path', 'modules', 'env', 'keys', 'account', 'details', 'tasks', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor('preset', { env: [], secrets: [], variables: [], tasks: [], account: { needed: false } }), ['path', 'glance', 'review', 'preview', 'apply']);
  assert.deepStrictEqual(SP.stepsFor(null, inputs, { update: true }), ['update', 'review', 'preview', 'apply']);
  const s = SP.stepsFor('preset', inputs, two);
  assert.strictEqual(SP.label(s, 0), 'Step 1 of 10 - How do you want to set up?');
  assert.strictEqual(SP.label(s, 7), 'Step 8 of 10 - Before you enable anything');
  assert.strictEqual(SP.label(s, 9), 'Step 10 of 10 - Apply and verify');
  assert.strictEqual(SP.rail, undefined, 'no visual rail row (R1-26)');
  // UX-F2: every rail item has its step name and state in words for screen readers
  assert.deepStrictEqual(['path', 'glance', 'review'].map((x, i, a) => SP.railWord(a, 1, i)), ['How do you want to set up?, done', 'Modules at a glance, current', 'Before you enable anything, to do']);
  // UX-F1: the chosen path card mark is outside the state vocabulary
  assert.strictEqual(SP.cardMark(true), '(o) ');
  assert.strictEqual(SP.cardMark(false), '( ) ');
  for (const k of s) assert.ok(SP.TITLES[k], 'title for ' + k);
});

test('wizard: the account step needs two accounts, the proxy env variable never has a card of its own (R1-7)', () => {
  const inputs = { env: [{ name: 'CLAUDE_HEADLESS_BASE_URL' }], secrets: [], variables: [{ name: 'headless_base_url' }], tasks: [], account: { needed: true } };
  assert.deepStrictEqual(SP.stepsFor('preset', inputs, { accounts: 2 }), ['path', 'glance', 'account', 'review', 'preview', 'apply']);
  for (const accounts of [1, 0, undefined]) assert.deepStrictEqual(SP.stepsFor('preset', inputs, { accounts }), ['path', 'glance', 'review', 'preview', 'apply'], String(accounts));
  assert.deepStrictEqual(SP.envCards({ env: [{ name: 'CLAUDE_HEADLESS_BASE_URL' }, { name: 'PYTHONUTF8' }, { name: 'K', secret: 'k' }] }).map((e) => e.name), ['PYTHONUTF8']);
  const x = { item: 'hl', title: 'Kill switch', needs: ['headless_base_url'] };
  assert.strictEqual(SP.offLine(x, { oneAccount: true }), '[ ] off - needs a second Claude account - Kill switch');
  assert.strictEqual(SP.offLine(x, { oneAccount: false }), '[ ] off - needs proxy URL - Kill switch');
});

test('wizard: a value that already has one asks nothing, so it alone makes no details step (D7)', () => {
  const v = (variables) => ({ env: [], secrets: [], variables, tasks: [], account: { needed: false } });
  assert.ok(!SP.stepsFor('preset', v([{ name: 'effort_level', value: 'xhigh' }]), {}).includes('details'));
  assert.ok(SP.stepsFor('preset', v([{ name: 'effort_level', value: 'xhigh' }, { name: 'repo_code', value: null }]), {}).includes('details'));
});

test('wizard: start-skipped inputs seed once, so an untick stays (R1-6, R1-7)', () => {
  const inputs = { variables: [{ name: 'wol_mac', startSkipped: true }, { name: 'repo_code', startSkipped: false }, { name: 'headless_base_url' }], account: { needed: true } };
  const seen = new Set();
  assert.deepStrictEqual(SP.startSkips(inputs, 1, seen), ['wol_mac', 'headless_base_url']);
  assert.deepStrictEqual(SP.startSkips(inputs, 1, seen), [], 'a second read of the inputs adds nothing back');
  assert.deepStrictEqual(SP.startSkips(inputs, 2, new Set()), ['wol_mac'], 'two accounts: the proxy is asked, not skipped');
  assert.deepStrictEqual(SP.startSkips({ variables: [], account: { needed: false } }, 1, new Set()), [], 'no headless item: nothing to skip');
});

test('wizard: an unanswered task question is not a skip on path A; every other row shows (R1-8)', () => {
  const rows = [{ item: 't', needs: ['task:T'] }, { item: 'k', needs: ['secret:k'] }, { item: 'b', needs: ['task:T', 'repo_code'] }];
  assert.deepStrictEqual(SP.offRows(rows, 'preset', null).map((x) => x.item), ['k', 'b']);
  assert.deepStrictEqual(SP.offRows(rows, 'preset', false).map((x) => x.item), ['t', 'k', 'b'], 'answered No: they are off because of it');
  assert.deepStrictEqual(SP.offRows(rows, 'custom', null).map((x) => x.item), ['t', 'k', 'b'], 'path B: an unticked task is a no');
  assert.deepStrictEqual(SP.offRows([], 'preset', null), []);
});

test('wizard: variable labels reach the off line; the raw name only without a label (D7)', () => {
  assert.strictEqual(SP.offLine({ title: 'Wake', needs: ['wol_mac'] }, { labels: { wol_mac: 'Network address' } }), '[ ] off - needs Network address - Wake');
  assert.strictEqual(SP.offLine({ title: 'X', needs: ['other'] }, { labels: {} }), '[ ] off - needs other - X');
});

test('wizard: Stays off says what a group needs once, in plain words (N2)', () => {
  const rows = [
    { item: 'a', title: 'A', needs: ['headless_base_url'] },
    { item: 'k', title: 'K', needs: ['wol_mac'] },
    { item: 'b', title: 'B', needs: ['headless_base_url'] },
  ];
  assert.deepStrictEqual(SP.offLines(rows, { oneAccount: true, labels: { wol_mac: 'Network address' } }), ['[ ] off - needs a second Claude account - A, B', '[ ] off - needs Network address - K']);
  assert.deepStrictEqual(SP.offLines([], {}), []);
});

test('preview: Apply says why it is shut, one reason, none when it is open (N1)', () => {
  const ok = { verdict: { code: 0 }, missing: [], empty: false, highRisk: [{ id: 'a' }], needsAck: [] };
  assert.strictEqual(SP.blockedWhy(ok, 'preset', { tick: false }), 'Tick "Yes, apply them" above to continue.');
  assert.strictEqual(SP.blockedWhy(ok, 'preset', { tick: true }), '');
  assert.match(SP.blockedWhy(Object.assign({}, ok, { missing: [{ name: 'x' }], verdict: { code: 2 } }), 'preset', {}), /^Fill in or skip/);
  assert.match(SP.blockedWhy(Object.assign({}, ok, { verdict: { code: 2 } }), 'preset', { tick: true }), /refused/);
  assert.match(SP.blockedWhy(Object.assign({}, ok, { empty: true }), 'preset', { tick: true }), /^Nothing to apply/);
  assert.match(SP.blockedWhy(ok, 'custom', { acksDone: false }), /apply phrase/);
  assert.strictEqual(SP.blockedWhy(ok, 'custom', { acksDone: true }), '');
  assert.match(SP.blockedWhy(Object.assign({}, ok, { needsAck: ['a'] }), 'preset', { tick: true }), /cannot apply/);
});

test('wizard: the preset card states its numbers from the preset, never literals (R3-7)', () => {
  assert.strictEqual(SP.presetCardSub(237, Array.from({ length: 7 }, () => ({ hidden: true }))), "The author's full setup: 237 items. It changes your Claude settings, adds rules, hooks and scripts to the project you pick, and can register 7 hidden scheduled tasks. It suits people who already run Claude Code daily. The next screens list everything; nothing is written until Apply.");
  assert.match(SP.presetCardSub(9, [{ hidden: false }]), /: 9 items\..*can register 1 scheduled task\. /);
  assert.ok(!/register/.test(SP.presetCardSub(9, [])), 'no task: no task clause');
  const js = read('setup-paths.js');
  assert.ok(!/\b(239|237)\b/.test(js), 'no literal preset count in the wizard');
});

test('wizard: first-screen and step texts verbatim from the rulings', () => {
  const js = read('setup-paths.js');
  for (const line of [
    'Optional setup. Claude Console works without it. Skip for now opens the console; you can run this later from the ... menu, Run setup.', // R1-2
    "Use Remus3's current settings (for experienced users)", // R1-5
    'Custom setup (best if you are new)',
    'Starts from the recommended set. Choose each module and review every change',
    "Choose where this applies. Next keeps the author's modules as listed.", // R3-2
    'Apply to (choose one) ',
    'This user: only your Claude settings change. The rules, hooks and safety floors go into a project, so they are skipped here. A project: settings, rules, hooks and floors all apply.',
    'Want only some of them? Use Switch to custom setup.', // R3-8
    'Done with modules', // R1-24
  ]) assert.ok(js.includes(line), line);
  assert.ok(!/API keys are asked for on the next step/.test(js), 'the API-keys sentence is gone (R1-7)');
  assert.ok(!/recommended for experienced users/.test(js));
  assert.match(js, /op: 'preset', name: 'recommended'/, 'a fresh Custom starts from the recommended set (R1-5)');
  assert.ok(!/\.wz-rail li/.test(read('profile.css')), 'no visual rail styling (R1-26)');
});

test('wizard on the shipped profile, one account, user target: path, glance, review, preview, apply; no task reaches the plan', async () => {
  const os = require('os');
  const http = require('http');
  const S = require('./fixtures/profile-ui-seed');
  const R = require('../server/profile-routes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wz-real-'));
  const dirs = { dataDir: path.join(root, 'data'), runDir: path.join(root, 'run'), configDir: path.join(root, 'config') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const fakes = S.fakeAdapters({ binDir: path.join(root, 'bin') });
  const handler = R.createProfileRoutes({ profile: Object.assign({ profileDir: path.join(__dirname, '..', 'profile'), adopt: null, deps: { env: fakes.env, tasks: fakes.tasks, git: fakes.git, recycle: fakes.recycle }, secrets: fakes.secrets, detect: (n) => (n === 'python' ? 'python' : null), username: 'nobody-x', hostname: 'host-x', home: path.join(root, 'home'), projects: () => [], version: '0.0.0-test' }, dirs) });
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); if (!(await handler(req, res, u.pathname, req.method, u))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const post = async (p, b) => (await fetch('http://127.0.0.1:' + srv.address().port + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    const pre = await post('/api/profile/wizard', { op: 'preset', name: 'remus3' });
    const inp = await post('/api/profile/wizard', { op: 'inputs', selection: pre.selection, target: { user: true } });
    assert.deepStrictEqual(inp.tasks, []);
    assert.deepStrictEqual(SP.stepsFor('preset', inp, { accounts: 1 }), ['path', 'glance', 'review', 'preview', 'apply']);
    const all = await post('/api/profile/wizard', { op: 'inputs', selection: pre.selection });
    assert.ok(all.tasks.length > 0 && all.tasks.every((t) => t.hidden), 'the card counts the whole preset');
    const skipped = SP.startSkips(inp, 1, new Set());
    assert.deepStrictEqual(skipped, ['headless_base_url']);
    const sk = await post('/api/profile/wizard', { op: 'skip', selection: pre.selection, skipped });
    assert.ok(sk.offNeeds.some((x) => x.needs.includes('headless_base_url')), 'the headless items are listed off');
    assert.ok(!sk.offNeeds.some((x) => x.needs.every((n) => n.startsWith('task:'))));
    // R1-3: the pair ships off in the preset itself, so nothing here turns it off for the plan.
    const draft = Object.assign({}, sk.selection, { review_ack: { version: '1.0.0', at: '2026-11-02T00:00:00Z' } });
    for (const id of ['set-bypass-permissions', 'set-skip-danger-prompt']) assert.strictEqual(pre.states[id], 'off', id);
    const plan = await post('/api/profile/plan', { target: { user: true }, draft, values: {} });
    assert.deepStrictEqual(plan.missing, []);
    assert.strictEqual(plan.verdict.code, 0, plan.verdict.line);
    assert.deepStrictEqual(plan.tasks || [], []);
    assert.deepStrictEqual(plan.needsAck, []);
    assert.deepStrictEqual(plan.highRisk, [], 'nothing high risk is left on a user target, so Preview asks nothing');
    assert.strictEqual(SP.nextBlocked(plan, 'preset', { tick: false }), false, 'the preset path reaches Apply');
    const tc = { mode: 'grouped', yes: false, listed: [] };
    const r = await post('/api/profile/apply', Object.assign({ planId: plan.planId, confirm: true, taskConsent: tc }, SP.applyConsent(plan, 'preset', { tick: false })));
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 400));
    assert.strictEqual(fakes.tasks.m.size, 0, 'no task registered');
    assert.ok(!fakes.env.m.has('CLAUDE_HEADLESS_BASE_URL'), 'no proxy variable written');
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('wizard on the shipped profile, project target: no typed-only item, the high-risk items that remain keep the unticked yes', async () => {
  const os = require('os');
  const http = require('http');
  const S = require('./fixtures/profile-ui-seed');
  const R = require('../server/profile-routes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wz-real-p-'));
  const dirs = { dataDir: path.join(root, 'data'), runDir: path.join(root, 'run'), configDir: path.join(root, 'config') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const repo = S.seedRepo(path.join(root, 'repo'));
  const fakes = S.fakeAdapters({ binDir: path.join(root, 'bin') });
  const handler = R.createProfileRoutes({ profile: Object.assign({ profileDir: path.join(__dirname, '..', 'profile'), adopt: null, deps: { env: fakes.env, tasks: fakes.tasks, git: fakes.git, recycle: fakes.recycle }, secrets: fakes.secrets, detect: (n) => (n === 'python' ? 'python' : null), username: 'nobody-x', hostname: 'host-x', home: path.join(root, 'home'), projects: () => [{ id: 'sample', name: 'sample', dir: repo }], version: '0.0.0-test' }, dirs) });
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); if (!(await handler(req, res, u.pathname, req.method, u))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const post = async (p, b) => (await fetch('http://127.0.0.1:' + srv.address().port + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
  try {
    const pre = await post('/api/profile/wizard', { op: 'preset', name: 'remus3' });
    const target = { project: 'sample' };
    const values = { repo_code: 'SA' };
    const ack = { review_ack: { version: '1.0.0', at: '2026-11-02T00:00:00Z' } };
    const first = await post('/api/profile/plan', { target, draft: Object.assign({}, pre.selection, ack), values });
    const sk = await post('/api/profile/wizard', { op: 'skip', selection: pre.selection, skipped: first.missing.map((m) => m.name) });
    const plan = await post('/api/profile/plan', { target, draft: Object.assign({}, sk.selection, ack), values });
    assert.deepStrictEqual(plan.missing, []);
    assert.strictEqual(plan.verdict.code, 0, plan.verdict.line);
    assert.deepStrictEqual(plan.needsAck, []);
    assert.ok(plan.highRisk.length > 0, 'high-risk items remain, so Preview asks');
    // N3: one account: the second-account items are off, listed in words, and ask nothing.
    const one = await post('/api/profile/wizard', { op: 'skip', selection: pre.selection, skipped: first.missing.map((m) => m.name).concat('headless_base_url') });
    const onePlan = await post('/api/profile/plan', { target, draft: Object.assign({}, one.selection, ack), values });
    const second = ['hl-second-account', 'hl-proxy', 'hl-route-file', 'hl-account-quiet'];
    assert.strictEqual(onePlan.verdict.code, 0, onePlan.verdict.line);
    for (const id of second.concat('hl-env-base-url', 'kit-fleet-headless')) {
      assert.strictEqual(one.states[id], 'off', id);
      assert.deepStrictEqual(onePlan.rows.filter((r) => r.item === id), [], id + ' has no row in the plan');
      assert.ok(!onePlan.highRisk.some((x) => x.id === id), id + ' asks no yes');
      assert.ok(one.offNeeds.find((x) => x.item === id).needs.includes('headless_base_url'), id + ' is listed');
    }
    assert.ok(!one.offNeeds.some((x) => x.needs.some((n) => /depends on/.test(n))), 'no raw item id in a reason');
    assert.ok(onePlan.highRisk.length > 0 && onePlan.highRisk.length < plan.highRisk.length, 'the other high-risk items keep their yes');
    assert.strictEqual(SP.nextBlocked(onePlan, 'preset', { tick: false }), true, 'no tick: Apply stays shut');
    for (const id of ['set-bypass-permissions', 'set-skip-danger-prompt', 'os-self-apply-grant', 'hl-fallback-armed']) assert.ok(!plan.highRisk.some((x) => x.id === id), id);
    assert.strictEqual(SP.nextBlocked(plan, 'preset', { tick: false }), true, 'no tick: Apply stays shut');
    assert.strictEqual(SP.nextBlocked(plan, 'preset', { tick: true }), false);
    const tc = { mode: 'grouped', yes: false, listed: [] };
    const noTick = await post('/api/profile/apply', Object.assign({ planId: plan.planId, confirm: true, taskConsent: tc }, SP.applyConsent(plan, 'preset', { tick: false })));
    assert.strictEqual(noTick.ok, false, 'without the tick the wizard sends no consent, so the engine refuses');
    assert.match(noTick.line, /is high risk/);
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// The body of the sandbox check F7-wizard-route-apply (tools/vmtest/phase-f.ps1), in the
// same order and shapes, so the sequence is known to hold before a stage spends a run on it.
test('F7 sequence: project target, the tick applies; a needsAck id with no typed ack is refused; revert', async () => {
  const os = require('os');
  const http = require('http');
  const S = require('./fixtures/profile-ui-seed');
  const R = require('../server/profile-routes');
  const ID = 'set-bypass-permissions';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wz-f7-'));
  const dirs = { dataDir: path.join(root, 'data'), runDir: path.join(root, 'run'), configDir: path.join(root, 'config') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const repo = S.seedRepo(path.join(root, 'repo'));
  const fakes = S.fakeAdapters({ binDir: path.join(root, 'bin') });
  const handler = R.createProfileRoutes({ profile: Object.assign({ profileDir: path.join(__dirname, '..', 'profile'), adopt: null, deps: { env: fakes.env, tasks: fakes.tasks, git: fakes.git, recycle: fakes.recycle }, secrets: fakes.secrets, detect: () => null, username: 'nobody-x', hostname: 'host-x', home: path.join(root, 'home'), projects: () => [{ id: 'sample', name: 'sample', dir: repo }], version: '0.0.0-test' }, dirs) });
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); if (!(await handler(req, res, u.pathname, req.method, u))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const call = async (m, p, b) => (await fetch('http://127.0.0.1:' + srv.address().port + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
  const post = (p, b) => call('POST', p, b);
  try {
    const target = { project: 'sample' };
    const values = { repo_code: 'SF', runtime_retention_days: '7', python: 'python', headless_base_url: 'http://127.0.0.1:3456' };
    const profile = await call('GET', '/api/profile');
    const ack = { review_ack: { version: profile.profile.version, at: '2026-11-03T00:00:00Z' } };
    const pre = await post('/api/profile/wizard', { op: 'preset', name: 'remus3' });
    const inp = await post('/api/profile/wizard', { op: 'inputs', selection: pre.selection, target });
    const first = await post('/api/profile/plan', { target, draft: Object.assign({}, pre.selection, ack), values });
    // Tasks answered no. A second account, so the headless items stay on: they are the
    // high-risk items left for the tick when no task is asked for.
    const skipped = [...new Set(first.missing.map((m) => m.name).concat((inp.tasks || []).map((t) => 'task:' + t.name)))];
    for (const k of SP.startSkips(inp, 2, new Set())) assert.ok(skipped.includes(k) || values[k] !== undefined, 'the wizard also skips ' + k);
    const sk = await post('/api/profile/wizard', { op: 'skip', selection: pre.selection, skipped });
    const draft = Object.assign({}, sk.selection, ack);
    const tc = { mode: 'grouped', yes: false, listed: [] };

    // The refusal first, on the clean state: it must write nothing.
    const forced = Object.assign({}, draft, { items: Object.assign({}, draft.items, { [ID]: 'on' }) });
    const bad = await post('/api/profile/plan', { target, draft: forced, values, only: [ID] });
    assert.deepStrictEqual(bad.needsAck, [ID]);
    const refused = await post('/api/profile/apply', { planId: bad.planId, confirm: true, taskConsent: tc, groupedConsent: true, acks: [ID], typed: {} });
    assert.strictEqual(refused.ok, false);
    assert.strictEqual(refused.applied, false);
    assert.match(refused.line, /^refused: set-bypass-permissions needs the typed acknowledgement/);
    assert.deepStrictEqual((await call('GET', '/api/profile/tx')).tx, []);

    const plan = await post('/api/profile/plan', { target, draft, values });
    assert.deepStrictEqual(plan.missing, []);
    assert.strictEqual(plan.verdict.code, 0, plan.verdict.line);
    assert.deepStrictEqual(plan.needsAck, []);
    assert.ok(plan.highRisk.length > 0);
    const body = { groupedConsent: true, acks: plan.highRisk.map((x) => x.id), typed: {} };
    assert.deepStrictEqual(body, SP.applyConsent(plan, 'preset', { tick: true }), 'the tick shape, as the wizard sends it');
    const r = await post('/api/profile/apply', Object.assign({ planId: plan.planId, confirm: true, taskConsent: tc }, body));
    assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 400));
    assert.strictEqual(r.applied, true);
    assert.ok(r.written > 0, 'wrote ' + r.written);
    assert.ok((await call('GET', '/api/profile/tx')).tx.length === 1);
    assert.strictEqual(fakes.tasks.m.size, 0, 'no task registered');
    assert.deepStrictEqual(grepTree(root, 'bypassPermissions').filter((f) => path.basename(f).startsWith('settings')), []);
    assert.ok(fs.existsSync(path.join(repo, '.claude', 'settings.json')), 'the repo settings the sandbox check reads');
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

// Every file under dir, as text, for the read-back that nothing was written.
function grepTree(dir, needle) {
  const hits = [];
  if (!fs.existsSync(dir)) return hits;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) hits.push(...grepTree(f, needle));
    else if (e.isFile() && fs.readFileSync(f, 'utf8').includes(needle)) hits.push(f);
  }
  return hits;
}

test('CONSENT (R1-3, section 0): a POST carrying needsAck ids with no typed ack is refused by the engine, preset path and custom, user target and project target', async () => {
  const os = require('os');
  const http = require('http');
  const S = require('./fixtures/profile-ui-seed');
  const R = require('../server/profile-routes');
  const ID = 'set-bypass-permissions';
  const WANT = /^refused: set-bypass-permissions needs the typed acknowledgement/;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wz-consent-'));
  const dirs = { dataDir: path.join(root, 'data'), runDir: path.join(root, 'run'), configDir: path.join(root, 'config') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const repo = S.seedRepo(path.join(root, 'repo'));
  const fakes = S.fakeAdapters({ binDir: path.join(root, 'bin') });
  const handler = R.createProfileRoutes({ profile: Object.assign({ profileDir: path.join(__dirname, '..', 'profile'), adopt: null, deps: { env: fakes.env, tasks: fakes.tasks, git: fakes.git, recycle: fakes.recycle }, secrets: fakes.secrets, detect: (n) => (n === 'python' ? 'python' : null), username: 'nobody-x', hostname: 'host-x', home: path.join(root, 'home'), projects: () => [{ id: 'sample', name: 'sample', dir: repo }], version: '0.0.0-test' }, dirs) });
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, 'http://127.0.0.1'); if (!(await handler(req, res, u.pathname, req.method, u))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const call = async (m, p, b) => (await fetch('http://127.0.0.1:' + srv.address().port + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })).json();
  const post = (p, b) => call('POST', p, b);
  try {
    const pre = await post('/api/profile/wizard', { op: 'preset', name: 'remus3' });
    // Forced on, so the proof holds before and after the WP-9 rebuild turns the pair off.
    const draft = Object.assign({}, pre.selection, { review_ack: { version: '1.0.0', at: '2026-11-02T00:00:00Z' } });
    draft.items = Object.assign({}, draft.items, { [ID]: 'on' });
    const tc = { mode: 'grouped', yes: false, listed: [] };
    for (const target of [{ user: true }, { project: 'sample' }]) {
      const plan = await post('/api/profile/plan', { target, draft, values: {}, only: [ID] });
      const name = JSON.stringify(target);
      assert.deepStrictEqual(plan.needsAck, [ID], name);
      assert.ok(plan.highRisk.some((x) => x.id === ID), name + ' it is high risk too: the id the old wizard line sent');
      assert.strictEqual(plan.verdict.code, 0, name + ' ' + plan.verdict.line);
      const ids = plan.highRisk.map((x) => x.id);
      const bodies = {
        'preset path, no acks': { groupedConsent: true },
        'preset path, every high-risk id (the old wizard line)': { groupedConsent: true, acks: ids },
        'preset path, the id alone': { groupedConsent: true, acks: [ID] },
        'preset path, what the wizard sends with the tick': SP.applyConsent(plan, 'preset', { tick: true }),
        'preset path, what the wizard sends without the tick': SP.applyConsent(plan, 'preset', { tick: false }),
        'custom, no acks': {},
        'custom, the id with nothing typed': { acks: ids },
        'custom, the wrong phrase': { acks: ids, typed: { [ID]: 'yes' } },
        'custom, the phrase of another item': { acks: ids, typed: { [ID]: 'apply something-else' } },
        'custom, what the wizard sends with nothing typed': SP.applyConsent(plan, 'custom', { typed: {} }),
      };
      for (const [what, body] of Object.entries(bodies)) {
        const r = await post('/api/profile/apply', Object.assign({ planId: plan.planId, confirm: true, taskConsent: tc }, body));
        assert.strictEqual(r.ok, false, name + ' ' + what);
        assert.strictEqual(r.applied, false, name + ' ' + what);
        assert.match(r.line, WANT, name + ' ' + what);
      }
      assert.ok(!SP.applyConsent(plan, 'preset', { tick: true }).acks.includes(ID), 'the wizard never sends a needsAck id on the preset path');
      assert.strictEqual(SP.nextBlocked(plan, 'preset', { tick: true }), true, 'and Preview does not offer Apply for it');
      assert.match(SP.typedOnlyLine(plan), /^Run tools without permission prompts needs its own typed yes, which this path does not ask\. Use Switch to custom setup/);
    }
    // Read back: nothing was written by any refusal.
    assert.deepStrictEqual((await call('GET', '/api/profile/tx')).tx, []);
    for (const d of [dirs.configDir, path.join(root, 'home'), repo]) assert.deepStrictEqual(grepTree(d, 'bypassPermissions'), [], d);
    // The way that does work: the phrase, typed, on a user target. The tree above is temp.
    const plan = await post('/api/profile/plan', { target: { user: true }, draft, values: {}, only: [ID] });
    const typed = Object.fromEntries(plan.highRisk.map((x) => [x.id, ' ' + PF.ackPhrase(x.id) + ' ']));
    const ok = await post('/api/profile/apply', Object.assign({ planId: plan.planId, confirm: true, taskConsent: tc }, SP.applyConsent(plan, 'custom', { typed })));
    assert.strictEqual(ok.ok, true, JSON.stringify(ok).slice(0, 400));
    assert.strictEqual(grepTree(root, '"defaultMode": "bypassPermissions"').filter((f) => path.basename(f) === 'settings.json').length, 1, 'written once, to the temp settings');
  } finally { srv.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('consent: applyConsent and nextBlocked: the tick stands only for what a grouped yes may cover', () => {
  const ok = { verdict: { code: 0 }, missing: [], empty: false };
  const plan = Object.assign({}, ok, { highRisk: [{ id: 'a' }, { id: 'b', title: 'B item' }], needsAck: ['b'] });
  const plain = Object.assign({}, ok, { highRisk: [{ id: 'a' }], needsAck: [] });
  assert.deepStrictEqual(SP.applyConsent(plan, 'preset', { tick: true }), { groupedConsent: true, acks: ['a'], typed: {} });
  assert.deepStrictEqual(SP.applyConsent(plan, 'preset', { tick: false }), { groupedConsent: false, acks: [], typed: {} });
  assert.deepStrictEqual(SP.applyConsent(plan, null, { tick: true }), { groupedConsent: true, acks: ['a'], typed: {} }, 'the update path is a preset path');
  assert.deepStrictEqual(SP.applyConsent(Object.assign({}, ok, { highRisk: [], needsAck: [] }), 'preset', {}), { groupedConsent: true, acks: [], typed: {} }, 'nothing high risk: nothing to ask');
  assert.deepStrictEqual(SP.applyConsent(plain, 'preset', { tick: true, seen: [] }), { groupedConsent: false, acks: [], typed: {} }, "another account's plan: an item the human never saw stays refused");
  assert.deepStrictEqual(SP.applyConsent(plan, 'custom', { typed: { a: 'apply a', b: 'apply b', z: 'apply z' } }), { groupedConsent: false, acks: ['a', 'b'], typed: { a: 'apply a', b: 'apply b' } });
  assert.deepStrictEqual(SP.applyConsent(plan, 'custom', { typed: { a: 'apply a', b: 'apply b' }, seen: ['a'] }), { groupedConsent: false, acks: ['a'], typed: { a: 'apply a' } });
  assert.strictEqual(SP.nextBlocked(plain, 'preset', { tick: false }), true);
  assert.strictEqual(SP.nextBlocked(plain, 'preset', { tick: true }), false);
  assert.strictEqual(SP.nextBlocked(plan, 'preset', { tick: true }), true, 'a typed-only item shuts path A');
  assert.strictEqual(SP.nextBlocked(plan, 'custom', { acksDone: false }), true);
  assert.strictEqual(SP.nextBlocked(plan, 'custom', { acksDone: true }), false);
  assert.strictEqual(SP.nextBlocked(Object.assign({}, ok, { highRisk: [], needsAck: [] }), 'preset', {}), false);
  assert.strictEqual(SP.nextBlocked(Object.assign({}, plain, { missing: [{ name: 'x' }] }), 'preset', { tick: true }), true);
  assert.strictEqual(SP.nextBlocked(Object.assign({}, plain, { verdict: { code: 2 } }), 'preset', { tick: true }), true);
  assert.strictEqual(SP.nextBlocked(Object.assign({}, plain, { empty: true }), 'preset', { tick: true }), true);
  const js = read('setup-paths.js');
  for (const line of ['These high-risk items are part of this preset. Yes, apply them.', 'Your answer on scheduled tasks covers tasks only.']) assert.ok(js.includes(line), line);
  assert.ok(!/count as your yes/.test(js), 'the old sentence is gone');
  assert.match(js, /h\('input#wz-hrtick', \{ type: 'checkbox', checked: false \}\)/, 'the box starts unticked');
  assert.ok(!/acks: W\.plan\.highRisk|acks: pl\.highRisk/.test(js), 'no apply call sends the raw high-risk list');
});

test('preview: the sum line, the fold and the result say what a user target leaves out (R1-10, R3-18)', () => {
  const rows = [
    { item: 'a', kind: 'json-merge', target: 'user:settings.json#x', status: 'new', reason: null },
    { item: 'a', kind: 'json-merge', target: 'user:settings.json#y', status: 'differs', reason: null },
    { item: 'b', kind: 'kit', target: 'repo:{kit_dir}/x.js', status: 'skipped', reason: 'needs a project target' },
    { item: 'b', kind: 'git', target: 'kit.x', status: 'skipped', reason: 'no repo target' },
    { item: 'c', kind: 'task', target: 'T', status: 'skipped', reason: 'its script needs a project target' },
    { item: 'd', kind: 'json-merge', target: 'user:settings.json#z', status: 'skipped', reason: 'user value kept' },
  ];
  assert.deepStrictEqual(rows.filter(PF.leftOut).map((r) => r.item), ['b', 'b', 'c'], 'a kept user value is not a left-out row');
  const user = { rows, counts: { new: 1, differs: 1, skipped: 4 }, target: { user: true } };
  assert.strictEqual(PF.planSummary(user), '2 changes to your Claude settings. 3 more only work inside a project and are left out. Pick a project under Apply to, to add them.');
  assert.strictEqual(PF.planSummary(user, { targetWord: 'Target' }), '2 changes to your Claude settings. 3 more only work inside a project and are left out. Pick a project under Target, to add them.');
  assert.strictEqual(PF.planSummary({ rows: rows.slice(0, 3), counts: { new: 1, skipped: 1 }, target: { user: true } }), '1 change to your Claude settings. 1 more only works inside a project and is left out. Pick a project under Apply to, to add them.');
  assert.strictEqual(PF.planSummary({ rows, counts: { new: 1, skipped: 4 }, target: { repo: 'x', user: false } }), '1 new, 4 skipped.', 'a project target keeps the counts');
  assert.strictEqual(PF.planSummary({ rows: rows.slice(0, 2), counts: { new: 1, differs: 1 }, target: { user: true } }), '1 new, 1 differs.', 'nothing left out: nothing to explain');
  assert.strictEqual(PF.foldLine(405), '405 items do not apply to this target (they need a project)');
  assert.strictEqual(PF.foldLine(1), '1 item does not apply to this target (they need a project)');
  assert.ok(PF.isChange({ status: 'conflict' }) && !PF.isChange({ status: 'same' }) && !PF.isChange({ status: 'skipped' }));
  assert.strictEqual(SP.doneLine({ target: { user: true } }, 405), '[+] Your Claude settings are set up. Project modules were left out; run setup again on a project to add them. Restart Claude panes to load this.');
  assert.strictEqual(SP.doneLine({ target: { user: true } }, 0), '[+] Setup complete - restart Claude panes to load it');
  assert.strictEqual(SP.doneLine({ target: { user: false } }, 9), '[+] Setup complete - restart Claude panes to load it');
  const prof = read('profile.js');
  assert.ok(/foldLine\(left\.length\)/.test(prof) && /g\.title \+ ' - ' \+ g\.rows\.length/.test(prof), 'the fold names modules and counts, so {kit_dir} never prints');
});

test('missing card: a plain label and hint, the raw name last; refusals in words; picks line; labels (R1-4, R3-6, R3-17, R3-36, R1-9)', () => {
  assert.deepStrictEqual(PF.missingRow({ name: 'repo_root', label: 'Folder that holds the scripts these tasks run', why: null }), { label: 'Folder that holds the scripts these tasks run', hint: '' });
  assert.deepStrictEqual(PF.missingRow({ name: 'python', label: 'Full path to python.exe', why: 'Runs the kit hooks and tools.' }), { label: 'Full path to python.exe', hint: 'Python was not found. Install Python 3, or skip the items that use it.' });
  assert.deepStrictEqual(PF.missingRow({ name: 'repo_code', why: 'Short code.', type: 'code' }, {}, SP.hintFor), { label: 'Short code.', hint: 'It must be 2 to 6 capital letters or digits, starting with a letter, for example SA.' });
  assert.deepStrictEqual(PF.missingRow({ name: 'x', label: 'X value', why: 'Why x.', type: 'path' }, {}, SP.hintFor), { label: 'X value', hint: 'Why x.' }, 'no form to state: no "is not in the form" text');
  assert.strictEqual(PF.missingRow({ name: 'raw_name' }, {}).label, 'raw_name', 'the raw name only when nothing better is declared');
  const plan = { highRisk: [{ id: 'set-bypass-permissions', title: 'Run tools without permission prompts' }] };
  assert.strictEqual(PF.refusedLine('refused: set-bypass-permissions needs the typed acknowledgement --ack set-bypass-permissions', plan), 'Refused: Run tools without permission prompts needs you to type "apply set-bypass-permissions" first. Nothing was written.');
  assert.strictEqual(PF.refusedLine('refused: x is high risk; add --ack x after reading what it does', plan), 'Refused: x is high risk and was not confirmed. Nothing was written.');
  assert.strictEqual(PF.refusedLine('applied tx 1', plan), 'applied tx 1');
  assert.strictEqual(PF.pickLine('Setup profile: not applied. Your picks: 1 of 2 items.'), 'Setup profile: not applied. Your picks: 1 of 2 items. Switches change your picks only. Nothing reaches your machine until Review, then Apply.');
  const prof = read('profile.js');
  const js = read('setup-paths.js');
  for (const line of ['One more thing is needed before this can be previewed', 'Skip - the items that use it stay off']) assert.ok(prof.includes(line), line);
  assert.ok(!/Needs a value before it can be planned|\(used by /.test(prof), 'the old card text is gone');
  assert.match(prof, /plan\.verdict\.line && !\(plan\.missing && plan\.missing\.length\)/, 'no verdict line while a value is missing');
  assert.ok(!/Why it is on/.test(prof + js), 'R3-36');
  assert.ok(prof.includes('Why the author uses it: ') && js.includes('Why the author uses it: '));
  assert.match(js, /t\.deletes \|\| 'not stated'/, 'R1-9: never "nothing" by default');
});

test('wizard: skipped inputs are named in the off line; task consent grouped on path A, per task on path B', () => {
  assert.strictEqual(SP.offLine({ item: 'hl-kill-switch', title: 'Kill switch', needs: ['headless_base_url', 'secret:anthropic-key'] }), '[ ] off - needs proxy URL, API key anthropic-key - Kill switch');
  assert.strictEqual(SP.skipKey('env', 'X'), 'env:X');
  assert.strictEqual(SP.skipKey('task', 'T'), 'task:T');
  assert.strictEqual(SP.skipKey('secret', 's'), 'secret:s');
  assert.strictEqual(SP.skipKey('var', 'repo_code'), 'repo_code');
  const tasks = [{ name: 'A' }, { name: 'B' }];
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, true, {}), []);
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, false, {}), ['task:A', 'task:B']);
  assert.deepStrictEqual(SP.taskSkips('preset', tasks, null, {}), ['task:A', 'task:B'], 'no answer = no task');
  assert.deepStrictEqual(SP.taskSkips('custom', tasks, true, { A: true }), ['task:B'], 'path B: no select-all, each task its own yes');
  assert.strictEqual(SP.validValue({ pattern: '^http://127\\.0\\.0\\.1:[0-9]{2,5}/?$' }, 'http://127.0.0.1:8080'), true);
  assert.strictEqual(SP.validValue({ pattern: '^http://127\\.0\\.0\\.1:[0-9]{2,5}/?$' }, 'http://example.com'), false);
  assert.strictEqual(SP.validValue({}, ''), false);
  // UX-F20: a plain-English hint, never the regex
  for (const v of [{ name: 'repo_code', type: 'code', pattern: '^[A-Z][A-Z0-9]{1,5}$' }, { name: 'headless_base_url', type: 'url', pattern: '^http' }, { name: 'operator_ident', type: 'git-ident' }, { name: 'x', type: 'int' }, { name: 'y' }]) {
    const t = SP.hintFor(v);
    assert.match(t, /^(must|is not)/, v.name);
    assert.ok(!/[\^$]/.test(t), v.name + ' hint shows no regex: ' + t);
  }
  assert.strictEqual(SP.hintFor({ hint: 'must be a colour' }), 'must be a colour');
});

test('glyph table: state vocabulary only where a state is meant (UX-F13..F16, N9, N10)', () => {
  assert.strictEqual(PF.rowGlyph('differs'), '[~]', 'differs is neutral, not STALE [!]');
  assert.strictEqual(PF.rowGlyph('same'), '   ', 'same rows carry no glyph');
  assert.strictEqual(PF.rowGlyph('new'), '[+]');
  assert.strictEqual(PF.rowGlyph('conflict'), '[x]');
  const src = read('profile.js') + read('setup-paths.js') + read('recovery.js');
  assert.ok(!/'\[!\] /.test(src), 'no [!] (STALE) glyph in the L5 screens');
  assert.ok(!/\[>\] Update to|\[>\] Merge/.test(src), 'no running glyph on the update card title');
  assert.strictEqual(PF.opWord('removeOriginal'), 'Removing the original');
  assert.strictEqual(PF.opLine('promote', 'remove-original done'), 'Removing the original - done');
  assert.strictEqual(PF.opLine('check', ''), 'Running the function check - done');
});

test('recovery: size and action lines', () => {
  assert.strictEqual(RV.sizeText(512), '512 bytes');
  assert.strictEqual(RV.sizeText(2048), '2 KB');
  assert.match(RV.actionLine({ ok: true, action: 'issue', truncated: true }), /save the report to a file and attach it/);
  assert.match(RV.actionLine({ ok: true, action: 'save', file: 'x.txt' }), /saved to x\.txt/);
  assert.match(RV.actionLine({ ok: false, reason: 'no' }), /^\[x\] no/);
});

test('page files: ASCII + LF only', () => {
  for (const f of ['profile.js', 'setup-paths.js', 'recovery.js', 'profile.css', 'index.html', 'app.js']) {
    const b = fs.readFileSync(path.join(PUB, f));
    assert.ok(!b.includes(13), f + ' has a CR byte');
    const bad = b.findIndex((x) => x > 0x7e || (x < 0x20 && x !== 0x0a && x !== 0x09));
    assert.strictEqual(bad, -1, f + ' has a non-ASCII byte at ' + bad);
  }
});

test('profile.css: colours only from tokens / chrome variables, sizes only from the type scale', () => {
  const css = read('profile.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepStrictEqual(css.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g) || [], []);
  assert.deepStrictEqual(css.split('\n').filter((l) => /font-size:\s*[\d.]+(px|pt|em|rem)/.test(l)), []);
  assert.match(css, /var\(--fk-status-bad\)/);
  assert.match(css, /var\(--fs-secondary\)/);
});

test('index.html: dialogs, header overflow entries, settings section and scripts', () => {
  const html = read('index.html');
  for (const id of ['dlg-profile', 'wz-page', 'dlg-adopt', 'dlg-machine', 'dlg-crash', 'dlg-stop', 'dlg-help', 'btn-more', 'top-menu', 'set-profile', 'prof-line', 'btn-prof-browse', 'btn-prof-setup', 'btn-crash', 'wz-back', 'wz-switch', 'wz-next', 'wz-cancel', 'cr-issue', 'cr-claude', 'cr-save', 'st-go', 'gh-go']) assert.match(html, new RegExp('id="' + id + '"'), id);
  for (const act of ['profile', 'setup', 'adopt', 'machine', 'crash', 'help', 'stop']) assert.match(html, new RegExp('data-act="' + act + '"'), act);
  const scripts = [...html.matchAll(/<script src="\/([a-z-]+\.js)"/g)].map((m) => m[1]).filter((s) => !/^(xterm|addon)/.test(s));
  assert.deepStrictEqual(scripts.slice(-4), ['app.js', 'profile.js', 'setup-paths.js', 'recovery.js']);
  assert.match(html, /<link rel="stylesheet" href="\/profile\.css">/);
});

test('index.html: no duplicate ids (UX-B2: the help dialog once reused the hp-* ids of another panel)', () => {
  const html = read('index.html');
  const seen = new Map();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  assert.deepStrictEqual([...seen].filter(([, n]) => n > 1).map(([id]) => id), []);
  // and no id is built in the L5 scripts that the page already has
  for (const f of ['profile.js', 'setup-paths.js', 'recovery.js']) {
    for (const m of read(f).matchAll(/h\('[a-z0-9]+(?:\.[A-Za-z0-9_-]+)*#([A-Za-z0-9_-]+)/g)) assert.ok(!seen.has(m[1]), f + ' builds #' + m[1] + ' which index.html already has');
  }
  assert.match(html, /id="btn-more"[^>]*aria-label="More"/, 'the ... button has a name (UX-F10)');
});

test('wizard: a full-page view with Skip for now, never a modal dialog (VERIFY ruling on UX-F23)', () => {
  const html = read('index.html');
  assert.match(html, /<section id="wz-page" class="wz-page"[^>]*hidden>/);
  assert.ok(!/<dialog[^>]*id="(dlg-wizard|wz-page)"/.test(html), 'not a <dialog>');
  assert.match(html, /<button type="button" id="wz-cancel">Skip for now<\/button>/);
  const js = read('setup-paths.js');
  assert.ok(!/showModal/.test(js), 'the wizard never calls showModal');
  assert.match(read('profile.css'), /\.wz-page \{ position: fixed; inset: 0;/);
});
