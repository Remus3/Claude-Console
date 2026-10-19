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

function buildPaneEnv(base, opts) {
  opts = opts || {};
  const env = copyEnv(base);
  for (const v of SESSION_VARS) deleteVar(env, v);
  if (opts.kind === 'claude') {
    const acct = opts.account || {};
    if (acct.configDir) env.CLAUDE_CONFIG_DIR = acct.configDir;
  }
  env.COLORTERM = 'truecolor';
  if (opts.paneId) env.CONSOLE_PANE = opts.paneId;
  if (opts.hookUrl) env.CONSOLE_HOOK_URL = opts.hookUrl;
  if (opts.hookSecret) env.CONSOLE_HOOK_SECRET = opts.hookSecret;
  return env;
}

// --settings payload that reports turn state back to the console (additive; merges
// with the user's own settings and hooks).
function hookSettings(nodePath, hookScript) {
  const q = (p) => '"' + p.replace(/\\/g, '/') + '"';
  const cmd = (ev) => q(nodePath) + ' ' + q(hookScript) + ' ' + ev;
  const h = (ev) => [{ hooks: [{ type: 'command', command: cmd(ev), timeout: 5 }] }];
  return {
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
// official native installer), plus where to point the console at a claude.exe.
const CLAUDE_MISSING = 'Claude Code CLI not found - install it with: irm https://claude.ai/install.ps1 | iex';
function claudeMissingMessage(cfg) {
  const file = path.join((cfg && cfg.dataDir) || path.join(__dirname, '..', 'data'), 'console.local.json');
  return CLAUDE_MISSING + '. Already installed elsewhere? Set "claudePath" to the full path of claude.exe in ' + file;
}

module.exports = { resolveClaude, buildPaneEnv, hookSettings, SESSION_VARS, claudeCandidates, CLAUDE_MISSING, claudeMissingMessage };
