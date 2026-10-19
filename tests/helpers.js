'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Every fixture dir is removed when the test process exits. Before this the
// suite left one dir per call in %TEMP% for good: 2026-10-08 measured 619
// cc-test-* dirs (36,103 files) plus the other cc-*- prefixes, and Temp file
// COUNT is boot time on this machine.
const made = [];
process.on('exit', () => {
  for (const d of made) {
    try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* the hygiene sweep takes what is left */ }
  }
});

function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cc-test-'));
  made.push(d);
  return d;
}

function gitInit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', dir], { windowsHide: true });
}

function writeFile(p, content, mtimeMs) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  if (mtimeMs) {
    const t = new Date(mtimeMs);
    fs.utimesSync(p, t, t);
  }
}

// A fake C:\ with three repos, a non-repo dir, hand-offs, progress, inbox and quota state.
const INBOX = 'inbox'; // the fixture's inbox folder (config inboxDir)

function makeFixture() {
  const root = tmpdir();
  const scan = path.join(root, 'drive');
  const now = Date.now();
  gitInit(path.join(scan, 'Alpha'));
  gitInit(path.join(scan, 'Beta Repo'));
  gitInit(path.join(scan, 'Oldie'));
  fs.mkdirSync(path.join(scan, 'NotARepo'), { recursive: true });
  writeFile(path.join(scan, 'NotARepo', 'x.txt'), 'x');
  writeFile(path.join(scan, 'Alpha', 'AL-NEXT-SESSION.txt'), 'SESSION: 7\nYou are the alpha session.\nline two\n\nTHE SINGLE NEXT ACTION\n  Ship the widget.\n  Then test it.\n\nOTHER\n');
  writeFile(path.join(scan, 'Alpha', 'dirty.txt'), 'untracked');
  const prog = path.join(scan, 'Alpha', 'ops', 'loop', 'control', 'progress');
  writeFile(path.join(prog, 'build.json'), JSON.stringify({
    task: 'build', pct: 40, step: 'compiling', eta_s: 600, status: 'running', updated: new Date(now - 1000).toISOString(),
    checklist: [{ id: 'B1', task: 'compile', state: 'running', eta_s: 300 }, { id: 'B2', task: 'link', state: 'pending', eta_s: 60 }],
  }));
  writeFile(path.join(prog, 'stuck.json'), JSON.stringify({ task: 'stuck', pct: 10, step: 'waiting', eta_s: 60, status: 'running', updated: new Date(now - 3 * 3600 * 1000).toISOString() }), now - 3 * 3600 * 1000);
  writeFile(path.join(prog, 'ancient.json'), JSON.stringify({ task: 'ancient', status: 'done' }), now - 30 * 24 * 3600 * 1000);
  writeFile(path.join(prog, 'broken.json'), '{not json');
  const inbox = path.join(scan, 'Alpha', INBOX);
  // Filename stamps deliberately disagree with mtimes: newest by mtime must win.
  writeFile(path.join(inbox, '2026-01-01-0000-from-X-old-name.txt'), 'a', now - 60 * 1000);
  writeFile(path.join(inbox, '2026-12-31-2359-from-Y-new-name.txt'), 'b', now - 5 * 24 * 3600 * 1000);
  writeFile(path.join(inbox, '2026-06-01-1200-from-Z-mid.txt'), 'c', now - 2 * 3600 * 1000);
  const acct2 = path.join(root, 'acct2cfg');
  writeFile(path.join(acct2, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-two', emailAddress: 'secret@example.com' } }));
  const state = path.join(root, 'claude-quota.state.json');
  writeFile(state, JSON.stringify({
    quota: [
      { accountUuid: 'uuid-one', orgUuid: 'org-1', orgName: 'Org One', name: 'one@example.com', quota: { unified5h: 0.5, unified7d: 0.9, unified5hReset: now + 3600000 } },
      { accountUuid: 'uuid-two', orgUuid: 'org-2', orgName: 'Org Two', name: 'two@example.com', quota: { unified5h: 0.01, unified7d: 0.08, unifiedStatus: 'allowed' } },
    ],
  }));
  const overrides = {
    scanRoots: [scan],
    excludeDirs: [],
    extraProjects: [],
    projects: { Alpha: { code: 'AL', order: 1 }, Oldie: { retired: true } },
    accounts: { acct1: { label: 'Account 1', configDir: null }, acct2: { label: 'Account 2', configDir: acct2 } },
    defaultAccount: 'acct2',
    quotaStateFile: state,
    statusIntervalSec: 1,
    gitIntervalSec: 1,
    idleSeconds: 1,
    inboxDir: INBOX, // named here, not left to the shipped config
    resources: { enabled: false }, // no counter sampler child from a test (CON-RES)
    updates: { repo: null }, // never reach GitHub from a test, whatever repo the shipped config names
    plugins: { main: { enabled: false } }, // v19.1: never run the real Main health steps / kit route from a test
  };
  return { root, scan, state, acct2, overrides, dataDir: path.join(root, 'data'), runDir: path.join(root, 'run') };
}

module.exports = { tmpdir, gitInit, writeFile, makeFixture };
