'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { discoverProjects } = require('../server/discovery');
const S = require('../server/status');
const { makeFixture } = require('./helpers');

async function alpha() {
  const fx = makeFixture();
  const ps = await discoverProjects(fx.overrides);
  return { fx, p: ps.find((x) => x.name === 'Alpha'), ps };
}

test('hand-off: SESSION number, head lines and the next-action block', async () => {
  const { p } = await alpha();
  const h = S.readHandoff(p);
  assert.strictEqual(h.file, 'AL-NEXT-SESSION.txt');
  assert.strictEqual(h.session, 7);
  assert.strictEqual(h.head[0], 'You are the alpha session.');
  assert.deepStrictEqual(h.nextAction, ['THE SINGLE NEXT ACTION', '  Ship the widget.', '  Then test it.']);
});

test('hand-off: "Next action:" inline form and missing SESSION', () => {
  const h = S.parseHandoff('Header\nNext action: do X\n  detail\n\nrest');
  assert.strictEqual(h.session, null);
  assert.deepStrictEqual(h.nextAction, ['Next action: do X', '  detail']);
});

test('hand-off: fallback file when there is no *-NEXT-SESSION.txt', async () => {
  const { fx, ps } = await alpha();
  const beta = ps.find((x) => x.name === 'Beta Repo');
  assert.strictEqual(S.readHandoff(beta), null);
  fs.mkdirSync(path.join(beta.dir, 'progress'));
  fs.writeFileSync(path.join(beta.dir, 'progress', 'LATEST.md'), '# Latest\nall good\n');
  beta.handoffFallback = 'progress/LATEST.md';
  assert.strictEqual(S.readHandoff(beta).file, 'LATEST.md');
  assert.ok(fx);
});

test('progress: running first, stale flagged, old files skipped, broken files reported', async () => {
  const { p } = await alpha();
  const r = S.readProgress(p, { maxAgeHours: 72, maxPerProject: 8, staleMaxAgeHours: 6 });
  const tasks = r.items.map((i) => i.task);
  assert.ok(!tasks.includes('ancient'), 'files older than maxAge are skipped');
  assert.strictEqual(r.items[0].task, 'build');
  assert.strictEqual(r.items[0].pct, 40);
  assert.strictEqual(r.items[0].stale, false);
  assert.deepStrictEqual(r.items[0].checklist.map((c) => c.id), ['B1', 'B2']);
  const stuck = r.items.find((i) => i.task === 'stuck');
  assert.strictEqual(stuck.stale, true, 'running but silent for > 2x eta is stale');
  assert.ok(r.items.find((i) => i.status === 'unreadable'));
});

test('progress: finished files leave after doneMaxAgeHours, stale running after staleMaxAgeHours', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cc-prog-'));
  const now = Date.now();
  const put = (n, o, ageMs) => {
    const f = path.join(dir, n + '.json');
    fs.writeFileSync(f, JSON.stringify(Object.assign({ task: n, eta_s: 60, updated: new Date(now - ageMs).toISOString() }, o)));
    const t = new Date(now - ageMs);
    fs.utimesSync(f, t, t);
  };
  const H = 3600 * 1000;
  put('done-new', { status: 'done' }, 10 * 60 * 1000);
  put('done-old', { status: 'done' }, 3 * H);
  put('failed-old', { status: 'failed' }, 2 * H);
  put('stale-new', { status: 'running' }, H);
  put('stale-old', { status: 'running' }, 5 * H);
  put('live', { status: 'running', eta_s: 7 * 24 * 3600 }, 10 * H);
  const proj = { dir, progressDirs: ['.'] };
  const tasks = (o) => S.readProgress(proj, Object.assign({ now, maxAgeHours: 72, maxPerProject: 20 }, o)).items.map((i) => i.task).sort();
  assert.deepStrictEqual(tasks({}), ['done-new', 'live', 'stale-new']);
  assert.deepStrictEqual(tasks({ doneMaxAgeHours: 4, staleMaxAgeHours: 6 }), ['done-new', 'done-old', 'failed-old', 'live', 'stale-new', 'stale-old']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('progress: pct is clamped and strings are clipped', () => {
  const it = S.normalizeProgress({ task: 't', pct: 250, step: 'x'.repeat(1000), status: 'running', eta_s: 10, updated: new Date().toISOString() }, 'f.json', Date.now(), Date.now());
  assert.strictEqual(it.pct, 100);
  assert.ok(it.step.length <= 300);
});

test('inbox: counts and newest by mtime, never by filename stamp', async () => {
  const { p } = await alpha();
  const r = S.readInbox(p, 'inbox');
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.last24h, 2);
  assert.strictEqual(r.newest[0].name, '2026-01-01-0000-from-X-old-name.txt');
  assert.strictEqual(r.newest[2].name, '2026-12-31-2359-from-Y-new-name.txt');
});

test('git: branch and dirty count', async () => {
  const { p } = await alpha();
  const g = await S.readGit(p.dir);
  assert.strictEqual(g.branch, 'main');
  assert.ok(g.dirty >= 2, 'untracked files count as dirty');
});

test('quota: numbers only, mapped to our account labels, no names/emails/org ids', async () => {
  const { fx } = await alpha();
  const q = S.readQuota(fx.state, fx.overrides.accounts, (dir) => (dir ? S.accountUuidFor(dir) : 'uuid-one'));
  assert.strictEqual(q.accounts.length, 2);
  assert.deepStrictEqual(q.accounts.map((a) => a.id), ['acct1', 'acct2']);
  assert.strictEqual(q.accounts[0].quota.unified7d, 0.9);
  assert.strictEqual(q.accounts[1].quota.unifiedStatus, 'allowed');
  const blob = JSON.stringify(q);
  for (const bad of ['example.com', 'Org One', 'org-1', 'uuid-one', 'uuid-two', 'secret@']) assert.ok(!blob.includes(bad), 'leaked ' + bad);
});

test('quota: missing state file gives null', () => {
  assert.strictEqual(S.readQuota('Z:/definitely/not/here.json', {}), null);
});

test('readers never write into the project tree', async () => {
  const { p } = await alpha();
  const snap = () => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else out.push(f + ':' + fs.statSync(f).mtimeMs);
      }
    };
    walk(p.dir);
    return out.sort().join('\n');
  };
  const before = snap();
  S.readHandoff(p);
  S.readProgress(p, {});
  S.readInbox(p, 'inbox');
  await S.readGit(p.dir);
  assert.strictEqual(snap(), before);
});

