'use strict';
// Claude Code status line for the plain CLI (wired into ~/.claude-acct2/settings.json).
// Shows: account | model | project (branch +dirty) | context % | 5h / 7d quota.
// Reads stdin JSON from Claude Code; reads git and the quota quota file read-only.
// Never prints names, emails or ids. Always exits 0 with one line.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ESC = '\x1b[';
const c = (code, s) => ESC + code + 'm' + s + ESC + '0m';

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    return {};
  }
}

function accountUuid(configDir) {
  try {
    const f = configDir ? path.join(configDir, '.claude.json') : path.join(os.homedir(), '.claude.json');
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (j.oauthAccount && j.oauthAccount.accountUuid) || null;
  } catch (e) {
    return null;
  }
}

function quotaFor(uuid) {
  if (!uuid) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'claude-quota.state.json'), 'utf8'));
    const q = (j.quota || []).find((x) => x && x.accountUuid === uuid);
    return q ? q.quota : null;
  } catch (e) {
    return null;
  }
}

function git(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'status', '--porcelain=v1', '-b'], { timeout: 1500, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split('\n').filter(Boolean);
    let branch = '';
    if (lines[0] && lines[0].startsWith('## ')) branch = lines.shift().slice(3).replace(/^No commits yet on /, '').split('...')[0].split(' ')[0];
    return { branch, dirty: lines.length };
  } catch (e) {
    return null;
  }
}

function pct(v) {
  if (typeof v !== 'number') return null;
  const n = Math.round(v * 100);
  const col = n >= 90 ? '31' : n >= 70 ? '33' : '32';
  return c(col, n + '%');
}

function main() {
  const d = readStdin();
  const cfgDir = process.env.CLAUDE_CONFIG_DIR || '';
  const acct = /acct2/i.test(cfgDir) ? 'acct2' : cfgDir ? path.basename(cfgDir) : 'acct1';
  const model = (d.model && (d.model.display_name || d.model.id)) || '';
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || process.cwd();
  const parts = [c('1;35', acct)];
  if (model) parts.push(c('36', model));
  let proj = path.basename(cwd);
  const g = git(cwd);
  if (g && g.branch) proj += ' ' + c('90', '(') + g.branch + (g.dirty ? c('33', ' +' + g.dirty) : '') + c('90', ')');
  parts.push(proj);
  const used = d.context_window && d.context_window.used_percentage;
  if (typeof used === 'number') parts.push('ctx ' + pct(used / 100));
  const q = quotaFor(accountUuid(cfgDir || null));
  if (q) {
    const bits = [];
    if (pct(q.unified5h)) bits.push('5h ' + pct(q.unified5h));
    if (pct(q.unified7d)) bits.push('7d ' + pct(q.unified7d));
    if (bits.length) parts.push(bits.join(' '));
  }
  process.stdout.write(parts.join(c('90', ' | ')));
}

try {
  main();
} catch (e) {
  process.stdout.write('statusline error');
}
