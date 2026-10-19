'use strict';
// Setup profile schema (CON-013 L0). Validates profile.json, each module.json and a whole
// profile directory against console/profile/SCHEMA.md. Pure: reads files, never writes,
// never throws on bad input. Every error is {path, msg}; ok is errors.length === 0.
const fs = require('fs');
const path = require('path');

const CONTRIBUTION_KINDS = Object.freeze(['file', 'block', 'json-merge', 'env', 'task', 'git', 'kit', 'app-config']);
const VARIABLE_TYPES = Object.freeze(['code', 'path', 'relpath', 'derived', 'exe', 'url', 'git-ident', 'int',
  'object', 'ssh-alias', 'string', 'bool']);
const VERIFY_KINDS = Object.freeze(['file-ascii-lf', 'regex', 'json-parse', 'hook-smoke', 'env-readback',
  'task-readback', 'git-hooks', 'budget']);
const DETECT_KINDS = Object.freeze(['file', 'text', 'json', 'env', 'git']);
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux']);
const RISKS = Object.freeze(['low', 'medium', 'high']);
const FILE_MODES = Object.freeze(['create-only', 'managed', 'replace-ask']);
const JSON_MERGE_TARGETS = Object.freeze(['repo:.claude/settings.json', 'repo:.claude/settings.local.json', 'user:settings.json']);
const ITEM_SCOPES = Object.freeze(['generic', 'machine-specific', 'template']);
// Placeholders the engine always knows (resolved per machine at plan time, never stored).
const BUILTIN_VARIABLES = Object.freeze(['documents', 'home', 'temp', 'data_dir']);

const ID = /^[a-z][a-z0-9-]*$/;
const VAR_NAME = /^[a-z][a-z0-9_]*$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const VAR_REF = /(?<!\$)\{([a-z][a-z0-9_]*)\}/g;

const PROFILE_KEYS = ['schema', 'profile', 'version', 'console_min', 'kit_source_version', 'modules', 'presets', 'variables'];
const VARIABLE_KEYS = ['type', 'pattern', 'ask', 'why', 'scope', 'default', 'detect', 'optional', 'secret', 'store',
  'value', 'min', 'max', 'measure'];
const MODULE_KEYS = ['schema', 'id', 'order', 'title', 'summary', 'why', 'default', 'locked', 'items'];
const ITEM_KEYS = ['id', 'order', 'title', 'does', 'why', 'risk', 'default', 'platform', 'depends_on', 'pairs_with',
  'conflicts_with', 'contributes', 'detect', 'verify', 'scope', 'notes'];
const CONTRIB_KEYS = {
  file: ['kind', 'target', 'template', 'mode'],
  block: ['kind', 'target', 'block', 'slot', 'template'],
  'json-merge': ['kind', 'target', 'template', 'value', 'mode'],
  env: ['kind', 'name', 'value', 'secret', 'scope'],
  task: ['kind', 'name', 'template'],
  git: ['kind', 'key', 'value', 'scope'],
  kit: ['kind', 'files', 'target'],
  'app-config': ['kind', 'target', 'to', 'format', 'processes'],
};

// Literal machine detail that must never appear in shipped text (a variable is used instead).
const LITERALS = [
  ['path', /\b[A-Za-z]:[\\/]|[\\/]Users[\\/]|\/home\//],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/],
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['artifact url', /claude\.ai\/(?:code\/)?artifact\//],
  ['loopback port', /\b(?:127\.0\.0\.1|localhost):\d{2,5}\b/],
];
const SECRET_LIKE = /sk-ant-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isInt = (v) => Number.isInteger(v);

function literalHits(text) {
  if (typeof text !== 'string') return [];
  return LITERALS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

function varRefs(text) {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(VAR_REF)].map((m) => m[1]);
}

function regexError(src) {
  if (typeof src !== 'string') return 'must be a regex string';
  try { new RegExp(src); return null; } catch (e) { return 'invalid regex'; }
}

function makeSink() {
  const errors = [];
  return { errors, err: (p, msg) => errors.push({ path: p, msg }) };
}

function unknownKeys(obj, allowed, prefix, err) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) err(prefix + k, 'unknown key');
}

