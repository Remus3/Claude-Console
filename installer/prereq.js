'use strict';
// Prerequisites (CON-PUBLIC B): Node 24+, claude.exe by FULL path (a bare `claude`
// fails from CreateProcess), Edge for the --app window, git for 3-way merges. Missing
// pieces are reported in words, never a silent failure.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveClaude } = require('../server/claudeenv');

const NODE_MAJOR = 24;

function edgeCandidates(env) {
  env = env || process.env;
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  return [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
}

function findEdge(env) {
  for (const c of edgeCandidates(env)) if (fs.existsSync(c)) return c;
  return null;
}

function hasGit(run) {
  const r = (run || spawnSync)('git', ['--version'], { windowsHide: true });
  return !!(r && r.status === 0);
}

// o: env, nodeVersion, claudePath (config), gitCheck (fn -> bool), edge (fn -> path|null)
function checkPrereqs(o) {
  o = o || {};
  const env = o.env || process.env;
  const nodeVersion = o.nodeVersion || process.versions.node;
  const major = parseInt(String(nodeVersion).split('.')[0], 10);
  const claude = resolveClaude({ claudePath: o.claudePath || null }, env);
  const edge = o.edge ? o.edge(env) : findEdge(env);
  const git = o.gitCheck ? o.gitCheck() : hasGit();
  const problems = [];
  if (!(major >= NODE_MAJOR)) problems.push('Node ' + NODE_MAJOR + ' or newer is needed (found ' + nodeVersion + '). Install the LTS from https://nodejs.org (install.ps1 does it for you).');
  const warnings = [];
  // VMFIX: a missing claude CLI never refuses the install; the console runs shells
  // without it and a claude pane says how to get it.
  if (!claude) warnings.push(CLAUDE_MISSING);
  if (!edge) warnings.push('Microsoft Edge was not found; the console opens in a plain browser tab instead of an app window.');
  if (!git) warnings.push(GIT_MISSING);
  return { ok: problems.length === 0, node: { version: nodeVersion, ok: major >= NODE_MAJOR }, claude, edge, git, problems, warnings };
}

const { CLAUDE_MISSING } = require('../server/claudeenv');
const GIT_MISSING = 'Git not found: installing anyway. The self-test skipped its git-dependent tests, projects show without git status, and an update keeps a file changed on both sides aside instead of merging it. Install Git (winget install Git.Git, or https://git-scm.com) and re-run the installer.';

module.exports = { checkPrereqs, findEdge, NODE_MAJOR, CLAUDE_MISSING, GIT_MISSING };
