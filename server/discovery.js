'use strict';
// Project discovery: every git repo directly under each scan root, verified with
// `git -C <dir> rev-parse --show-toplevel`, merged with config overrides.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function norm(p) {
  let r = path.resolve(p);
  try {
    r = fs.realpathSync.native(r); // expands 8.3 short names (ADMINI~1) like git does
  } catch (e) { /* keep resolved */ }
  return r.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// Tests swap _exec.fn to simulate a box without git.
const _exec = { fn: execFile };

// The toplevel path, null when git says no, or GIT_MISSING when git is not installed.
const GIT_MISSING = Symbol('git-missing');
function gitToplevel(dir, timeoutMs) {
  return new Promise((resolve) => {
    _exec.fn('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { timeout: timeoutMs || 8000, windowsHide: true },
      (err, stdout) => resolve(err ? (err.code === 'ENOENT' ? GIT_MISSING : null) : String(stdout).trim()));
  });
}

async function isRepoRoot(dir) {
  // Cheap pre-filter: a repo root has a .git dir or file (worktree).
  if (!fs.existsSync(path.join(dir, '.git'))) return false;
  const top = await gitToplevel(dir);
  // VMFIX: without git the folder is still listed (it just shows no git status).
  if (top === GIT_MISSING) return true;
  return !!top && norm(top) === norm(dir);
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
}

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function discoverProjects(cfg) {
  const roots = cfg.scanRoots || [];
  const exclude = new Set((cfg.excludeDirs || []).map((s) => s.toLowerCase()));
  const overrides = cfg.projects || {};
  const candidates = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const ent of entries) {
      // A junction / symlink to a folder counts too: MIG-1 moves repos to E: and
      // leaves a C: junction behind (fs Dirent reports those as links, not dirs).
      if (!ent.isDirectory() && !(ent.isSymbolicLink() && isDir(path.join(root, ent.name)))) continue;
      if (exclude.has(ent.name.toLowerCase())) continue;
      candidates.push(path.join(root, ent.name));
    }
  }
  for (const extra of cfg.extraProjects || []) candidates.push(extra);
  const seen = new Set();
  const checks = await Promise.all(candidates.map(async (dir) => ({ dir, ok: await isRepoRoot(dir) })));
  const out = [];
  for (const { dir, ok } of checks) {
    if (!ok) continue;
    const key = norm(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    // Report the REAL path: a C: junction left by MIG-1 resolves to its E: target,
    // so the pane cwd (and the .claude projects key) matches where the repo lives.
    let real = path.resolve(dir);
    try { real = fs.realpathSync.native(real); } catch (e) { /* keep resolved */ }
    const name = path.basename(real);
    const o = overrides[name] || {};
    if (o.hidden) continue;
    out.push({
      id: slug(name),
      name,
      dir: real,
      code: o.code || null,
      retired: !!o.retired,
      order: typeof o.order === 'number' ? o.order : 100,
      handoffFallback: o.handoffFallback || null,
      progressDirs: o.progressDirs || cfg.defaultProgressDirs || ['ops/loop/control/progress'],
    });
  }
  out.sort((a, b) => (a.retired - b.retired) || (a.order - b.order) || a.name.localeCompare(b.name));
  return out;
}

module.exports = { discoverProjects, isRepoRoot, gitToplevel, slug, norm, _exec, GIT_MISSING };