function checkVars(text, declared, p, err) {
  if (!declared) return;
  for (const v of varRefs(text)) if (!declared.has(v)) err(p, 'undeclared variable {' + v + '}');
}

// repo:<rel> or user:<rel>; rel is forward-slash, relative, no '..'. Globs only where allowGlob.
function checkTarget(t, declared, p, err, allowGlob) {
  const m = typeof t === 'string' ? /^(repo|user):(.+)$/.exec(t) : null;
  if (!m) return err(p, 'must be repo:<path> or user:<path>');
  const rel = m[2];
  if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '')) {
    return err(p, 'must be a relative forward-slash path without ..');
  }
  if (!allowGlob && rel.includes('*')) return err(p, 'no wildcard in a write target');
  checkVars(rel, declared, p, err);
}

function checkTemplatePath(t, p, err) {
  if (!isStr(t)) return err(p, 'must be a template path');
  if (t.includes('\\') || t.startsWith('/') || /^[A-Za-z]:/.test(t) || t.split('/').some((s) => s === '..' || s === '' || s === '.')) {
    return err(p, 'must be a relative forward-slash path without ..');
  }
  if (!t.startsWith('templates/')) err(p, 'must be under templates/');
}

function declaredSet(variables) {
  if (!isObj(variables)) return null;
  return new Set([...Object.keys(variables), ...BUILTIN_VARIABLES]);
}

// ------------------------------------------------------------------ profile.json

function validateProfile(p) {
  const { errors, err } = makeSink();
  if (!isObj(p)) { err('', 'profile.json must be an object'); return { ok: false, errors }; }
  unknownKeys(p, PROFILE_KEYS, '', err);
  if (p.schema !== 1) err('schema', 'must be 1');
  if (!(isStr(p.profile) && ID.test(p.profile))) err('profile', 'must be a lower-case id');
  if (!(isStr(p.version) && SEMVER.test(p.version))) err('version', 'must be x.y.z');
  if (!(isStr(p.console_min) && SEMVER.test(p.console_min))) err('console_min', 'must be x.y.z');
  if (!(isInt(p.kit_source_version) && p.kit_source_version >= 1)) err('kit_source_version', 'must be an integer >= 1');

  const mods = new Set();
  if (!Array.isArray(p.modules) || p.modules.length === 0) err('modules', 'must be a non-empty array of module ids');
  else p.modules.forEach((m, i) => {
    if (!(isStr(m) && ID.test(m))) err('modules[' + i + ']', 'must be a lower-case id');
    else if (mods.has(m)) err('modules[' + i + ']', 'duplicate module ' + m);
    else mods.add(m);
  });

  if (p.presets !== undefined) {
    if (!isObj(p.presets)) err('presets', 'must be an object');
    else for (const [name, v] of Object.entries(p.presets)) {
      const at = 'presets.' + name;
      if (!ID.test(name)) { err(at, 'preset name must be a lower-case id'); continue; }
      if (v === '*') continue;
      if (!Array.isArray(v)) { err(at, 'must be an array of module ids or "*"'); continue; }
      v.forEach((m, i) => { if (!mods.has(m)) err(at + '[' + i + ']', 'unknown module ' + m); });
    }
  }

  if (!isObj(p.variables)) err('variables', 'must be an object');
  else {
    const declared = declaredSet(p.variables);
    for (const [name, v] of Object.entries(p.variables)) validateVariable(name, v, declared, err);
  }
  return { ok: errors.length === 0, errors };
}

function machineSpecific(s) {
  return typeof s === 'string' && (/\b[A-Za-z]:[\\/]/.test(s) || /[\\/]Users[\\/]/.test(s) || /\/home\//.test(s) ||
    /\b(?:127\.0\.0\.1|localhost):\d{2,5}\b/.test(s) || LITERALS[1][1].test(s));
}

