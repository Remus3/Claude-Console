'use strict';
// CON-013 INTEGRATE-2 (c): the adopt screens' routes on the real L3x facade
// (installer/profile-adopt.js openAdopt({engine, dataDir, deps})). Mounted in server.js
// ahead of the profile routes, so /api/profile/adopt is served here.
//
//   GET  /api/profile/adopt   {available}
//   POST /api/profile/adopt   {op, ...} where op is one of the facade steps:
//     start          {project|repo, exclude?}       copy + scan -> {adoption, report}
//     list           {}                             -> {adoptions}
//     load | report  {id}                           -> {adoption, report}
//     choose         {id, accept[], acks[], breakConfirmed?} -> {ids, skipped, added}
//     apply          {id, confirm}                  dry run unless confirm
//     setChecks      {id, edits[], confirm?}        -> {checks}
//     check          {id}                           -> {result: {hash, verdict, rows, bisect}}
//     revert         {id, change|module|all, confirm}
//     works          {id, word}                     the typed word "works"
//     promote        {id, method, confirm}
//     removeOriginal {id, method, phrase, confirm}  a later run only (run id per server start)
// Every answer carries {ok, code, line}. The original is read-only to the engine until
// promote (invariant I1); nothing here writes outside the adoption folder.
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../installer/profile');
const TX = require('../installer/profile-tx');

const OPS = ['start', 'list', 'load', 'report', 'choose', 'apply', 'setChecks', 'check', 'revert', 'works', 'promote', 'removeOriginal'];
const ALIAS = { 'remove-original': 'removeOriginal', checks: 'setChecks', status: 'load' };
const ADOPT_ID = /^[a-z0-9][a-z0-9._-]{0,60}-\d{8}-\d{6}(-\d{1,3})?$/;
// Change ids are '<item>@<file>' with the file's own name (spaces, parens allowed).
const SPEC = /^[A-Za-z0-9:@._ ()\/-]{1,240}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strs = (v, re) => (Array.isArray(v) ? v.map(String).filter((x) => re.test(x)).slice(0, 500) : []);

// What the UI sees of an adoption: no absolute paths.
function pubAdoption(api, ad) {
  if (!ad) return null;
  return {
    id: ad.id, project: path.basename(ad.original), status: api.status(ad), created: ad.created, method: ad.method,
    accepted: (ad.accepted || []).slice(), acks: (ad.acks || []).slice(), applied: !!ad.applied,
    checks: ad.checks ? { confirmed: !!ad.checks.confirmed, list: (ad.checks.list || []).map((c) => ({ id: c.id, kind: c.kind, cmd: c.cmd, source: c.source })) } : null,
    lastCheck: ad.lastCheck ? { hash: ad.lastCheck.hash, verdict: ad.lastCheck.verdict, at: ad.lastCheck.at } : null,
    promoted: ad.promote ? ad.promote.method || true : null, removed: ad.removed ? ad.removed.method || true : null,
  };
}

