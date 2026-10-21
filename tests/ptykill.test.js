'use strict';
// CON-PTY-STALE-KILL (found chasing PROFILE-ADOPT-E3): closing a pane must never
// process.kill() a pid after its process has exited. node-pty 1.1.0 did, 5 s late,
// on the shell pid, which by then could belong to any other process: in the suite it
// killed git children, test-file processes and function-check runs (the E3 bisect
// named a third, innocent culprit; whole test files died with 'test failed').
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const { killPty, EXITED } = require('../server/panes');

// process.kill spy for the duration of fn (signal-0 probes pass through).
async function withKillSpy(fn, real) {
  const calls = [];
  const orig = process.kill;
  process.kill = function (pid, sig) {
    if (sig === 0) return orig.apply(process, arguments);
    calls.push({ pid, at: Date.now() });
    return real ? orig.apply(process, arguments) : true;
  };
  try { await fn(calls); } finally { process.kill = orig; }
  return calls;
}

function fakeProc() {
  const ev = { nodePtyListed: 0, closed: 0 };
  const proc = {
    pid: 4000,
    _agent: { _useConptyDll: false, _getConsoleProcessList: () => { ev.nodePtyListed++; return Promise.resolve([4000]); } },
    kill() { ev.closed++; },
  };
  return { proc, ev };
}

test('live pane: the console list is read first, its pids killed (never the list agent), then the pty closed; node-pty\'s late list kill is disarmed', async () => {
  const { proc, ev } = fakeProc();
  const asked = [];
  const list = async (pid) => { asked.push(pid); return { pids: [4000, 4100, 4999], agentPid: 4999 }; };
  const calls = await withKillSpy(async () => { await killPty(proc, { platform: 'win32', list }); });
  assert.deepStrictEqual(asked, [4000], 'listed by the shell pid');
  assert.deepStrictEqual(calls.map((c) => c.pid), [4000, 4100]);
  assert.strictEqual(ev.closed, 1);
  assert.strictEqual(ev.nodePtyListed, 0);
  assert.deepStrictEqual(await proc._agent._getConsoleProcessList(), [], 'what node-pty would kill 5 s later is empty');
});

test('exited pane: no list, no process.kill, the pty is still closed (sockets, conout worker)', async () => {
  const { proc, ev } = fakeProc();
  EXITED.add(proc);
  let listed = 0;
  const calls = await withKillSpy(async () => { await killPty(proc, { platform: 'win32', list: async () => { listed++; return { pids: [4000], agentPid: null }; } }); });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(listed, 0);
  assert.strictEqual(ev.closed, 1);
  assert.deepStrictEqual(await proc._agent._getConsoleProcessList(), []);
});

test('exit while the list is read: its pids may be stale, none is killed', async () => {
  const { proc, ev } = fakeProc();
  const list = async () => { EXITED.add(proc); return { pids: [4000], agentPid: null }; };
  const calls = await withKillSpy(async () => { await killPty(proc, { platform: 'win32', list }); });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(ev.closed, 1);
});

test('a failing lister kills nothing and still closes the pty', async () => {
  const { proc, ev } = fakeProc();
  const calls = await withKillSpy(async () => { await killPty(proc, { platform: 'win32', list: async () => { throw new Error('x'); } }); });
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(ev.closed, 1);
});

test('non-Windows or the conpty DLL path: plain kill, nothing listed', async () => {
  for (const [p, dll] of [['linux', false], ['win32', true]]) {
    const { proc, ev } = fakeProc();
    proc._agent._useConptyDll = dll;
    let listed = 0;
    const calls = await withKillSpy(async () => { await killPty(proc, { platform: p, list: async () => { listed++; return { pids: [1], agentPid: null }; } }); });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(listed, 0);
    assert.strictEqual(ev.closed, 1);
  }
});

test('node-pty private surface this relies on is still there (exact pin 1.1.0)', () => {
  const pkg = require('node-pty/package.json');
  assert.strictEqual(pkg.version, '1.1.0', 'node-pty changed: re-check killPty against its WindowsPtyAgent.kill');
  const A = require('node-pty/lib/windowsPtyAgent').WindowsPtyAgent;
  assert.strictEqual(typeof A.prototype._getConsoleProcessList, 'function');
  assert.match(String(A.prototype.kill), /_getConsoleProcessList\(\)\.then/);
  assert.ok(require.resolve('node-pty/lib/conpty_console_list_agent'));
});

test('real conpty: closing a live shell kills its console, then nothing after it exited (no late kill of a recycled pid)', { skip: os.platform() !== 'win32', timeout: 30000 }, async () => {
  const pty = require('node-pty');
  const proc = pty.spawn(process.env.ComSpec || 'cmd.exe', [], { cols: 80, rows: 24, cwd: os.tmpdir(), env: process.env });
  const shell = proc.pid;
  let exitedAt = 0;
  proc.onExit(() => { exitedAt = Date.now(); EXITED.add(proc); });
  await new Promise((r) => setTimeout(r, 1000));
  const calls = await withKillSpy(async () => {
    await killPty(proc);
    const t0 = Date.now();
    while (!exitedAt && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(exitedAt, 'the shell exited');
    await new Promise((r) => setTimeout(r, 6000)); // past node-pty's 5 s list timeout
  }, true);
  assert.ok(calls.some((c) => c.pid === shell), 'the live shell was on the list and killed: ' + JSON.stringify(calls));
  const late = calls.filter((c) => c.at >= exitedAt);
  assert.deepStrictEqual(late, [], 'process.kill after exit: ' + JSON.stringify(late) + ' (shell ' + shell + ')');
});