test('status snapshot flags the console\'s own checkout as self (left out of the panel)', () => {
  const root = path.resolve(__dirname, '..');
  const other = path.join(root, 'tests');
  const svc = new S.StatusService({ root, inboxDir: 'inbox' }, () => [
    { id: 'console', name: 'Console', dir: root.toUpperCase() },
    { id: 'other', name: 'Other', dir: other },
  ]);
  const snap = svc.refreshFiles();
  assert.deepStrictEqual(snap.projects.map((p) => [p.id, p.self]), [['console', true], ['other', false]]);
});

test('headless: live status file and live lane locks mark a repo active; stale ones do not', () => {
  const { tmpdir, writeFile } = require('./helpers');
  const dir = tmpdir('cc-hl-');
  const p = { dir };
  const ctl = path.join(dir, 'ops', 'loop', 'control');
  const now = Date.now();
  assert.strictEqual(S.readHeadless(p, { now }), null, 'no files -> no marker');
  const status = (state, ageMs, eta) => writeFile(path.join(ctl, 'inbox_status.json'), JSON.stringify({ schema: 1, state, task: 'Running Session', updated: new Date(now - ageMs).toISOString(), task_eta_s: eta === undefined ? null : eta, runs_in_window: 2, runs_cap: 120 }));
  status('idle', 1000);
  let h = S.readHeadless(p, { now });
  assert.strictEqual(h.active, false);
  assert.strictEqual(h.state, 'idle');
  status('running', 60 * 1000);
  h = S.readHeadless(p, { now });
  assert.strictEqual(h.active, true);
  assert.strictEqual(h.runs, 2);
  status('running', 3 * 3600 * 1000, 600);
  assert.strictEqual(S.readHeadless(p, { now }).active, false, 'a running file silent for hours is a dead run');
  writeFile(path.join(ctl, 'lanes', '0.lock'), JSON.stringify({ lane: 'builder', pid: 4242 }));
  writeFile(path.join(ctl, 'lanes', '1.lock'), JSON.stringify({ lane: 'gone', pid: 4343 }));
  writeFile(path.join(ctl, 'lanes', 'QUEUE_STOP'), '');
  h = S.readHeadless(p, { now, pidAlive: (pid) => pid === 4242 });
  assert.strictEqual(h.active, true);
  assert.deepStrictEqual(h.lanes, [{ index: 0, lane: 'builder' }]);
  h = S.readHeadless(p, { now, pidAlive: () => false });
  assert.strictEqual(h.active, false, 'a lock with a dead pid is a leftover');
});

test('headless reader is read-only and reaches the status snapshot', () => {
  const { tmpdir, writeFile } = require('./helpers');
  const dir = tmpdir('cc-hl2-');
  writeFile(path.join(dir, 'ops', 'loop', 'control', 'inbox_status.json'), JSON.stringify({ state: 'running', task: 'x', updated: new Date().toISOString() }));
  const f = path.join(dir, 'ops', 'loop', 'control', 'inbox_status.json');
  const m0 = fs.statSync(f).mtimeMs;
  const svc = new S.StatusService({ root: path.resolve(__dirname, '..'), inboxDir: 'inbox' }, () => [{ id: 'hl', name: 'HL', dir }]);
  const snap = svc.refreshFiles();
  assert.strictEqual(snap.projects[0].headless.active, true);
  assert.strictEqual(fs.statSync(f).mtimeMs, m0);
});
