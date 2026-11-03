'use strict';
// Resolve the claude executable and build per-pane environments.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Variables that belong to the Claude session that may have started this server.
// A pane must start as a fresh top-level session, so these never leak into it.
const SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CONFIG_DIR', 'CONSOLE_PANE', 'CONSOLE_HOOK_URL', 'CONSOLE_HOOK_SECRET',
];

function exists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}

function claudeCandidates(env) {
  env = env || process.env;
  const appdata = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const list = [
    path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  ];
  for (const dir of String(env.PATH || env.Path || '').split(';')) {
    if (dir) list.push(path.join(dir.replace(/^"|"$/g, ''), 'claude.exe'));
  }
  return list;
}

function resolveClaude(cfg, env) {
  if (cfg && cfg.claudePath && exists(cfg.claudePath)) return cfg.claudePath;
  for (const c of claudeCandidates(env)) {
    if (exists(c) && !/WindowsApps/i.test(c)) return c;
  }
  return null;
}

// Case-insensitive env copy (Windows env names are case-insensitive).
function copyEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base || {})) if (v !== undefined) out[k] = v;
  return out;
}

function deleteVar(env, name) {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k];
}

// SIDECAR-TEMP-SESSION (measured 2026-10-26): claude honours
// CLAUDE_CODE_TMPDIR only from its PROCESS environment - a settings.json "env"
// value reaches tool children but the session temp still lands in %TEMP%\claude.
// So a claude pane gets the same temp root the kit gives a headless spawn
// (the headless spawn helper's child env): <sidecar root>\<CODE>\Temp\claude, only when
// <sidecar root>\<CODE> exists. CODE = the roster tree whose root holds the pane
// cwd (longest root wins); anything else -> null (unchanged behaviour).
function normDir(p) {
  return path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

function rosterTrees(rosterFile) {
  try {
    const doc = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
    return [].concat(doc.repos || [], doc.extra_trees || [])
      .filter((r) => r && r.code && r.root && !r.removed)
      .map((r) => ({ code: String(r.code), root: String(r.root) }));
  } catch (e) {
    return [];
  }
}

function paneTmpDir(cwd, opts) {
  opts = opts || {};
  if (!cwd) return null;
  const trees = opts.trees || rosterTrees(opts.rosterFile);
  const c = normDir(cwd);
  let best = null;
  for (const t of trees) {
    const r = normDir(t.root);
    if ((c === r || c.startsWith(r + path.sep)) && (!best || r.length > best.len)) best = { code: t.code, len: r.length };
  }
  if (!best) return null;
  const env = opts.env || process.env;
  const root = opts.sidecarRoot || (env.KIT_SIDECAR_ROOT || '').trim();
  if (!root) return null;
  const side = path.join(root, best.code);
  const isDir = opts.isDir || ((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
  return isDir(side) ? path.join(side, 'Temp', 'claude') : null;
}

function buildPaneEnv(base, opts) {
  opts = opts || {};
  const env = copyEnv(base);
  for (const v of SESSION_VARS) deleteVar(env, v);
  // CON-AUDIT SEC-1a: the console's own API keys (CON-CREDITS, possibly Admin keys) never
  // reach a pane process or its tools.
  for (const k of Object.keys(env)) if (/^CLAUDE_CONSOLE_.+_API_KEY$/i.test(k)) delete env[k];
  if (opts.kind === 'run') {
    // CON-AUDIT SEC-8: a run pane executes another tree's code: no hook channel.
    env.COLORTERM = 'truecolor';
    if (opts.paneId) env.CONSOLE_PANE = opts.paneId;
    return env;
  }
  if (opts.kind === 'claude') {
    const acct = opts.account || {};
    if (acct.configDir) env.CLAUDE_CONFIG_DIR = acct.configDir;
    // CON-SCROLL-CONPTY: under the bundled conpty.dll claude picks its fullscreen
    // (alternate screen) renderer; the console's scrollback, Find, input marks and
    // composer-only crop read the normal buffer, so a pane keeps the classic renderer.
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
    if (opts.tmpDir) {
      deleteVar(env, 'CLAUDE_CODE_TMPDIR');
      env.CLAUDE_CODE_TMPDIR = opts.tmpDir;
    }
  }
  env.COLORTERM = 'truecolor';
  if (opts.paneId) env.CONSOLE_PANE = opts.paneId;
  if (opts.hookUrl) env.CONSOLE_HOOK_URL = opts.hookUrl;
  if (opts.hookSecret) env.CONSOLE_HOOK_SECRET = opts.hookSecret;
  // CON-MACHINE-READ: claude panes learn where the Read machine result lives (hook.js
  // names it once at SessionStart)
  if (opts.kind === 'claude' && opts.machineFile) env.CONSOLE_MACHINE_FILE = opts.machineFile;
  return env;
}

// --settings payload that reports turn state back to the console (additive; merges
// with the user's own settings and hooks).
function hookSettings(nodePath, hookScript) {
  const q = (p) => '"' + p.replace(/\\/g, '/') + '"';
  const cmd = (ev) => q(nodePath) + ' ' + q(hookScript) + ' ' + ev;
  const h = (ev) => [{ hooks: [{ type: 'command', command: cmd(ev), timeout: 5 }] }];
  return {
    // CON-OSC-PROGRESS: Claude Code's OSC 9;4 progress (scope "any file", so the additive
    // --settings file may set it); the pane draws it, the hook states stay the authority.
    terminalProgressBarEnabled: true,
    hooks: {
      UserPromptSubmit: h('busy'),
      Stop: h('waiting'),
      Notification: h('attention'),
      SessionStart: h('ready'),
      // R5 (measured 2026-10-08: hook.js 42 ms median per run, busiest session
      // 825 tool calls/h, median gap 1.9 s): the pane says which tool runs, e.g. `Bash 2m`.
      PreToolUse: h('tool'),
      PostToolUse: h('tooldone'),
    },
  };
}

// VMFIX: the one line a stranger needs when the Claude Code CLI is missing (the
// official native installer). A pane says it in plain words; pointing the console at a
// claude.exe elsewhere is a README Troubleshooting line.
const CLAUDE_MISSING = 'Claude Code CLI not found - install it with: irm https://claude.ai/install.ps1 | iex';
function claudeMissingMessage() {
  return 'Claude Code is not installed. In PowerShell run: irm https://claude.ai/install.ps1 | iex   Then click the project again.';
}

module.exports = { resolveClaude, buildPaneEnv, paneTmpDir, rosterTrees, hookSettings, SESSION_VARS, claudeCandidates, CLAUDE_MISSING, claudeMissingMessage };