function validateVariable(name, v, declared, err) {
  const at = 'variables.' + name;
  if (!VAR_NAME.test(name)) return err(at, 'name must match ' + VAR_NAME.source);
  if (!isObj(v)) return err(at, 'must be an object');
  unknownKeys(v, VARIABLE_KEYS, at + '.', err);
  if (!VARIABLE_TYPES.includes(v.type)) err(at + '.type', 'must be one of ' + VARIABLE_TYPES.join(', '));
  if (v.pattern !== undefined) { const e = regexError(v.pattern); if (e) err(at + '.pattern', e); }
  for (const k of ['ask', 'why', 'detect', 'measure']) if (v[k] !== undefined && !isStr(v[k])) err(at + '.' + k, 'must be a string');
  for (const k of ['optional', 'secret']) if (v[k] !== undefined && typeof v[k] !== 'boolean') err(at + '.' + k, 'must be true or false');
  if (v.scope !== undefined && !['target', 'user'].includes(v.scope)) err(at + '.scope', 'must be target or user');
  if (v.store !== undefined && !['git-config-local', 'secret-store'].includes(v.store)) err(at + '.store', 'must be git-config-local or secret-store');
  if (v.secret === true && v.default !== undefined && v.default !== null) err(at + '.default', 'a secret has no default');

  if (v.type === 'derived') {
    if (!isStr(v.value)) err(at + '.value', 'a derived variable needs a value template');
    else if (varRefs(v.value).includes(name)) err(at + '.value', 'refers to itself');
    else checkVars(v.value, declared, at + '.value', err);
    if (v.default !== undefined) err(at + '.default', 'a derived variable has no default');
  } else if (v.value !== undefined) err(at + '.value', 'only a derived variable has a value');

  if (v.measure !== undefined && v.default !== undefined && v.default !== null) {
    err(at + '.default', 'a measure variable has no fixed default (it is proposed from the measurement)');
  }

  const d = v.default;
  if (d === undefined || d === null) return;
  if (v.type === 'int') {
    if (!isInt(d)) return err(at + '.default', 'must be an integer');
    if ((isInt(v.min) && d < v.min) || (isInt(v.max) && d > v.max)) err(at + '.default', 'out of range');
    return;
  }
  if (v.type === 'object') { if (!isObj(d)) err(at + '.default', 'must be an object'); return; }
  if (v.type === 'bool') { if (typeof d !== 'boolean') err(at + '.default', 'must be true or false'); return; }
  if (typeof d !== 'string') return err(at + '.default', 'must be a string');
  if (machineSpecific(d)) return err(at + '.default', 'machine-specific default (use a variable or no default)');
  if (v.type === 'relpath' && (d.startsWith('/') || d.includes('\\') || /^[A-Za-z]:/.test(d) || d.split('/').includes('..'))) {
    err(at + '.default', 'relpath must be relative, forward-slash, without ..');
  }
  checkVars(d, declared, at + '.default', err);
}

// ------------------------------------------------------------------ module.json

function checkText(v, p, err, declared) {
  if (!isStr(v)) return err(p, 'must be a non-empty string');
  for (const hit of literalHits(v)) err(p, 'literal ' + hit + ' (use a variable or plain words)');
  checkVars(v, declared, p, err);
}

function validateModule(m, opts) {
  const { errors, err } = makeSink();
  const declared = declaredSet(opts && opts.variables);
  if (!isObj(m)) { err('', 'module.json must be an object'); return { ok: false, errors }; }
  unknownKeys(m, MODULE_KEYS, '', err);
  if (m.schema !== 1) err('schema', 'must be 1');
  if (!(isStr(m.id) && ID.test(m.id))) err('id', 'must be a lower-case id');
  if (!(isInt(m.order) && m.order >= 1 && m.order <= 99)) err('order', 'must be an integer 1..99');
  for (const k of ['title', 'summary', 'why']) checkText(m[k], k, err, declared);
  if (!['on', 'off'].includes(m.default)) err('default', 'must be on or off');
  if (m.locked !== undefined && typeof m.locked !== 'boolean') err('locked', 'must be true or false');
  if (m.locked === true && m.default !== 'on') err('default', 'a locked module is on');
  if (!Array.isArray(m.items) || m.items.length === 0) { err('items', 'must be a non-empty array'); return { ok: false, errors }; }
  if (m.items.length > 99) err('items', 'at most 99 items per module');
  const seen = new Set();
  m.items.forEach((it, i) => validateItem(it, i, m, seen, declared, err));
  return { ok: errors.length === 0, errors };
}

