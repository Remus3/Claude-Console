'use strict';
// Seeded demo workspace for screenshots, GIFs and trying the console safely (CON-013 f.5).
// Creates a temp folder with three sample repos (sample-api, sample-web, sample-docs):
// a hand-off file, a ROADMAP, progress files and, in sample-docs, a valid /done marker.
// Then starts the server in isolated mode (port 0, temp data / run / drops dirs) with
// Claude panes running tools/demo-claude.js, a scripted stand-in that needs no account,
// no network and shows no real model output. Every name and text here is made up.
//
//   node tools/demo-seed.js            # prints the URL to open, Ctrl+C ends and cleans up
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const T0 = Date.parse('2026-10-20T09:00:00Z');
const GIT_ENV = Object.assign({}, process.env, {
  GIT_AUTHOR_NAME: 'Demo Dev', GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_COMMITTER_NAME: 'Demo Dev', GIT_COMMITTER_EMAIL: 'demo@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
});

function git(dir, args, at) {
  const env = Object.assign({}, GIT_ENV);
  if (at) { env.GIT_AUTHOR_DATE = at; env.GIT_COMMITTER_DATE = at; }
  return execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, env, windowsHide: true }).toString().trim();
}

function write(file, text, mtimeMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
}

const REPOS = [
  {
    name: 'sample-api', code: 'API', session: 14,
    next: 'Add rate limits to the public endpoints, then load-test them.',
    roadmap: ['Rate limits on /v1/*', 'Pagination for /v1/orders', 'OpenAPI spec published'],
    progress: [{ task: 'load-test', pct: 62, step: 'running the 500 rps profile', eta_s: 420, status: 'running',
      checklist: [{ id: 'LT1', task: 'warm the cache', state: 'done', eta_s: 0 }, { id: 'LT2', task: '500 rps for 5 minutes', state: 'running', eta_s: 300 }, { id: 'LT3', task: 'write the report', state: 'pending', eta_s: 120 }] }],
    dirty: true,
  },
  {
    name: 'sample-web', code: 'WEB', session: 9,
    next: 'Finish the dark theme for the settings page.',
    roadmap: ['Dark theme for settings', 'Keyboard shortcuts help', 'Lighthouse score above 95'],
    progress: [{ task: 'build', pct: 100, step: 'bundle written', eta_s: 0, status: 'done' }],
  },
  {
    name: 'sample-docs', code: 'DOC', session: 22,
    next: 'Review the install guide with a fresh reader.',
    roadmap: ['Install guide review', 'Glossary page'],
    progress: [],
    done: true,
  },
];

function seedRepo(base, r, now) {
  const dir = path.join(base, r.name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  write(path.join(dir, 'README.md'), '# ' + r.name + '\n\nA sample project for the Claude Console demo.\n');
  write(path.join(dir, 'ROADMAP.md'), '# Roadmap\n\n' + r.roadmap.map((x) => '- ' + x).join('\n') + '\n');
  const handoff = r.code + '-NEXT-SESSION.txt';
  write(path.join(dir, handoff), 'SESSION: ' + r.session + '\n\nTHE SINGLE NEXT ACTION\n  ' + r.next + '\n\nOPEN ITEMS\n' +
    r.roadmap.slice(1).map((x) => '  - ' + x).join('\n') + '\n');
  write(path.join(dir, '.gitignore'), 'ops/loop/control/\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'Start ' + r.name], new Date(T0 - 86400000).toISOString());
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'Session ' + r.session + ' hand-off'], new Date(T0 - 3600000).toISOString());
  const prog = path.join(dir, 'ops', 'loop', 'control', 'progress');
  for (const p of r.progress) {
    write(path.join(prog, p.task + '.json'), JSON.stringify(Object.assign({ updated: new Date(now - 20000).toISOString(), checklist: [] }, p)) + '\n');
  }
  if (r.dirty) write(path.join(dir, 'src', 'limits.js'), 'module.exports = { perMinute: 600 };\n');
  if (r.done) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, handoff))).digest('hex');
    write(path.join(dir, 'ops', 'loop', 'control', 'session_done.json'), JSON.stringify({
      schema: 1, status: 'done', safe_to_clear: true, at: new Date(now - 60000).toISOString(), session: r.session,
      commit: git(dir, ['rev-parse', 'HEAD']), handoff, handoff_sha256: sha,
    }) + '\n');
  }
  return dir;
}

// Builds the workspace; returns { base, repos: [dir...] }. Pure filesystem + local git.
// A given base (e.g. C:\Demo, so screenshots show no user name in paths) must be empty
// or a previous demo workspace (it carries .cc-demo); it is rebuilt from scratch.
function seedWorkspace(base) {
  if (base) {
    if (fs.existsSync(base) && fs.readdirSync(base).length && !fs.existsSync(path.join(base, '.cc-demo'))) {
      throw new Error('refusing: ' + base + ' is not empty and is not a demo workspace');
    }
    cleanup(base);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, '.cc-demo'), 'demo workspace (tools/demo-seed.js); safe to delete\n');
  } else {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-demo-'));
  }
  const now = Date.now();
  const repos = REPOS.map((r) => seedRepo(path.join(base, 'Projects'), r, now));
  return { base, repos };
}

// Starts the isolated demo server over a seeded workspace.
async function startDemo(opts) {
  opts = opts || {};
  const ws = seedWorkspace(opts.base);
  const { createConsoleServer } = require(path.join(ROOT, 'server', 'server.js'));
  const srv = await createConsoleServer({
    port: opts.port || 0,
    dataDir: path.join(ws.base, 'data'), runDir: path.join(ws.base, 'run'), dropsDir: path.join(ws.base, 'drops'),
    overrides: {
      scanRoots: [path.join(ws.base, 'Projects')], extraProjects: [], projects: {},
      claudePath: process.execPath, claudeArgs: [path.join(__dirname, 'demo-claude.js')], useHooks: false,
      accounts: { acct1: { label: 'Account 1', configDir: path.join(ws.base, 'claude-config') } }, defaultAccount: 'acct1',
      updates: { check: false, auto: false, repo: '<owner>/claude-console' }, plugins: { main: { enabled: false } },
      // demo shows no host data: no live CPU / RAM / drive readout, no real usage quota file
      resources: { enabled: false }, quotaStateFile: path.join(ws.base, 'no-quota.json'),
    },
    healthSuiteHolders: () => 0, desktopDirs: [path.join(ws.base, 'Desktop')],
  });
  // No URL literal here (the no-egress scan lists every one); callers build it from port + token.
  return { srv, ws, port: srv.port, token: srv.token };
}

function cleanup(base) {
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { /* temp sweep */ }
}

module.exports = { seedWorkspace, startDemo, cleanup, REPOS };

if (require.main === module) {
  startDemo({ port: Number(process.argv[process.argv.indexOf('--port') + 1]) || 0 }).then(({ srv, ws, port, token }) => {
    console.log('demo console on 127.0.0.1 port ' + port + ' - open 127.0.0.1:' + port + '/#t=' + token + ' in your browser');
    const stop = () => srv.close().then(() => { cleanup(ws.base); process.exit(0); });
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
