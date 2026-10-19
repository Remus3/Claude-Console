'use strict';
// CON-013 L5: seeded FAKE setup profile for the UI tests and the isolated e2e run.
// 22 modules in the shipped order with a few made-up items each (no real content, no
// machine detail). It exercises every UI path: a locked module, item dependencies, a
// conflict pair, high-risk env items, a secret reference, scheduled tasks, a git key
// that needs an input, templates to view and edit, a remus3 preset and the review step.
// fakeAdapters() are in-memory env / tasks / git / recycle doubles: nothing here ever
// touches the registry, the scheduler or the Recycle Bin.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODULES = ['floors', 'core-rules', 'session', 'output', 'subagent-first', 'race-guards', 'attribution',
  'tdd-agents', 'docs-memory', 'fleet', 'headless', 'maintenance', 'insights', 'board', 'console',
  'ci-gates', 'recall', 'lessons', 'permissions-context', 'sidecar', 'runtime-agents', 'machine-profile'];

const TITLES = {
  floors: 'Safety floors', 'core-rules': 'Core rules', session: 'Session shape', output: 'Quiet output',
  'subagent-first': 'Sub-agent first', 'race-guards': 'Race guards', attribution: 'Commit attribution',
  'tdd-agents': 'Test-first agents', 'docs-memory': 'Docs and memory', fleet: 'Several repos',
  headless: 'Headless runs', maintenance: 'Maintenance tasks', insights: 'Insights reports', board: 'Status board',
  console: 'Console wiring', 'ci-gates': 'Verification gates', recall: 'Recall before build', lessons: 'Lessons',
  'permissions-context': 'Permissions and context', sidecar: 'Sidecar folders', 'runtime-agents': 'Runtime agents',
  'machine-profile': 'Machine profile',
};
const DEFAULT_ON = new Set(['floors', 'core-rules', 'session', 'output', 'attribution', 'tdd-agents', 'docs-memory',
  'console', 'ci-gates', 'recall', 'lessons', 'permissions-context']);

const ALL = ['win32', 'darwin', 'linux'];

function item(mod, order, pos, o) {
  return Object.assign({
    id: mod + '-item-' + pos,
    order: order * 100 + pos,
    title: TITLES[mod] + ' item ' + pos,
    does: 'Adds the ' + TITLES[mod].toLowerCase() + ' rule number ' + pos + ' to the repo.',
    why: 'The author turns it on so every session follows the same rule.',
    risk: 'low', default: 'on', platform: ALL, depends_on: [], pairs_with: [], conflicts_with: [],
    contributes: [{ kind: 'file', target: 'repo:docs/profile/' + mod + '-' + pos + '.md', template: 'templates/' + mod + '-' + pos + '.md', mode: 'managed' }],
    detect: [{ file: 'repo:docs/profile/' + mod + '-' + pos + '.md' }],
    verify: [{ 'file-ascii-lf': 'repo:docs/profile/' + mod + '-' + pos + '.md' }],
  }, o || {});
}

const TASK_XML = (what) => '<?xml version="1.0"?>\n<Task><Description>' + what + '</Description><Exec>{python}</Exec></Task>\n';