function createAdoptRoutes(o) {
  o = o || {};
  const send = o.send;
  const readBody = o.readBody;
  const isLoopback = o.isLoopback || (() => true);
  const log = typeof o.log === 'function' ? o.log : () => {};
  const pr = o.profile || {};
  const real = pr.real === true;
  const profileDir = pr.profileDir || path.join(__dirname, '..', 'profile');
  const dataDir = pr.dataDir || path.join(os.homedir(), '.claude-console-data');
  const deps = Object.assign({}, pr.deps || {});
  const openEngine = pr.openEngine || P.openEngine;
  const projects = typeof pr.projects === 'function' ? pr.projects : () => [];
  const runId = pr.runId || ('srv-' + process.pid + '-' + Date.now());
  let api = null;
  let busy = null;

  function mod() {
    if (pr.adopt !== undefined) return pr.adopt && typeof pr.adopt.openAdopt === 'function' ? pr.adopt : null;
    try { const m = require('../installer/profile-adopt'); return typeof m.openAdopt === 'function' ? m : null; } catch (e) { return null; }
  }
  function adopter() {
    if (api) return api;
    const A = mod();
    if (!A || !fs.existsSync(path.join(profileDir, 'profile.json'))) return null;
    const engine = openEngine({ profileDir, dataDir, configDir: pr.configDir || null, deps, platform: pr.platform, ctx: { detect: pr.detect, home: pr.home, documents: pr.documents, dataDir } });
    if (!engine.model.ok) return null;
    const recycle = deps.recycle || (real ? TX.defaultRecycle(dataDir) : undefined);
    api = A.openAdopt({ engine, dataDir, deps: Object.assign({}, deps, { recycle, detect: pr.detect }, pr.adoptDeps || {}), platform: pr.platform });
    return api;
  }
  function projectDir(body) {
    if (body.project) { const pj = projects().find((x) => x.id === String(body.project)); return pj ? pj.dir : null; }
    if (typeof body.repo === 'string' && path.isAbsolute(body.repo)) return body.repo;
    return null;
  }
  const refused = (line) => ({ ok: false, code: 1, line: 'refused: ' + line });

  async function step(A, op, body) {
    if (op === 'list') return { ok: true, code: 0, adoptions: A.list(), line: A.list().length + ' adoption(s)' };
    if (op === 'start') {
      const dir = projectDir(body);
      if (!dir) return refused('pick a project to adopt');
      const r = await A.start(dir, { exclude: strs(body.exclude, /^[A-Za-z0-9._ -]{1,120}$/), values: isObj(body.values) ? body.values : undefined });
      return { ok: r.ok, code: r.code, line: r.line, adoption: r.ok ? pubAdoption(A, r.adoption) : null, report: r.ok ? r.report : null };
    }
    const id = String(body.id || '');
    if (!ADOPT_ID.test(id) && id !== 'last') return refused('name the adoption (start one first)');
    const ad = A.load(id);
    if (!ad) return refused('no adoption ' + id);
    const confirm = body.confirm === true;
    switch (op) {
      case 'load':
      case 'report': return { ok: true, code: 0, line: 'adoption ' + ad.id + ': ' + A.status(ad), adoption: pubAdoption(A, ad), report: A.report(ad) };
      case 'choose': {
        const r = A.choose(ad, { accept: strs(body.accept, SPEC), acks: strs(body.acks, SPEC), breakConfirmed: body.breakConfirmed === true });
        return { ok: r.ok, code: r.code, line: r.line, ids: r.ids, skipped: r.skipped, added: r.added, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      case 'apply': {
        const r = await A.apply(ad, { confirm });
        return { ok: r.ok, code: r.code, line: r.line, dryRun: !!r.dryRun, problems: r.problems || [], diff: r.ok && !r.dryRun ? A.diffStat(A.load(ad.id)) : null, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      case 'setChecks': {
        const r = A.setChecks(ad, { edits: Array.isArray(body.edits) ? body.edits.map(String).slice(0, 20) : [], confirm });
        return { ok: r.ok, code: r.code, line: r.line, checks: pubAdoption(A, A.load(ad.id)).checks };
      }
      case 'check': {
        const r = await A.check(ad, { bisect: body.bisect !== false });
        return { ok: r.ok, code: r.code, line: r.line, result: r.result || null, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      case 'revert': {
        const r = await A.revert(ad, { change: typeof body.change === 'string' && SPEC.test(body.change) ? body.change : null, module: typeof body.module === 'string' && SPEC.test(body.module) ? body.module : null, all: body.all === true, confirm });
        return { ok: r.ok, code: r.code, line: r.line, dryRun: !!r.dryRun, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      case 'works': {
        const r = A.works(ad, { word: typeof body.word === 'string' ? body.word : null });
        return { ok: r.ok, code: r.code, line: r.line, confirm: r.confirm || null, diff: r.ok ? A.diffStat(ad) : null };
      }
      case 'promote': {
        const r = await A.promote(ad, { method: typeof body.method === 'string' ? body.method : 'swap', confirm, runId });
        return { ok: r.ok, code: r.code, line: r.line, dryRun: !!r.dryRun, recheck: r.recheck || null, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      case 'removeOriginal': {
        const hours = body.minAgeHours;
        const r = await A.removeOriginal(ad, { method: typeof body.method === 'string' ? body.method : 'recycle', phrase: typeof body.phrase === 'string' ? body.phrase : null, runId, confirm,
          minAgeHours: typeof hours === 'number' && hours >= 0 && !real ? hours : undefined });
        return { ok: r.ok, code: r.code, line: r.line, dryRun: !!r.dryRun, adoption: pubAdoption(A, A.load(ad.id)) };
      }
      default: return refused('unknown adopt step');
    }
  }

  return async function adoptRoutes(req, res, p, m) {
    if (p !== '/api/profile/adopt') return false;
    if (m !== 'GET' && m !== 'POST') { send(res, 405, { error: 'GET or POST' }); return true; }
    if (m === 'GET') { send(res, 200, { available: !!adopter() }); return true; }
    if (!isLoopback(req)) { send(res, 403, { error: 'localhost only' }); return true; }
    try {
      const body = await readBody(req, 262144);
      const A = adopter();
      if (!A) { send(res, 501, { error: 'adopt is not in this build' }); return true; }
      const op = ALIAS[String(body.op || '')] || String(body.op || '');
      if (!OPS.includes(op)) { send(res, 400, { error: 'unknown adopt step' }); return true; }
      const long = ['start', 'apply', 'check', 'revert', 'promote', 'removeOriginal'].includes(op);
      if (long && busy) { send(res, 409, { error: 'an adopt step is already running (' + busy + ')' }); return true; }
      if (long) busy = op;
      try {
        const r = await step(A, op, body);
        log('adopt ' + op + ': ' + r.line);
        send(res, 200, r);
      } finally { if (long) busy = null; }
    } catch (e) {
      log('adopt route failed: ' + e.message);
      send(res, e.status || 500, { error: e.message });
    }
    return true;
  };
}

module.exports = { createAdoptRoutes, pubAdoption, OPS };