function validateItem(it, i, m, seen, declared, err) {
  const at = 'items[' + i + ']';
  if (!isObj(it)) return err(at, 'must be an object');
  unknownKeys(it, ITEM_KEYS, at + '.', err);
  if (!(isStr(it.id) && ID.test(it.id))) err(at + '.id', 'must be a lower-case id');
  else if (seen.has(it.id)) err(at + '.id', 'duplicate item id ' + it.id);
  else seen.add(it.id);
  if (isInt(m.order)) {
    const want = m.order * 100 + i + 1;
    if (it.order !== want) err(at + '.order', 'must be ' + want + ' (module order x 100 + position)');
  } else if (!isInt(it.order)) err(at + '.order', 'must be an integer');
  for (const k of ['title', 'does', 'why']) checkText(it[k], at + '.' + k, err, declared);
  if (it.notes !== undefined) checkText(it.notes, at + '.notes', err, declared);
  if (!RISKS.includes(it.risk)) err(at + '.risk', 'must be low, medium or high');
  if (!['on', 'off'].includes(it.default)) err(at + '.default', 'must be on or off');
  else if (m.locked === true && it.default !== 'on') err(at + '.default', "a locked module's items are on");
  if (it.scope !== undefined && !ITEM_SCOPES.includes(it.scope)) err(at + '.scope', 'must be one of ' + ITEM_SCOPES.join(', ') + ' (private items never ship)');

  if (!Array.isArray(it.platform) || it.platform.length === 0) err(at + '.platform', 'must be a non-empty array');
  else it.platform.forEach((pl, j) => { if (!PLATFORMS.includes(pl)) err(at + '.platform[' + j + ']', 'must be one of ' + PLATFORMS.join(', ')); });

  const refs = {};
  for (const k of ['depends_on', 'pairs_with', 'conflicts_with']) {
    const v = it[k] === undefined ? [] : it[k];
    if (!Array.isArray(v)) { err(at + '.' + k, 'must be an array of item ids'); refs[k] = []; continue; }
    refs[k] = v;
    v.forEach((r, j) => {
      if (!(isStr(r) && ID.test(r))) err(at + '.' + k + '[' + j + ']', 'must be an item id');
      else if (r === it.id) err(at + '.' + k + '[' + j + ']', 'refers to itself');
    });
  }
  for (const r of refs.depends_on) if (refs.conflicts_with.includes(r)) err(at, r + ' is both a dependency and a conflict');

  if (!Array.isArray(it.contributes)) err(at + '.contributes', 'must be an array');
  else {
    it.contributes.forEach((c, j) => validateContribution(c, at + '.contributes[' + j + ']', declared, err));
    const kinds = it.contributes.filter(isObj).map((c) => c.kind);
    const machine = kinds.includes('env') || kinds.includes('task');
    const ps1 = it.contributes.some((c) => isObj(c) && typeof c.template === 'string' && /\.ps1$/i.test(c.template));
    if (machine && it.risk !== 'high') err(at + '.risk', 'env and task contributions are high risk');
    if ((machine || ps1) && Array.isArray(it.platform) && !(it.platform.length === 1 && it.platform[0] === 'win32')) {
      err(at + '.platform', machine ? 'env and task contributions are win32 only' : '.ps1 templates are win32 only');
    }
  }
  if (it.detect !== undefined) {
    if (!Array.isArray(it.detect)) err(at + '.detect', 'must be an array');
    else it.detect.forEach((d, j) => validateDetect(d, at + '.detect[' + j + ']', declared, err));
  }
  if (it.verify !== undefined) {
    if (!Array.isArray(it.verify)) err(at + '.verify', 'must be an array');
    else it.verify.forEach((v, j) => validateVerify(v, at + '.verify[' + j + ']', declared, err));
  }
}