function moduleFor(mod, order) {
  const items = [item(mod, order, 1), item(mod, order, 2, { default: order === 1 ? 'on' : 'off', title: TITLES[mod] + ' extra' })];
  if (mod === 'session') {
    items[0] = item(mod, order, 1, {
      id: 'conv-handoff-file', title: 'Hand-off file at the repo root',
      does: 'Creates {handoff_name} and a rule telling every session to read it first.',
      why: 'Chat does not survive /clear; the next session starts from the file.',
      pairs_with: ['conv-session-env'],
      contributes: [{ kind: 'file', target: 'repo:{handoff_name}', template: 'templates/handoff.txt', mode: 'create-only' }],
      detect: [{ file: 'repo:*-NEXT-SESSION.txt' }], verify: [{ 'file-ascii-lf': 'repo:{handoff_name}' }],
    });
    items[1] = item(mod, order, 2, {
      id: 'conv-session-env', title: 'UTF-8 for Python children', risk: 'high', default: 'on', platform: ['win32'],
      does: 'Sets the user variable PYTHONUTF8=1.', why: 'Hook scripts print non-ASCII text without crashing.',
      depends_on: ['conv-handoff-file'], pairs_with: ['conv-handoff-file'],
      contributes: [{ kind: 'env', name: 'PYTHONUTF8', value: '1' }], detect: [{ env: 'PYTHONUTF8' }], verify: [{ 'env-readback': 'PYTHONUTF8' }],
    });
  }
  if (mod === 'attribution') {
    items[1] = item(mod, order, 2, {
      id: 'attr-operator-ident', title: 'Your git identity for commits', default: 'on',
      does: 'Stores your own name and email in the repo git config only.', why: 'Commits carry your identity, never an AI co-author.',
      contributes: [{ kind: 'git', key: 'kit.operatorIdent', value: '{operator_ident}' }], detect: [{ git: 'kit.operatorIdent' }], verify: [],
    });
  }
  if (mod === 'docs-memory') {
    items.push(item(mod, order, 3, { id: 'md-wakeup-notes', title: 'Wake-up notes', default: 'off', conflicts_with: ['docs-memory-item-2'], does: 'A short note file read at session start.', why: 'Some people prefer a note over the hand-off.' }));
    items[1].conflicts_with = ['md-wakeup-notes'];
    items[1].default = 'on';
  }
  if (mod === 'race-guards') items[1].depends_on = ['race-guards-item-1'];
  if (mod === 'output') {
    items[1] = item(mod, order, 2, {
      id: 'out-no-flicker', title: 'No flicker redraw', risk: 'high', default: 'on', platform: ['win32'],
      does: 'Sets the user variable CLAUDE_CODE_NO_FLICKER=1.', why: 'A calm display: no repaint flashes.',
      contributes: [{ kind: 'env', name: 'CLAUDE_CODE_NO_FLICKER', value: '1' }], detect: [{ env: 'CLAUDE_CODE_NO_FLICKER' }], verify: [{ 'env-readback': 'CLAUDE_CODE_NO_FLICKER' }],
    });
  }
  if (mod === 'headless') {
    items[0] = item(mod, order, 1, {
      id: 'hl-api-key', title: 'API key for headless runs (reference only)', risk: 'high', default: 'on', platform: ['win32'],
      does: 'Mirrors the stored API key into a user variable as a reference.', why: 'Headless runs read the key without it living in a file.',
      contributes: [{ kind: 'env', name: 'ANTHROPIC_API_KEY', secret: 'anthropic-key' }], detect: [{ env: 'ANTHROPIC_API_KEY' }], verify: [],
    });
    items[1] = item(mod, order, 2, {
      id: 'hl-kill-switch', title: 'Headless kill switch', risk: 'high', default: 'on', platform: ['win32'],
      does: 'Sets CLAUDE_HEADLESS_BASE_URL to the loopback proxy URL you run.', why: 'Delete the variable and every next headless run stops.',
      depends_on: ['hl-api-key'],
      contributes: [{ kind: 'env', name: 'CLAUDE_HEADLESS_BASE_URL', value: '{headless_base_url}' }], detect: [{ env: 'CLAUDE_HEADLESS_BASE_URL' }], verify: [],
    });
  }
  if (mod === 'maintenance' || mod === 'insights') {
    const name = mod === 'maintenance' ? 'ClaudeProfile-TempHygiene' : 'ClaudeProfile-Insights';
    items[0] = item(mod, order, 1, {
      id: mod + '-task', title: (mod === 'maintenance' ? 'Temp hygiene' : 'Weekly insights') + ' scheduled task', risk: 'high', default: 'on', platform: ['win32'],
      does: mod === 'maintenance' ? 'Every 4 hours: moves stale scratch files from Temp to the Recycle Bin.' : 'Fridays at 17:00: writes the weekly report into your reports folder.',
      why: mod === 'maintenance' ? 'Temp file count is logon time.' : 'One report a week instead of ad-hoc checks.',
      contributes: [{ kind: 'task', name, template: 'templates/task.xml' }], verify: [{ 'task-readback': name }],
    });
  }
  return {
    schema: 1, id: mod, order, title: TITLES[mod], summary: 'What ' + TITLES[mod].toLowerCase() + ' gives you, in one line.',
    why: 'Why the author turns ' + TITLES[mod].toLowerCase() + ' on.', default: DEFAULT_ON.has(mod) ? 'on' : 'off', locked: mod === 'floors', items,
  };
}

