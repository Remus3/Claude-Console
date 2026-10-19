'use strict';
// CON-013 L3x: the function check of an adoption (addendum b.5). Detect the project's own
// test / build / start commands, let the user confirm or edit them, run each one on the
// ORIGINAL side (the pristine base snapshot) and on the CONFORMED copy, and compare them
// side by side: exit code, duration, test counts, newly failing tests, first differing
// output line, verdict same | better | WORSE. Any WORSE blocks promotion; bisect() then
// names the change that caused it.
//
// Checks never run inside the original, and never inside the working copy either: each
// run gets a throwaway run dir (a copy of the side under test) under <adoptDir>/runs/, so
// build output, caches and test artefacts never reach the copy that may be promoted.
// Run dirs are derived scratch (replaceable) and are cleared here, inside runs/ only.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const DEFAULT_TIMEOUT = { test: 300000, build: 300000, start: 20000 };
// The spec reporter marks a failed test with U+2716 (built from its code: ASCII source).
const SPEC_FAIL_RE = new RegExp('^\\s*' + String.fromCharCode(0x2716) + ' (.+?) \\(\\d', 'gm');
const READY_RE = /\b(READY|[Ll]istening|[Rr]eady|[Ss]tarted)\b/;

function readText(dir, rel) { try { return fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8'); } catch (e) { return null; } }
function exists(dir, rel) { return fs.existsSync(path.join(dir, ...rel.split('/'))); }
function list(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }

// ------------------------------------------------------------------ detect

// Returns [{id, kind, label, cmd, source, timeoutMs, ready}] (first of each kind) and
// `alternatives` (other candidates the user may pick). Read only; nothing is executed.
function detectChecks(dir, o) {
  o = o || {};
  const platform = o.platform || process.platform;
  const cand = [];
  const add = (kind, label, cmd, source, extra) => cand.push(Object.assign({ kind, label, cmd, source, timeoutMs: DEFAULT_TIMEOUT[kind] }, extra || {}));
  const pkg = (() => { try { return JSON.parse(readText(dir, 'package.json')); } catch (e) { return null; } })();
  if (pkg && pkg.scripts) {
    for (const k of ['test', 'build', 'start']) {
      const s = pkg.scripts[k];
      if (typeof s === 'string' && s.trim() && !/no test specified/.test(s)) add(k, 'npm ' + (k === 'build' ? 'run build' : k), s.trim(), 'package.json scripts.' + k, k === 'start' ? { ready: READY_RE.source } : null);
    }
  }
  const pyproject = readText(dir, 'pyproject.toml') || '';
  const pyTests = list(path.join(dir, 'tests')).some((f) => /^test_.*\.py$/.test(f)) || list(dir).some((f) => /^test_.*\.py$/.test(f));
  if (exists(dir, 'pytest.ini') || exists(dir, 'tox.ini') || /\[tool\.pytest/.test(pyproject) || pyTests) add('test', 'pytest', 'python -m pytest -q', exists(dir, 'pytest.ini') ? 'pytest.ini' : /\[tool\.pytest/.test(pyproject) ? 'pyproject.toml' : 'tests/test_*.py');
  if (/\[build-system\]/.test(pyproject)) add('build', 'python -m build', 'python -m build', 'pyproject.toml');
  for (const d of list(dir)) {
    if (exists(dir, d + '/__main__.py')) add('start', 'python -m ' + d, 'python -m ' + d + ' --version', d + '/__main__.py');
  }
  for (const f of ['main.py', 'app.py']) if (exists(dir, f)) add('start', 'python ' + f, 'python ' + f, f, { ready: READY_RE.source });
  if (exists(dir, 'go.mod')) { add('test', 'go test', 'go test ./...', 'go.mod'); add('build', 'go build', 'go build ./...', 'go.mod'); }
  if (exists(dir, 'Cargo.toml')) { add('test', 'cargo test', 'cargo test', 'Cargo.toml'); add('build', 'cargo build', 'cargo build', 'Cargo.toml'); }
  if (list(dir).some((f) => /\.(sln|csproj|fsproj)$/i.test(f))) { add('test', 'dotnet test', 'dotnet test', 'solution / project file'); add('build', 'dotnet build', 'dotnet build', 'solution / project file'); }
  const mk = readText(dir, 'Makefile');
  if (mk && /^test:/m.test(mk)) add('test', 'make test', 'make test', 'Makefile');
  if (mk && /^(all|build):/m.test(mk)) add('build', 'make', 'make', 'Makefile');
  if (list(path.join(dir, 'ci')).some((f) => /\.(sh|cmd|ps1)$/.test(f))) {
    const f = list(path.join(dir, 'ci')).find((x) => /test/.test(x)) || list(path.join(dir, 'ci'))[0];
    add('test', 'ci/' + f, (/\.ps1$/.test(f) ? 'powershell -NoProfile -File ' : /\.cmd$/.test(f) ? '' : 'sh ') + 'ci/' + f, 'ci/');
  }
  if (platform === 'win32' && exists(dir, 'start.bat')) add('start', 'start.bat', 'start.bat', 'start.bat', { ready: READY_RE.source });
  if (exists(dir, 'Procfile')) {
    const m = /^web:\s*(.+)$/m.exec(readText(dir, 'Procfile') || '');
    if (m) add('start', 'Procfile web', m[1].trim(), 'Procfile', { ready: READY_RE.source });
  }
  const readme = readText(dir, 'README.md');
  if (readme) {
    const m = /^#{1,4}\s*(?:run|usage|start|running)\b[^\n]*\n+```[a-z]*\n([^\n`]+)\n/im.exec(readme);
    if (m) add('start', 'README run block', m[1].trim(), 'README.md "Run" block', { ready: READY_RE.source });
  }
  const checks = [];
  const alternatives = [];
  for (const c of cand) {
    if (checks.some((x) => x.kind === c.kind)) alternatives.push(c);
    else checks.push(Object.assign({ id: c.kind }, c));
  }
  return { checks, alternatives };
}

// Applies the user's edits: list of "kind=command" (empty command = drop the check).
function editChecks(checks, edits) {
  const out = checks.map((c) => Object.assign({}, c));
  for (const e of edits || []) {
    const i = String(e).indexOf('=');
    if (i <= 0) throw new Error('a check edit is kind=command (e.g. test="npm test")');
    const id = String(e).slice(0, i).trim();
    const cmd = String(e).slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
    const at = out.findIndex((c) => c.id === id);
    if (!cmd) { if (at >= 0) out.splice(at, 1); continue; }
    const kind = ['test', 'build', 'start'].includes(id) ? id : 'test';
    const c = { id, kind, label: id + ' (yours)', cmd, source: 'user', timeoutMs: DEFAULT_TIMEOUT[kind] };
    if (kind === 'start') c.ready = READY_RE.source;
    if (at >= 0) out[at] = Object.assign({}, out[at], { cmd, label: out[at].label + ' (edited)', source: 'user' });
    else out.push(c);
  }
  return out;
}

// ------------------------------------------------------------------ run

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (x) { /* gone */ } } }
}

// The default runner: the command through the shell in cwd, node_modules/.bin on PATH,
// a timeout, and for a start check (check.ready) success as soon as the readiness line
// appears (the process tree is then stopped by pid). Resolves {code, out, ms, timedOut, ready}.
function defaultRun(check, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env = Object.assign({}, process.env, { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' });
    // The project's own runner must not inherit this process's test-runner context (a
    // nested `node --test` would report to us as a child and hide its results).
    for (const k of Object.keys(env)) if (/^NODE_TEST_/i.test(k)) delete env[k];
    const bin = path.join(cwd, 'node_modules', '.bin');
    const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pk] = bin + path.delimiter + (env[pk] || '');
    const child = spawn(check.cmd, { cwd, shell: true, windowsHide: true, env, detached: process.platform !== 'win32' });
    let out = '';
    let done = false;
    const ready = check.ready ? new RegExp(check.ready) : null;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(Object.assign({ ms: Date.now() - t0, out }, r)); };
    const onData = (b) => {
      out += b.toString('utf8');
      if (out.length > 400000) out = out.slice(-400000);
      if (ready && ready.test(out)) { killTree(child.pid); finish({ code: 0, ready: true, timedOut: false }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { killTree(child.pid); finish({ code: null, timedOut: true, ready: false }); }, check.timeoutMs || 60000);
    child.on('error', (e) => finish({ code: 127, out: out + '\n' + e.message, timedOut: false, ready: false }));
    child.on('close', (code) => finish({ code, timedOut: false, ready: false }));
  });
}

// Test counts and failing test names from node:test (TAP and spec), pytest and jest.
function parseCounts(text) {
  const t = String(text || '');
  const num = (re) => { const m = re.exec(t); return m ? +m[1] : null; };
  let passed = num(/^# pass (\d+)/m);
  let failed = num(/^# fail (\d+)/m);
  let skipped = num(/^# skip(?:ped)? (\d+)/m);
  if (passed === null) { passed = num(/^\S* ?pass (\d+)$/m); failed = num(/^\S* ?fail (\d+)$/m); skipped = num(/^\S* ?skipped (\d+)$/m); }
  if (passed === null) {
    const py = /=+ (.*?(?:passed|failed|error)[^=]*) in [\d.]+s/.exec(t) || /^(\d+ (?:passed|failed).*)$/m.exec(t);
    if (py) { const s = py[1]; const g = (w) => { const m = new RegExp('(\\d+) ' + w).exec(s); return m ? +m[1] : 0; }; passed = g('passed'); failed = g('failed') + g('error'); skipped = g('skipped'); }
  }
  if (passed === null) {
    const j = /^Tests:\s+(.*)$/m.exec(t);
    if (j) { const g = (w) => { const m = new RegExp('(\\d+) ' + w).exec(j[1]); return m ? +m[1] : 0; }; passed = g('passed'); failed = g('failed'); skipped = g('skipped'); }
  }
  const failing = [];
  for (const m of t.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)) if (!/^tests?[\\/]|\.test\.|\.js$/.test(m[1]) &&!failing.includes(m[1])) failing.push(m[1]);
  for (const m of t.matchAll(/^FAILED (\S+)/gm)) if (!failing.includes(m[1])) failing.push(m[1]);
  for (const m of t.matchAll(SPEC_FAIL_RE)) if (!failing.includes(m[1])) failing.push(m[1]);
  return passed === null ? { passed: null, failed: null, skipped: null, failing } : { passed, failed: failed || 0, skipped: skipped || 0, failing };
}

// Output normalised for the first-difference line: no durations, ports, run-dir paths.
function normOut(text, dir) {
  let t = String(text || '').replace(/\r/g, '');
  if (dir) for (const v of [dir, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '\\\\')]) t = t.split(v).join('<root>');
  return t.replace(/\(?\b\d+(?:\.\d+)?\s?m?s\b\)?/g, '<t>').replace(/duration_ms [\d.]+/g, 'duration_ms <t>').replace(/READY \d+/g, 'READY <port>').replace(/:\d{4,5}\b/g, ':<port>').split('\n').map((l) => l.trimEnd());
}

function summarize(check, r, dir) {
  const counts = parseCounts(r.out);
  const ok = check.kind === 'start' ? r.code === 0 || r.ready === true : r.code === 0;
  return { id: check.id, kind: check.kind, cmd: check.cmd, code: r.code, ok, ms: r.ms, timedOut: !!r.timedOut, ready: !!r.ready, counts, lines: normOut(r.out, dir).slice(-200) };
}

// Verdict of the copy against the original for one check.
function compare(orig, copy) {
  const rank = (x) => (x.ok ? 1 : 0);
  const why = [];
  let verdict = 'same';
  if (rank(copy) < rank(orig)) { verdict = 'WORSE'; why.push(orig.ok ? 'passed on the original, fails on the copy' : 'worse exit'); }
  else if (rank(copy) > rank(orig)) { verdict = 'better'; why.push('fails on the original, passes on the copy'); }
  const a = orig.counts;
  const b = copy.counts;
  if (a && b && a.passed !== null && b.passed !== null) {
    if (b.failed > a.failed || b.passed < a.passed) { verdict = 'WORSE'; why.push('tests ' + a.passed + '/' + a.failed + ' -> ' + b.passed + '/' + b.failed + ' (pass/fail)'); }
    else if (verdict === 'same' && (b.failed < a.failed || b.passed > a.passed)) { verdict = 'better'; why.push('more tests pass'); }
  }
  const newly = (b && b.failing ? b.failing : []).filter((n) => !(a && a.failing ? a.failing : []).includes(n));
  if (newly.length) { verdict = 'WORSE'; why.push('newly failing: ' + newly.join(', ')); }
  let firstDiff = null;
  const n = Math.max(orig.lines.length, copy.lines.length);
  for (let i = 0; i < n; i++) if (orig.lines[i] !== copy.lines[i]) { firstDiff = { original: orig.lines[i] === undefined ? null : orig.lines[i], copy: copy.lines[i] === undefined ? null : copy.lines[i] }; break; }
  return { verdict, why, newlyFailing: newly, firstDiff };
}

// ------------------------------------------------------------------ run dirs

function runsRoot(adoptDir) { return path.join(adoptDir, 'runs'); }

let runSeq = 0;
function newRunDir(adoptDir, label) {
  const d = path.join(runsRoot(adoptDir), String(process.pid) + '-' + (++runSeq) + '-' + label.replace(/[^a-z0-9-]/gi, ''));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Clears one run dir: derived scratch, only ever inside <adoptDir>/runs/.
function clearRunDir(adoptDir, dir) {
  const root = path.resolve(runsRoot(adoptDir));
  const abs = path.resolve(dir);
  if (!abs.startsWith(root + path.sep)) throw new Error('refused: not a run dir');
  const writable = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) writable(path.join(p, n));
    try { fs.chmodSync(p, st.isDirectory() ? 0o777 : 0o666); } catch (e) { /* best effort */ }
  };
  writable(abs);
  fs.rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
}

// Runs one check in a fresh run dir prepared by prepare(dir) (copies the side under test).
async function runIn(adoptDir, label, prepare, check, run) {
  const dir = newRunDir(adoptDir, label + '-' + check.id);
  try {
    await prepare(dir);
    const r = await (run || defaultRun)(check, dir);
    return summarize(check, r, dir);
  } finally {
    try { clearRunDir(adoptDir, dir); } catch (e) { /* left for the next prune */ }
  }
}

// Side by side: every confirmed check on the original side and on the copy side.
// prepareOriginal / prepareCopy(dir) materialise each side into a run dir.
async function sideBySide(o) {
  const rows = [];
  for (const c of o.checks) {
    const orig = await runIn(o.adoptDir, 'orig', o.prepareOriginal, c, o.run);
    const copy = await runIn(o.adoptDir, 'copy', o.prepareCopy, c, o.run);
    rows.push(Object.assign({ id: c.id, kind: c.kind, cmd: c.cmd, label: c.label, original: orig, copy }, compare(orig, copy)));
  }
  const worse = rows.filter((r) => r.verdict === 'WORSE');
  return { rows, ok: worse.length === 0, verdict: worse.length ? 'FAILED' : 'passed' };
}

// ------------------------------------------------------------------ bisect

// Names the change(s) that make a check WORSE. ids: the applied change ids in apply
// order; probe(subset) resolves true when applying exactly that subset makes the check
// WORSE. Groups first (prefix halves), then single changes: each culprit costs at most
// log2(n)+1 probes. After a culprit is named it is left out and the rest is probed again,
// so two independent breakers are both named. Returns {culprits: [{id, probes}], probes}.
async function bisect(ids, probe, o) {
  o = o || {};
  const maxCulprits = o.maxCulprits || ids.length;
  let probes = 0;
  const p = async (s) => { probes++; return probe(s); };
  const culprits = [];
  let rest = ids.slice();
  let worse = o.knownWorse === true ? true : await p(rest);
  while (worse && rest.length && culprits.length < maxCulprits) {
    const before = probes;
    let lo = 0;
    let hi = rest.length; // prefix(hi) is worse, prefix(lo) is not (the empty set is the original)
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (await p(rest.slice(0, mid))) hi = mid; else lo = mid;
    }
    const c = rest[hi - 1];
    culprits.push({ id: c, probes: probes - before });
    rest = rest.filter((x) => x !== c);
    worse = rest.length ? await p(rest) : false;
  }
  return { culprits, probes, rest };
}

module.exports = { detectChecks, editChecks, defaultRun, parseCounts, normOut, summarize, compare, sideBySide, runIn, bisect, newRunDir, clearRunDir, runsRoot, READY_RE, killTree };