function validateContribution(c, at, declared, err) {
  if (!isObj(c)) return err(at, 'must be an object');
  if (!CONTRIBUTION_KINDS.includes(c.kind)) return err(at + '.kind', 'unknown kind ' + c.kind + ' (one of ' + CONTRIBUTION_KINDS.join(', ') + ')');
  unknownKeys(c, CONTRIB_KEYS[c.kind], at + '.', err);
  switch (c.kind) {
    case 'file':
      checkTarget(c.target, declared, at + '.target', err);
      checkTemplatePath(c.template, at + '.template', err);
      if (!FILE_MODES.includes(c.mode)) err(at + '.mode', 'must be one of ' + FILE_MODES.join(', '));
      break;
    case 'block':
      checkTarget(c.target, declared, at + '.target', err);
      checkTemplatePath(c.template, at + '.template', err);
      if (!(isStr(c.block) && ID.test(c.block))) err(at + '.block', 'must be a lower-case block id');
      if (c.slot !== undefined && !(isInt(c.slot) && c.slot >= 0)) err(at + '.slot', 'must be an integer >= 0');
      break;
    case 'json-merge':
      checkTarget(c.target, declared, at + '.target', err);
      if (typeof c.target === 'string' && !JSON_MERGE_TARGETS.includes(c.target)) err(at + '.target', 'json-merge targets are ' + JSON_MERGE_TARGETS.join(', '));
      if ((c.template === undefined) === (c.value === undefined)) err(at, 'json-merge needs exactly one of template, value');
      else if (c.template !== undefined) checkTemplatePath(c.template, at + '.template', err);
      else if (!isObj(c.value)) err(at + '.value', 'must be an object');
      if (c.mode !== undefined && !['add', 'replace-ask'].includes(c.mode)) err(at + '.mode', 'must be add or replace-ask');
      break;
    case 'env':
      if (!(isStr(c.name) && /^[A-Z_][A-Z0-9_]*$/.test(c.name))) err(at + '.name', 'must be an upper-case variable name');
      if ((c.value === undefined) === (c.secret === undefined)) err(at, 'env needs exactly one of value, secret');
      else if (c.value !== undefined) {
        if (typeof c.value !== 'string') err(at + '.value', 'must be a string');
        else if (SECRET_LIKE.test(c.value)) err(at + '.value', 'looks like a secret (use secret: <name>, a reference)');
        else checkVars(c.value, declared, at + '.value', err);
      } else if (!(isStr(c.secret) && ID.test(c.secret))) err(at + '.secret', 'must be a secret reference name');
      if (c.scope !== undefined && c.scope !== 'user') err(at + '.scope', 'must be user');
      break;
    case 'task':
      if (!(isStr(c.name) && /^ClaudeProfile-[A-Za-z0-9-]+$/.test(c.name))) err(at + '.name', 'task names start ClaudeProfile-');
      checkTemplatePath(c.template, at + '.template', err);
      break;
    case 'git':
      if (!(isStr(c.key) && /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9-]+)+$/.test(c.key))) err(at + '.key', 'must be section.name');
      if (typeof c.value !== 'string') err(at + '.value', 'must be a string');
      else if (SECRET_LIKE.test(c.value)) err(at + '.value', 'looks like a secret');
      else checkVars(c.value, declared, at + '.value', err);
      if (c.scope !== undefined && c.scope !== 'local') err(at + '.scope', 'must be local (git config --local only)');
      break;
    case 'app-config':
      // Addendum a.3 (INTEGRATE-1): one existing key of a detected app config file; the
      // adapter is installer/profile-appconfig.js. The file is machine-specific (an
      // advisor fills it from the inventory) and may use {variables}.
      if (!isObj(c.target) || !isStr(c.target.file) || !isStr(c.target.key)) err(at + '.target', 'must be {file, key}');
      else { unknownKeys(c.target, ['file', 'key'], at + '.target.', err); checkVars(c.target.file, declared, at + '.target.file', err); }
      if (!['string', 'number', 'boolean'].includes(typeof c.to)) err(at + '.to', 'must be a single string, number or boolean');
      else if (typeof c.to === 'string' && SECRET_LIKE.test(c.to)) err(at + '.to', 'looks like a secret');
      if (c.format !== undefined && !['ini', 'json', 'xml', 'vdf'].includes(c.format)) err(at + '.format', 'must be ini, json, xml or vdf');
      if (c.processes !== undefined && !(Array.isArray(c.processes) && c.processes.every((x) => isStr(x) && /^[A-Za-z0-9 ._-]{1,64}\.exe$/i.test(x)))) err(at + '.processes', 'must be a list of image names (game.exe)');
      break;
    case 'kit':
      if (!Array.isArray(c.files) || c.files.length === 0) err(at + '.files', 'must be a non-empty array of kit file names');
      else c.files.forEach((f, j) => { if (!(isStr(f) && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(f))) err(at + '.files[' + j + ']', 'must be a plain kit file name'); });
      if (c.target !== undefined) checkTarget(c.target, declared, at + '.target', err);
      break;
  }
}