const PROFILE = {
  schema: 1, profile: 'fixture-ui', version: '1.0.0', console_min: '0.1.3', kit_source_version: 20, modules: MODULES,
  presets: { recommended: [...DEFAULT_ON], minimal: ['floors', 'core-rules', 'session', 'attribution', 'lessons'], full: '*' },
  variables: {
    repo_code: { type: 'code', pattern: '^[A-Z][A-Z0-9]{1,5}$', ask: 'wizard.step.repo', why: 'Short code used in the hand-off file name.' },
    repo_root: { type: 'path', scope: 'target' },
    handoff_name: { type: 'derived', value: '{repo_code}-NEXT-SESSION.txt' },
    python: { type: 'exe', detect: 'python', why: 'Runs the kit hooks.' },
    operator_ident: { type: 'git-ident', ask: 'wizard.step.identity', why: 'Your own name and email for commits.', store: 'git-config-local' },
    headless_base_url: { type: 'url', pattern: '^http://127\\.0\\.0\\.1:[0-9]{2,5}/?$', optional: true, ask: 'wizard.step.headless', why: 'The loopback proxy URL you run for headless runs.' },
  },
};

const REVIEW = {
  schema: 1, step: 'review', title: 'Before you enable anything',
  lead: "Before you enable modules, read what each one does and review the .md files it adds. You're in control and can turn anything off later.",
  licence: "The console and its setup are provided as-is under the Apache-2.0 licence. The author isn't liable for what they do on your machine.",
  safeguards_heading: 'Already in place',
  safeguards: [
    { glyph: '[+]', word: 'Dry run', text: 'Nothing is written until the final Apply step; every change is shown first.' },
    { glyph: '[+]', word: 'Copy first', text: 'Adopting an existing project works on a copy.' },
    { glyph: '[+]', word: 'Your choice', text: 'Every module and every change has its own yes or no.' },
    { glyph: '[+]', word: 'Backups', text: 'Each apply saves what it replaces, and revert puts it back.' },
    { glyph: '[+]', word: 'Recycle Bin', text: 'Files the profile created go to the Recycle Bin when removed.' },
    { glyph: '[+]', word: 'No telemetry', text: 'Nothing about you or your work is sent anywhere.' },
    { glyph: '[+]', word: 'Stop', text: 'Stop everything halts the console processes, profile tasks and hooks in one step.' },
  ],
  checkbox: "I've read this and I'm choosing what to enable", ask_again: 'major',
};

function w(f, s) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); }

// Writes the fake profile into dir (created). Returns dir.
function seedProfile(dir, o) {
  o = o || {};
  const prof = JSON.parse(JSON.stringify(PROFILE));
  if (o.version) prof.version = o.version;
  w(path.join(dir, 'profile.json'), JSON.stringify(prof, null, 2) + '\n');
  w(path.join(dir, 'review-step.json'), JSON.stringify(REVIEW, null, 2) + '\n');
  const preset = { schema: 1, preset: 'remus3', version: prof.version, modules: '*', items: {}, variables: { headless_base_url: null } };
  MODULES.forEach((mod, i) => {
    const m = moduleFor(mod, i + 1);
    if (o.extraItem && mod === 'lessons') m.items.push(item(mod, i + 1, m.items.length + 1, { id: 'lessons-new-rule', title: 'A new lesson', default: 'on' }));
    w(path.join(dir, 'modules', mod, 'module.json'), JSON.stringify(m, null, 2) + '\n');
    for (const it of m.items) {
      for (const c of it.contributes) {
        if (!c.template) continue;
        const f = path.join(dir, 'modules', mod, ...c.template.split('/'));
        if (c.kind === 'task') w(f, TASK_XML(it.title));
        else if (c.template === 'templates/handoff.txt') w(f, 'SESSION: 1\nRead this file first; it is the only continuity for {repo_code}.\n');
        else w(f, '# ' + it.title + '\n\n' + it.does + '\n\nWhy: ' + it.why + '\n');
      }
      // remus3 = everything on except the conflict partner and the extra items of modules 20-22.
      preset.items[it.id] = it.id === 'md-wakeup-notes' || (i >= 19 && /-item-2$/.test(it.id)) ? 'off' : 'on';
    }
  });
  w(path.join(dir, 'presets', 'remus3.json'), JSON.stringify(preset, null, 2) + '\n');
  return dir;
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fakeAdapters(o) {
  o = o || {};
  const envM = new Map();
  const taskM = new Map();
  const gitM = new Map();
  const secrets = new Map();
  const env = {
    m: envM,
    get: (n) => (envM.has(n) ? { present: true, sha256: sha(Buffer.from(envM.get(n))) } : { present: false }),
    set: (n, v) => { envM.set(n, v.value !== undefined ? v.value : 'ref:' + v.secret); },
    unset: (n) => { envM.delete(n); },
    snapshot: (n) => (envM.has(n) ? { token: Buffer.from(envM.get(n)).toString('base64') } : { absent: true }),
    restore: (n, s) => { if (!s || s.absent) envM.delete(n); else if (s.token) envM.set(n, Buffer.from(s.token, 'base64').toString()); },
  };
  const tasks = {
    m: taskM,
    get: (n) => (taskM.has(n) ? { present: true, enabled: taskM.get(n).enabled, xml: taskM.get(n).xml } : { present: false }),
    exportXml: (n) => (taskM.has(n) ? taskM.get(n).xml : null),
    register: (n, xml) => taskM.set(n, { xml, enabled: true }),
    remove: (n) => taskM.delete(n),
    setEnabled: (n, on) => { if (taskM.has(n)) taskM.get(n).enabled = on; },
  };
  const git = { m: gitM, get: (repo, k) => (gitM.has(repo + '|' + k) ? gitM.get(repo + '|' + k) : null), set: (repo, k, v) => gitM.set(repo + '|' + k, v), unset: (repo, k) => gitM.delete(repo + '|' + k) };
  const binDir = o.binDir || null;
  let n = 0;
  const recycle = async (p) => { if (binDir) { fs.mkdirSync(binDir, { recursive: true }); fs.renameSync(p, path.join(binDir, (n++) + '-' + path.basename(p))); } return true; };
  // Secret store double: the same surface as profile-secrets.createSecretStore.
  const secretStore = {
    m: secrets,
    status: (name) => ({ name, present: secrets.has(name), display: secrets.has(name) ? 'set (' + secrets.get(name).length + ' chars)' : 'not set' }),
    list: () => [...secrets.keys()].map((k) => secretStore.status(k)),
    put: async (name, value, a) => {
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) return { status: 'refused', name, reason: 'bad secret name' };
      if (typeof value !== 'string' || !value.length) return { status: 'refused', name, reason: 'empty value' };
      if (!a || a.apply !== true) return { status: 'dry-run', name };
      secrets.set(name, value);
      return { status: 'applied', name, display: secretStore.status(name).display };
    },
  };
  return { env, tasks, git, recycle, secrets: secretStore };
}

// A sample repo with a little content (the profile target in the e2e run).
function seedRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  w(path.join(dir, 'README.md'), '# sample-api\n\nA seeded demo repo.\n');
  w(path.join(dir, 'CLAUDE.md'), '# sample-api\n\nProject notes.\n');
  return dir;
}

module.exports = { MODULES, TITLES, seedProfile, fakeAdapters, seedRepo, REVIEW };