function validateDetect(d, at, declared, err) {
  if (!isObj(d)) return err(at, 'must be an object');
  const kinds = Object.keys(d).filter((k) => DETECT_KINDS.includes(k));
  if (kinds.length !== 1) return err(at, 'exactly one detect kind (' + DETECT_KINDS.join(', ') + ')');
  const k = kinds[0];
  const extra = { file: [], text: ['regex'], json: ['key'], env: [], git: [] }[k];
  unknownKeys(d, [k, ...extra], at + '.', err);
  if (k === 'env') { if (!(isStr(d.env) && /^[A-Z_][A-Z0-9_]*$/.test(d.env))) err(at + '.env', 'must be a variable name'); return; }
  if (k === 'git') { if (!isStr(d.git)) err(at + '.git', 'must be a git config key'); return; }
  checkTarget(d[k], declared, at + '.' + k, err, true);
  if (k === 'text') {
    if (d.regex === undefined) return err(at, 'text needs regex');
    const e = regexError(d.regex); if (e) err(at + '.regex', e);
  }
  if (k === 'json' && !isStr(d.key)) err(at, 'json needs key');
}

function validateVerify(v, at, declared, err) {
  if (!isObj(v)) return err(at, 'must be an object');
  const kinds = Object.keys(v).filter((k) => VERIFY_KINDS.includes(k));
  if (kinds.length !== 1) return err(at, 'exactly one verify kind (' + VERIFY_KINDS.join(', ') + ')');
  const k = kinds[0];
  unknownKeys(v, k === 'regex' ? ['regex', 'line1', 'match'] : [k], at + '.', err);
  if (k === 'env-readback') { if (!(isStr(v[k]) && /^[A-Z_][A-Z0-9_]*$/.test(v[k]))) err(at + '.' + k, 'must be a variable name'); return; }
  if (k === 'task-readback') { if (!(isStr(v[k]) && /^ClaudeProfile-[A-Za-z0-9-]+$/.test(v[k]))) err(at + '.' + k, 'must be a ClaudeProfile- task name'); return; }
  if (k === 'budget') { if (!isStr(v[k])) err(at + '.' + k, 'must name a budget'); return; }
  checkTarget(v[k], declared, at + '.' + k, err, k === 'json-parse');
  if (k === 'regex') {
    const keys = ['line1', 'match'].filter((x) => v[x] !== undefined);
    if (keys.length !== 1) return err(at, 'regex needs exactly one of line1, match');
    const e = regexError(v[keys[0]]); if (e) err(at + '.' + keys[0], e);
  }
}

// ------------------------------------------------------------------ whole directory

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { missing: true }; }
  try { return { value: JSON.parse(text) }; } catch (e) { return { bad: true }; }
}

function checkTemplateFile(file, rel, declared, err) {
  let b;
  try { b = fs.readFileSync(file); } catch (e) { return false; }
  if (b.includes(13)) err(rel, 'CR byte (LF only)');
  const lines = b.toString('latin1').split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    if (/[^\x09\x20-\x7e\r]/.test(line)) err(rel, 'non-ASCII byte at line ' + n);
    for (const v of varRefs(line)) if (declared && !declared.has(v)) err(rel, 'undeclared variable {' + v + '} at line ' + n);
    for (const hit of literalHits(line)) err(rel, 'literal ' + hit + ' at line ' + n);
  });
  return true;
}

function validateProfileDir(dir) {
  const { errors, err } = makeSink();
  const out = { ok: false, errors, profile: null, modules: [] };
  const pj = readJsonFile(path.join(dir, 'profile.json'));
  if (pj.missing) { err('profile.json', 'missing'); return out; }
  if (pj.bad) { err('profile.json', 'unreadable JSON'); return out; }
  const p = pj.value;
  out.profile = p;
  for (const e of validateProfile(p).errors) err('profile.json' + (e.path ? '.' + e.path : ''), e.msg);
  const variables = isObj(p) && isObj(p.variables) ? p.variables : {};
  const declared = declaredSet(variables);
  const listed = isObj(p) && Array.isArray(p.modules) ? p.modules.filter((m) => isStr(m) && ID.test(m)) : [];

  let present = [];
  try { present = fs.readdirSync(path.join(dir, 'modules'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { /* none */ }
  for (const name of present) if (!listed.includes(name)) err('modules/' + name, 'not listed in profile.json modules');

  const owner = new Map(); // item id -> {module, at, item}
  listed.forEach((id, idx) => {
    const rel = 'modules/' + id + '/module.json';
    const mj = readJsonFile(path.join(dir, 'modules', id, 'module.json'));
    if (mj.missing) return err(rel, 'missing');
    if (mj.bad) return err(rel, 'unreadable JSON');
    const m = mj.value;
    for (const e of validateModule(m, { variables }).errors) err(rel + (e.path ? '.' + e.path : ''), e.msg);
    if (!isObj(m)) return;
    out.modules.push(m);
    if (m.id !== id) err(rel + '.id', 'must equal the directory name ' + id);
    if (m.order !== idx + 1) err(rel + '.order', 'must be ' + (idx + 1) + ' (position in profile.json modules)');
    if (!Array.isArray(m.items)) return;
    m.items.forEach((it, i) => {
      if (!isObj(it)) return;
      const at = rel + '.items[' + i + ']';
      if (isStr(it.id)) {
        const prev = owner.get(it.id);
        if (prev && prev.module !== id) err(at + '.id', 'duplicate item id ' + it.id + ' (also in ' + prev.module + ')');
        else if (!prev) owner.set(it.id, { module: id, at, item: it });
      }
      if (!Array.isArray(it.contributes)) return;
      it.contributes.forEach((c, j) => {
        if (!isObj(c) || !isStr(c.template)) return;
        const parts = c.template.split('/');
        if (parts.some((s) => s === '..' || s === '') || c.template.includes('\\')) return;
        const f = path.join(dir, 'modules', id, ...parts);
        if (!checkTemplateFile(f, 'modules/' + id + '/' + c.template, declared, err)) {
          err(at + '.contributes[' + j + '].template', 'missing file ' + c.template);
        }
      });
    });
  });

  // Cross-module references.
  const list = (it, k) => (Array.isArray(it[k]) ? it[k] : []);
  for (const [id, o] of owner) {
    for (const k of ['depends_on', 'pairs_with', 'conflicts_with']) {
      list(o.item, k).forEach((r, j) => { if (isStr(r) && r !== id && !owner.has(r)) err(o.at + '.' + k + '[' + j + ']', 'unknown item ' + r); });
    }
    list(o.item, 'conflicts_with').forEach((r, j) => {
      const other = owner.get(r);
      if (other && !list(other.item, 'conflicts_with').includes(id)) {
        err(o.at + '.conflicts_with[' + j + ']', 'conflict must be symmetric (' + r + ' does not list ' + id + ')');
      }
    });
  }
  // Dependency cycles, reported once each, starting from the first item in order.
  const state = new Map();
  const reported = new Set();
  const visit = (id, stack) => {
    state.set(id, 1);
    stack.push(id);
    for (const r of list(owner.get(id).item, 'depends_on')) {
      if (!owner.has(r)) continue;
      if (state.get(r) === 1) {
        const cyc = stack.slice(stack.indexOf(r)).concat(r);
        const key = [...new Set(cyc)].sort().join(',');
        if (!reported.has(key)) { reported.add(key); err(owner.get(cyc[0]).at + '.depends_on', 'dependency cycle ' + cyc.join(' -> ')); }
      } else if (!state.get(r)) visit(r, stack);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of owner.keys()) if (!state.get(id)) visit(id, []);

  out.ok = errors.length === 0;
  return out;
}

module.exports = {
  CONTRIBUTION_KINDS, VARIABLE_TYPES, VERIFY_KINDS, DETECT_KINDS, PLATFORMS, RISKS, FILE_MODES,
  JSON_MERGE_TARGETS, BUILTIN_VARIABLES,
  validateProfile, validateModule, validateProfileDir, literalHits, varRefs,
};
