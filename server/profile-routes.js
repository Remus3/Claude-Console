'use strict';
// CON-013 L5: the setup profile's server routes (design d.5, addendum b / e / f), mounted
// by ONE dispatch line in server.js after its token + Host/Origin checks. The server
// calls the installer modules in-process (never the CLI). Every write route is
// loopback-only; one apply at a time (busy = 409); apply needs a plan id from a dry run
// of the same inputs (the plan is re-made and must match, else 409); no route ever
// returns a secret value or a machine value (env values, task XML, git values).
//
//   GET  /api/profile                       browse state: modules, items, status line, review step, capabilities
//   GET  /api/profile/item?id=              one item + its templates (view / edit pane) + the variables list
//   POST /api/profile/toggle                {id, on, confirm?} item or module; dependencies ask first
//   POST /api/profile/check                 {text} live template validation
//   POST /api/profile/edit                  {id, template?, text | reset} override only
//   POST /api/profile/plan                  {target, draft?, values?, only?} dry run -> planId, rows, diff
//   POST /api/profile/apply                 {planId, confirm, acks?, groupedConsent?}
//   GET  /api/profile/tx                    transactions
//   POST /api/profile/revert                {tx, confirm?} dry run unless confirm
//   POST /api/profile/wizard                {op: preset|custom|back|skip|inputs, ...} pure helpers, nothing saved
//   POST /api/profile/secret                {name, value} DPAPI store; answers the masked state only
//   GET  /api/profile/update                update offer (preset diff / merge / new-items count)
//   POST /api/profile/update/take           {confirm} the offer's selection (then plan + apply as usual)
//   (/api/profile/adopt is served by server/adopt-routes.js on the openAdopt facade)
//   POST /api/profile/crash                 {step?} the exact scrubbed report (preview)
//   POST /api/profile/crash/action          {id, action: issue|claude|save, confirm}
//   POST /api/recover/stop | resume         {confirm?} dry run line unless confirm
//   POST /api/recover/prompt                the recovery prompt text (preview)
//   POST /api/recover/prompt/go             {confirm} copy it and open claude.ai
//   GET  /api/machine                       machine-profile data present + last advice
//   GET  /api/machine/data                  spec + inventory (View)
//   POST /api/machine/advise | preview | apply | revert | delete
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('../installer/profile');
const TX = require('../installer/profile-tx');
const CR = require('../installer/crashreport');
const REC = require('../installer/recover');

const ISSUE_REPO = 'Remus3/Claude-Console';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const defaultLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ''));
function defaultSend(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
function defaultReadBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 262144)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const REVIEW_FALLBACK = {
  title: 'Before you enable anything',
  lead: "Before you enable modules, read what each one does and review the .md files it adds. You're in control and can turn anything off later.",
  licence: "The console and its setup are provided as-is under the Apache-2.0 licence. The author isn't liable for what they do on your machine.",
  safeguards_heading: 'Already in place',
  safeguards: [
    { glyph: '[+]', word: 'Dry run', text: 'Nothing is written until the final Apply step; every change is shown first.' },
    { glyph: '[+]', word: 'Copy first', text: 'Adopting an existing project works on a copy; your original stays untouched until you promote it.' },
    { glyph: '[+]', word: 'Your choice', text: 'Every module and every change has its own yes or no.' },
    { glyph: '[+]', word: 'Backups', text: 'Each apply saves what it replaces, and revert puts it back byte for byte.' },
    { glyph: '[+]', word: 'Recycle Bin', text: 'Files the profile created go to the Recycle Bin when removed, never straight to deletion.' },
    { glyph: '[+]', word: 'No telemetry', text: 'Nothing about you or your work is sent anywhere.' },
    { glyph: '[+]', word: 'Stop', text: "Stop everything halts the console's processes, profile tasks and hooks (small scripts Claude runs before or after its actions) in one step." },
  ],
  checkbox: "I've read this and I'm choosing what to enable",
  ask_again: 'major',
};

function refuse(what) { return async () => { throw new Error(what + ' is disabled on a test server'); }; }

// o: {send, readBody, isLoopback, log, profile: {profileDir, dataDir, runDir, configDir, deps,
//     secrets, adopt, machine, openEngine, detect, platform, real, openUrl, clipboard, documents,
//     procInfo, killTree, username, hostname, home, token, projects(), version, channel, updateDir}}
function createProfileRoutes(o) {
  o = o || {};
  const send = o.send || defaultSend;
  const readBody = o.readBody || defaultReadBody;
  const isLoopback = o.isLoopback || defaultLoopback;
  const log = typeof o.log === 'function' ? o.log : () => {};
  const pr = o.profile || {};
  const real = pr.real === true;
  const profileDir = pr.profileDir || path.join(__dirname, '..', 'profile');
  const dataDir = pr.dataDir || path.join(os.homedir(), '.claude-console-data');
  const runDir = pr.runDir || path.join(dataDir, 'run');
  const configDir = pr.configDir || null;
  // FB-1021: the other configured accounts' own config dirs {id: {dir, label}}.
  const accountDirs = () => { try { const a = typeof pr.accountDirs === 'function' ? pr.accountDirs() : pr.accountDirs; return isObj(a) ? a : {}; } catch (e) { return {}; } };
  const deps = Object.assign({}, pr.deps || {});
  const openEngine = pr.openEngine || P.openEngine;
  const projects = typeof pr.projects === 'function' ? pr.projects : () => [];
  const openUrl = pr.openUrl || (real ? CR.openUrlDefault : refuse('opening the browser'));
  const clipboard = pr.clipboard || (real ? CR.clipboardDefault : refuse('the clipboard'));
  const secrets = pr.secrets !== undefined ? pr.secrets : (real ? (() => { try { return require('../installer/profile-secrets').createSecretStore({ dataDir }); } catch (e) { return null; } })() : null);
  const plans = new Map();
  const reports = new Map();
  const advice = new Map();
  let busy = null;

  let engCache = null;
  function engine() {
    if (!fs.existsSync(path.join(profileDir, 'profile.json'))) return null;
    if (!engCache) engCache = openEngine({ profileDir, dataDir, configDir, deps, platform: pr.platform, ctx: { detect: pr.detect, home: pr.home, documents: pr.documents, dataDir } });
    return engCache;
  }

  // ---- adopt capability (L3x): on when profile-adopt exports the openAdopt facade. The
  // routes themselves live in server/adopt-routes.js (mounted ahead of these).
  function adoptModule() {
    if (pr.adopt !== undefined) return pr.adopt && typeof pr.adopt.openAdopt === 'function' ? pr.adopt : null;
    try { const m = require('../installer/profile-adopt'); return typeof m.openAdopt === 'function' ? m : null; } catch (e) { return null; }
  }

  // ---- machine profile (L9)
  function machineMod() {
    if (pr.machine) return pr.machine;
    const MA = require('../installer/machine-advisors');
    const MS = require('../installer/machine-scan');
    return {
      advise: (ctx) => MA.advise(Object.assign({ spec: MS.loadSpec(dataDir), inventory: MS.readMachineJson(dataDir, 'inventory.json'), env: process.env }, ctx || {})),
      save: real ? (adv) => MA.saveAdvice(dataDir, adv) : () => null,
      preview: (adv) => MA.preview(adv),
      apply: real ? (d, adv, a) => MA.applyAdvice(d, adv, a) : refuse('applying machine changes'),
      revert: real ? (txDir, a) => MA.revertAdvice(txDir, a) : refuse('reverting machine changes'),
      deleteData: real ? () => MS.deleteMachineData(dataDir) : refuse('deleting machine data'),
      readData: () => ({ spec: MS.readMachineJson(dataDir, 'spec.json'), inventory: MS.readMachineJson(dataDir, 'inventory.json') }),
    };
  }

  // ---------------------------------------------------------------- views

  function reviewStep() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(path.join(profileDir, 'review-step.json'), 'utf8')); } catch (e) { j = null; }
    const r = Object.assign({}, REVIEW_FALLBACK, isObj(j) ? j : {});
    return { title: r.title, lead: r.lead, licence: r.licence, safeguards_heading: r.safeguards_heading, safeguards: Array.isArray(r.safeguards) ? r.safeguards : REVIEW_FALLBACK.safeguards, checkbox: r.checkbox, ask_again: r.ask_again };
  }

  function pubContribution(c) {
    const out = { kind: c.kind };
    for (const k of ['target', 'template', 'mode', 'block', 'name', 'key']) if (typeof c[k] === 'string') out[k] = c[k];
    if (c.kind === 'env' && c.secret) out.secret = c.secret;
    if (c.kind === 'app-config' && isObj(c.target)) out.target = c.target.file;
    return out;
  }

  function pubItem(v) {
    return {
      id: v.id, order: v.order, module: v.module, title: v.title, does: v.does, why: v.why, risk: v.risk, default: v.default,
      locked: v.locked, platform: v.platform, scope: v.scope, windowsOnly: Array.isArray(v.platform) && v.platform.length === 1 && v.platform[0] === 'win32',
      depends_on: v.depends_on, pairs_with: v.pairs_with, conflicts_with: v.conflicts_with, state: v.state, state_why: v.state_why,
      contributes: (v.contributes || []).map(pubContribution),
    };
  }

  function varsPublic(eng, sel) {
    const decl = (eng.model.profile && eng.model.profile.variables) || {};
    return Object.entries(decl).filter(([, d]) => d.type !== 'derived').map(([name, d]) => ({
      name, type: d.type, why: d.why || null, ask: d.ask || null, optional: d.optional === true, pattern: d.pattern || null,
      secret: d.secret === true, value: d.secret === true ? null : (sel && sel.variables && sel.variables[name] !== undefined ? sel.variables[name] : null),
    }));
  }

  function statusLine(eng, st) {
    const last = st.lastTx && st.lastTx.at ? ' - last applied ' + String(st.lastTx.at).slice(0, 10) : ' - never applied';
    return 'profile ' + (st.profile || '?') + ' - ' + st.on + ' of ' + st.total + ' items on' + last;
  }

  function state() {
    const eng = engine();
    if (!eng) return { available: false, reason: 'no setup profile in this build' };
    if (!eng.model.ok) return { available: false, reason: 'the setup profile does not validate (' + eng.model.errors.length + ' error(s))' };
    const sel = eng.selection();
    const list = eng.list(sel);
    const st = eng.status();
    return {
      available: true,
      profile: { name: eng.model.profile.profile, version: eng.model.profile.version },
      modules: list.map((m) => {
        const mod = eng.model.modules.find((x) => x.id === m.id) || {};
        return { id: m.id, order: m.order, title: m.title, summary: m.summary, why: mod.why || null, default: mod.default, locked: m.locked, on: m.on, total: m.total, items: m.items.map(pubItem) };
      }),
      presets: Object.keys(eng.model.presets),
      presetTitles: Object.fromEntries(Object.entries(eng.model.presets).map(([k, v]) => [k, (v && typeof v.title === 'string' && v.title) || k.charAt(0).toUpperCase() + k.slice(1)])),
      variables: varsPublic(eng, sel),
      selection: { path: sel.path || null, preset: sel.preset || null, review_ack: sel.review_ack || null, needs_off: sel.needs_off || [] },
      status: { line: statusLine(eng, st), on: st.on, total: st.total, pending: st.pending.length, pendingIds: st.pending, lastTx: st.lastTx, drift: st.drift.length },
      firstRun: !fs.existsSync(P.selectionFile(dataDir)),
      offer: offerKind(eng),
      review: reviewStep(),
      capabilities: { adopt: !!adoptModule(), machine: true, crash: true, recover: true },
      // other accounts the wizard also applies user-scope settings to (labels only, no dirs)
      accounts: Object.entries(accountDirs()).map(([id, a]) => ({ id, label: (a && a.label) || id })),
    };
  }

  // FB-1021: why a preset leaves an item off, in words, from the generator's rule.
  const RULE_WHY = {
    'author-off': 'the author does not run it',
    'fleet-below-4': 'the author runs it in only a few of their projects',
  };
  function presetOff(model, name) {
    const pre = model.presets[name];
    if (!pre || !pre.items) return [];
    const out = [];
    for (const id of model.order) {
      if (pre.items[id] !== 'off') continue;
      const e = model.items.get(id);
      if (!e || e.module.locked) continue;
      out.push({ item: id, title: e.item.title, why: RULE_WHY[(pre.rules || {})[id]] || 'off in this preset' });
    }
    return out;
  }

  const titled = (eng, ids) => ids.map((id) => { const e = eng.model.items.get(id); return { id, title: e ? e.item.title : id }; });

  // ---------------------------------------------------------------- targets / plans

  function resolveTarget(t) {
    t = isObj(t) ? t : {};
    if (t.account !== undefined) {
      const a = accountDirs()[String(t.account)];
      if (!a || !a.dir) return { error: 'unknown account' };
      return { repo: null, configDir: a.dir, configFilesOnly: true };
    }
    if (t.project) {
      const pj = projects().find((x) => x.id === String(t.project));
      if (!pj) return { error: 'unknown project' };
      return { repo: pj.dir, configDir };
    }
    if (typeof t.repo === 'string' && t.repo) {
      const abs = path.resolve(t.repo);
      let st = null;
      try { st = fs.statSync(abs); } catch (e) { st = null; }
      if (!st || !st.isDirectory()) return { error: 'no such folder' };
      return { repo: abs, configDir };
    }
    return { repo: null, configDir };
  }

  // Scheduled-task consent as profile-tx takes it: {mode:'grouped', yes, listed[]} (path A)
  // or {mode:'per-task', tasks:{name:true}} (path B). Anything else is no consent.
  function taskConsentOf(c) {
    if (!isObj(c)) return null;
    if (c.mode === 'grouped') return { mode: 'grouped', yes: c.yes === true, listed: Array.isArray(c.listed) ? c.listed.map(String) : [] };
    if (c.mode === 'per-task' && isObj(c.tasks)) {
      const t = {};
      for (const k of Object.keys(c.tasks)) if (k !== '*' && c.tasks[k] === true) t[k] = true;
      return { mode: 'per-task', tasks: t };
    }
    return null;
  }

  function makePlan(eng, inp) {
    const sel = inp.draft ? P.normaliseSelection(JSON.parse(JSON.stringify(inp.draft)), eng.model) : eng.selection();
    const p = eng.plan({ target: inp.target, selection: sel, values: inp.values || {}, only: inp.only, configFilesOnly: !!(inp.target && inp.target.configFilesOnly) });
    const rows = p.rows.map((r) => ({ item: r.item, kind: r.kind, target: r.target, status: r.status, reason: r.reason || null }));
    const diff = eng.diff(p);
    const digest = sha(JSON.stringify({ rows, diff, counts: p.counts, hr: p.highRisk, ack: p.needsAck })).slice(0, 16);
    return {
      p, sel, digest,
      pub: {
        planId: digest, rows, counts: p.counts, diff, lines: eng.planLines(p), verdict: eng.verdict(p),
        highRisk: titled(eng, p.highRisk), needsAck: p.needsAck, depsAdded: titled(eng, p.depsAdded),
        tasks: (typeof TX.tasksNeedingConsent === 'function' ? TX.tasksNeedingConsent(p) : []),
        missing: p.missing.map((m) => ({ name: m.name, items: m.items, ask: m.ask || null })),
        varErrors: p.varErrors.map((e) => ({ name: e.name, msg: e.msg })),
        conflicts: p.conflictsPairs,
        machine: p.machine.map((m) => ({ kind: m.kind, item: m.item, name: m.name || null, key: m.key || null, op: m.op, status: m.status })),
        target: { repo: p.target.repo ? path.basename(p.target.repo) : null, user: !p.target.repo },
        empty: !p.rows.some((r) => ['new', 'differs', 'removed', 'conflict'].includes(r.status)),
      },
    };
  }

  // ---------------------------------------------------------------- wizard helpers

  // Same rule as presetSelection's skipped inputs, for any (path B) selection.
  function applySkips(eng, sel, skipped) {
    const PU = require('../installer/profile-update');
    const model = eng.model;
    sel = P.normaliseSelection(JSON.parse(JSON.stringify(sel || {})), model);
    const skip = new Set(skipped || []);
    const offNeeds = [];
    if (!skip.size) return { selection: sel, offNeeds };
    const on = P.onIds(model, sel);
    // An item needs an input when a variable / secret it renders was skipped, or when
    // the user said no to its env variable (env:NAME) or its scheduled task (task:NAME).
    const needsOf = (id) => {
      const out = PU.inputsOf(model, id).filter((n) => skip.has(n));
      for (const c of model.items.get(id).item.contributes || []) {
        if (c.kind === 'env' && skip.has('env:' + c.name)) out.push('env:' + c.name);
        if (c.kind === 'task' && skip.has('task:' + c.name)) out.push('task:' + c.name);
      }
      return out;
    };
    const direct = on.filter((id) => !model.items.get(id).module.locked && needsOf(id).length);
    const all = direct.concat(P.dependants(model, direct).filter((id) => on.includes(id) && !direct.includes(id)));
    for (const id of all) {
      if (model.items.get(id).module.locked) continue;
      sel.items[id] = 'off';
      const needs = needsOf(id);
      offNeeds.push({ item: id, title: model.items.get(id).item.title, needs: needs.length ? needs : ['(depends on ' + direct.filter((d) => P.dependencyClosure(model, [id]).includes(d)).join(', ') + ')'] });
    }
    sel.needs_off = [...new Set((sel.needs_off || []).concat(offNeeds.map((x) => x.item)))];
    return { selection: sel, offNeeds };
  }

  function taskSummary(eng, mod, c, vars) {
    let xml = '';
    try { xml = P.renderText(P.readTemplate(eng.model, mod, c.template, dataDir).text, vars).text; } catch (e) { xml = ''; }
    let sum = null;
    try { sum = require('../installer/profile-tasks').summarize(xml); } catch (e) { sum = null; }
    const trig = sum && sum.triggers.length ? sum.triggers.map((t) => t.kind + (t.at ? ' at ' + t.at : '') + (t.everyMinutes ? ', every ' + t.everyMinutes + ' min' : '')).join('; ') : null;
    // deletes: the task card's own "what it may delete and how" text (UX-F19)
    return { trigger: trig, limitMinutes: sum ? sum.limitMinutes : null, hidden: sum ? sum.hidden : null, deletes: typeof c.deletes === 'string' && c.deletes.trim() ? c.deletes.trim() : null };
  }

  // What the on items of a selection need from the user.
  function inputs(eng, sel) {
    const PU = require('../installer/profile-update');
    let ENV = null;
    try { ENV = require('../installer/profile-env'); } catch (e) { ENV = null; }
    const model = eng.model;
    sel = P.normaliseSelection(sel || {}, model);
    const on = P.onIds(model, sel);
    const decl = (model.profile && model.profile.variables) || {};
    const vr = P.resolveVariables(model, sel.variables, { detect: pr.detect, dataDir, configDir });
    const env = new Map();
    const sec = new Map();
    const vars = new Map();
    const tasks = new Map();
    for (const id of on) {
      const { item, module: m } = model.items.get(id);
      for (const c of item.contributes || []) {
        if (c.kind === 'env') {
          const e = env.get(c.name) || { name: c.name, items: [], secret: c.secret || null, proposed: null };
          e.items.push(id);
          if (c.value !== undefined) e.proposed = /\{[a-z]/.test(c.value) ? 'from your input' : c.value;
          const x = ENV ? ENV.explain(c.name, item) : null;
          e.does = (x && x.does) || item.does;
          e.why = (x && x.why) || item.why;
          env.set(c.name, e);
          if (c.secret) { const s = sec.get(c.secret) || { name: c.secret, items: [], for: c.name }; s.items.push(id); sec.set(c.secret, s); }
        }
        if (c.kind === 'task') {
          const t = tasks.get(c.name) || Object.assign({ name: c.name, items: [], does: item.does, why: item.why, risk: item.risk }, taskSummary(eng, m.id, c, vr.vars));
          t.items.push(id);
          tasks.set(c.name, t);
        }
      }
      for (const n of PU.inputsOf(model, id)) {
        if (n.startsWith('secret:')) continue;
        const d = decl[n];
        if (!d || !d.ask) continue;
        const v = vars.get(n) || { name: n, type: d.type, why: d.why || null, ask: d.ask, optional: d.optional === true, pattern: d.pattern || null, items: [], value: sel.variables[n] !== undefined && d.secret !== true ? sel.variables[n] : null };
        v.items.push(id);
        vars.set(n, v);
      }
    }
    for (const e of env.values()) {
      let g = null;
      try { g = deps.env && typeof deps.env.get === 'function' ? deps.env.get(e.name) : null; } catch (err) { g = null; }
      e.current = g && g.present ? 'set' : g ? 'not set' : 'unknown';
    }
    for (const s of sec.values()) {
      let st = null;
      try { st = secrets && typeof secrets.status === 'function' ? secrets.status(s.name) : null; } catch (err) { st = null; }
      s.display = st && st.display ? st.display : 'not set';
      s.present = !!(st && st.present);
    }
    const headless = on.some((id) => model.items.get(id).module.id === 'headless');
    return { env: [...env.values()], secrets: [...sec.values()], variables: [...vars.values()], tasks: [...tasks.values()],
      account: { needed: headless, items: on.filter((id) => model.items.get(id).module.id === 'headless') } };
  }

  // ---------------------------------------------------------------- handler

  return async function profileRoutes(req, res, p, m, url) {
    const isProfile = p === '/api/profile' || p.startsWith('/api/profile/');
    const isRecover = p.startsWith('/api/recover/');
    const isMachine = p === '/api/machine' || p.startsWith('/api/machine/');
    if (!isProfile && !isRecover && !isMachine) return false;
    if (m !== 'GET' && !isLoopback(req)) { send(res, 403, { error: 'localhost only' }); return true; }
    try {
      await route(req, res, p, m, url);
    } catch (e) {
      log('profile route ' + p + ' failed: ' + e.message);
      send(res, e.status || 500, { error: e.message });
    }
    return true;
  };

  async function route(req, res, p, m, url) {
    const body = m === 'POST' ? await readBody(req, 262144) : {};
    // ---- recovery (works without a profile)
    if (p === '/api/recover/stop' && m === 'POST') {
      const r = await REC.stopAll({ dataDir, runDir, configDir, confirm: body.confirm === true, deps: { procInfo: pr.procInfo, killTree: pr.killTree || (real ? undefined : async () => false), tasks: deps.tasks, env: deps.env } });
      log('stop everything ' + (body.confirm === true ? 'ran' : 'dry run') + ': ' + r.line);
      return send(res, 200, { ok: r.ok, dryRun: !!r.dryRun, line: r.line, id: r.id || null, problems: r.problems || [] });
    }
    if (p === '/api/recover/resume' && m === 'POST') {
      const r = await REC.resume({ dataDir, confirm: body.confirm === true, deps: { tasks: deps.tasks, env: deps.env } });
      return send(res, 200, { ok: r.ok, dryRun: !!r.dryRun, nothing: !!r.nothing, line: r.line, problems: r.problems || [] });
    }
    if (p === '/api/recover/prompt' && m === 'POST') {
      const r = REC.recoverPrompt(recoverOpts(body));
      return send(res, 200, { ok: r.ok, text: r.text, bytes: r.bytes });
    }
    if (p === '/api/recover/prompt/go' && m === 'POST') {
      const pt = REC.recoverPrompt(recoverOpts(body));
      const r = await REC.promptActions(pt, { confirm: body.confirm === true, clipboard, openUrl });
      return send(res, 200, r);
    }
    // ---- machine profile
    if (p === '/api/machine' || p.startsWith('/api/machine/')) return machineRoute(res, p, m, body);
    // ---- crash report (works without a profile too)
    if (p === '/api/profile/crash' && m === 'POST') {
      const eng = engine();
      let profileState = 'not set up';
      let lastTx = null;
      if (eng && eng.model.ok) { const st = eng.status(); profileState = statusLine(eng, st); if (st.lastTx) lastTx = { id: st.lastTx.id, status: st.lastTx.ok ? (st.lastTx.reverted ? 'reverted' : 'applied') : 'failed' }; }
      const step = isObj(body.step) ? { id: String(body.step.id || '').slice(0, 80) || null, exit: Number.isInteger(body.step.exit) ? body.step.exit : null, reason: typeof body.step.reason === 'string' ? body.step.reason.slice(0, 300) : null } : {};
      const rep = CR.buildReport({ version: pr.version, channel: pr.channel, step, runDir, dataDir, home: pr.home, profileState, lastTx, username: pr.username, hostname: pr.hostname, token: pr.token, git: pr.git });
      if (!rep.ok) return send(res, 200, { ok: false, refused: true, reason: rep.reason });
      const id = crypto.randomBytes(6).toString('hex');
      reports.set(id, rep);
      while (reports.size > 10) reports.delete(reports.keys().next().value);
      return send(res, 200, { ok: true, id, text: rep.text, bytes: rep.bytes, repo: ISSUE_REPO });
    }
    if (p === '/api/profile/crash/action' && m === 'POST') {
      const rep = reports.get(String(body.id || ''));
      if (!rep) return send(res, 404, { error: 'no such report: preview it again' });
      let paneText = null;
      const r = await CR.runAction(rep, String(body.action || ''), { confirm: body.confirm === true, repo: ISSUE_REPO, documents: pr.documents, openUrl, clipboard, openPane: async (t) => { paneText = t; } });
      if (r.ok && r.action === 'claude') r.text = paneText;
      return send(res, 200, r);
    }
    // ---- adopt

    const eng = engine();
    if (p === '/api/profile' && m === 'GET') return send(res, 200, state());
    if (!eng || !eng.model.ok) return send(res, 409, { error: 'no usable setup profile in this build' });
    const model = eng.model;

    if (p === '/api/profile/item' && m === 'GET') {
      const id = url.searchParams.get('id') || '';
      const v = eng.view(id);
      if (!v || v.kind !== 'item') return send(res, 404, { error: 'unknown item' });
      const e = model.items.get(id);
      const templates = P.templatesOf(model, id).map((t) => {
        try { const r = P.readTemplate(model, e.module.id, t, dataDir); return { template: t, text: r.text, source: r.source }; } catch (err) { return { template: t, text: '', source: 'missing' }; }
      });
      return send(res, 200, { item: pubItem(v.item), templates, variables: varsPublic(eng, eng.selection()).map((x) => ({ name: x.name, why: x.why })).concat(['documents', 'home', 'temp', 'data_dir'].map((n) => ({ name: n, why: 'built in' }))) });
    }

    if (p === '/api/profile/toggle' && m === 'POST') {
      const id = String(body.id || '');
      const isMod = model.modules.some((x) => x.id === id);
      if (!isMod && !model.items.has(id)) return send(res, 404, { error: 'unknown id' });
      const sel = eng.selection();
      if (body.on === true) {
        const r = P.enable(model, sel, [id]);
        if (r.conflicts && r.conflicts.length) {
          const [a, b] = r.conflicts[0];
          const ex = (x) => { const it = model.items.get(x).item; return { id: x, title: it.title, does: it.does, why: it.why }; };
          return send(res, 200, { ok: false, conflict: { a: ex(a), b: ex(b) } });
        }
        if (!r.ok) return send(res, 409, { error: r.reason });
        if (r.added.length && body.confirm !== true) return send(res, 200, { needsConfirm: true, also: titled(eng, r.added), line: 'Turning this on also turns on: ' + titled(eng, r.added).map((x) => x.title).join(', ') });
        eng.saveSelection(r.selection);
        return send(res, 200, { ok: true, added: titled(eng, r.added) });
      }
      const r = P.disable(model, sel, [id]);
      if (!r.ok) return send(res, 409, { error: r.reason });
      if (r.removed.length && body.confirm !== true) return send(res, 200, { needsConfirm: true, also: titled(eng, r.removed), line: 'Turning this off also turns off: ' + titled(eng, r.removed).map((x) => x.title).join(', ') });
      eng.saveSelection(r.selection);
      return send(res, 200, { ok: true, removed: titled(eng, r.removed) });
    }

    if (p === '/api/profile/check' && m === 'POST') {
      return send(res, 200, { errors: P.checkTemplateText(model, String(body.text === undefined ? '' : body.text)) });
    }
    if (p === '/api/profile/edit' && m === 'POST') {
      const r = await eng.edit(String(body.id || ''), { template: body.template ? String(body.template) : undefined, text: typeof body.text === 'string' ? body.text : undefined, reset: body.reset === true });
      if (!r.ok) return send(res, 400, { ok: false, error: r.reason, errors: r.errors || [] });
      return send(res, 200, { ok: true, template: r.template, reset: !!r.reset, saved: typeof body.text === 'string' });
    }

    if (p === '/api/profile/plan' && m === 'POST') {
      const target = resolveTarget(body.target);
      if (target.error) return send(res, 400, { error: target.error });
      const inp = { target, draft: isObj(body.draft) ? body.draft : null, values: isObj(body.values) ? body.values : {}, only: Array.isArray(body.only) ? body.only.map(String) : undefined };
      const r = makePlan(eng, inp);
      plans.set(r.digest, Object.assign({ at: Date.now() }, inp));
      while (plans.size > 20) plans.delete(plans.keys().next().value);
      return send(res, 200, r.pub);
    }
    if (p === '/api/profile/apply' && m === 'POST') {
      if (!body.planId) return send(res, 400, { error: 'preview first: apply needs the plan id of a dry run' });
      if (body.confirm !== true) return send(res, 400, { error: 'confirm required: review the dry run, then apply' });
      if (busy) return send(res, 409, { error: 'an apply is already running (' + busy + ')' });
      const inp = plans.get(String(body.planId));
      if (!inp || Date.now() - inp.at > 30 * 60 * 1000) return send(res, 409, { error: 'that preview expired: preview again' });
      busy = 'plan ' + body.planId;
      try {
        const r0 = makePlan(eng, inp);
        if (r0.digest !== String(body.planId)) return send(res, 409, { error: 'the target changed since the preview: review the new plan', planId: r0.digest });
        // the values typed for this plan are kept with the selection (never secrets: those
        // live in the DPAPI store and are only referenced)
        const hasVals = inp.values && Object.keys(inp.values).length > 0;
        const sel = inp.draft || hasVals ? Object.assign({}, r0.sel, { variables: Object.assign({}, r0.sel.variables, inp.values || {}) }) : null;
        const r = await eng.apply(r0.p, { confirm: true, acks: Array.isArray(body.acks) ? body.acks.map(String) : [], groupedConsent: body.groupedConsent === true, taskConsent: taskConsentOf(body.taskConsent), selection: sel || undefined });
        log('profile apply ' + (r.ok ? r.line : 'refused: ' + r.line));
        let verify = [];
        if (r.ok) {
          try { verify = eng.verify(inp.target, { values: inp.values, selection: sel || undefined }).items.rows.map((x) => ({ item: x.item, check: x.check, ok: x.ok, skipped: x.skipped, reason: x.reason })); } catch (e) { verify = [{ item: '-', check: 'verify', ok: false, skipped: false, reason: e.message }]; }
        }
        if (r.ok) plans.delete(String(body.planId));
        return send(res, 200, { ok: !!r.ok, applied: !!r.applied, tx: r.tx || null, line: r.line, written: (r.written || []).length, flagged: r.flagged || [], commit: r.commit || null, verify });
      } finally { busy = null; }
    }
    if (p === '/api/profile/tx' && m === 'GET') return send(res, 200, { tx: eng.txList() });
    if (p === '/api/profile/revert' && m === 'POST') {
      if (busy) return send(res, 409, { error: 'an apply is running (' + busy + ')' });
      busy = 'revert';
      try {
        const r = await eng.revert(String(body.tx || 'last'), { confirm: body.confirm === true });
        return send(res, 200, { ok: r.ok, dryRun: !!r.dryRun, tx: r.tx || null, line: r.line, entries: r.entries || null, flagged: r.flagged || [] });
      } finally { busy = null; }
    }

    if (p === '/api/profile/wizard' && m === 'POST') {
      const op = String(body.op || '');
      // Every selection the wizard gets back carries its effective item states.
      const withStates = (o) => { if (o && o.selection) { const es = P.effectiveState(model, o.selection); o.states = {}; for (const id of model.order) o.states[id] = es.get(id).on ? 'on' : 'off'; } return o; };
      if (op === 'preset') {
        const r = eng.presetSelection(String(body.name || ''), { skipped: Array.isArray(body.skipped) ? body.skipped.map(String) : [], values: isObj(body.values) ? body.values : {} });
        if (!r.ok) return send(res, 400, { error: r.reason });
        return send(res, 200, withStates({ selection: r.selection, offNeeds: r.offNeeds.map((x) => Object.assign({ title: model.items.get(x.item).item.title }, x)), on: P.onIds(model, r.selection).length,
          presetOff: presetOff(model, String(body.name || '')) }));
      }
      // FB-1021: the review step records what the wizard chose, so a run that stops before
      // Apply still leaves a trace (selection, skipped inputs, value NAMES only).
      if (op === 'record') {
        const sel = P.normaliseSelection(isObj(body.selection) ? JSON.parse(JSON.stringify(body.selection)) : {}, model);
        const rec = { schema: 1, at: new Date().toISOString(), path: body.path === 'custom' ? 'custom' : 'preset', preset: sel.preset || null,
          on: P.onIds(model, sel), skipped: Array.isArray(body.skipped) ? body.skipped.map(String).slice(0, 200) : [],
          values: isObj(body.values) ? Object.keys(body.values).map(String).slice(0, 100) : [], tasks: body.tasks === true ? 'yes' : body.tasks === false ? 'no' : 'unanswered' };
        const file = path.join(P.profileStateDir(dataDir), 'wizard-review.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
        return send(res, 200, { ok: true, on: rec.on.length });
      }
      if (op === 'custom') return send(res, 200, withStates(eng.switchToCustom(isObj(body.selection) ? body.selection : undefined)));
      if (op === 'back') return send(res, 200, withStates(eng.switchBackToPreset(body.custom || {}, body.preset || {})));
      if (op === 'skip') return send(res, 200, withStates(applySkips(eng, body.selection, Array.isArray(body.skipped) ? body.skipped.map(String) : [])));
      if (op === 'toggle') {
        const sel = P.normaliseSelection(isObj(body.selection) ? JSON.parse(JSON.stringify(body.selection)) : {}, model);
        const id = String(body.id || '');
        if (!model.items.has(id) && !model.modules.some((x) => x.id === id)) return send(res, 404, { error: 'unknown id' });
        const r = body.on === true ? P.enable(model, sel, [id]) : P.disable(model, sel, [id]);
        if (r.conflicts && r.conflicts.length) return send(res, 200, { ok: false, conflict: r.conflicts[0].map((x) => ({ id: x, title: model.items.get(x).item.title })), selection: sel });
        if (!r.ok) return send(res, 409, { error: r.reason });
        // ask: the wizard's inline confirm in the toggled row's slot (design d.2, UX-F7)
        const also = r.added || r.removed || [];
        if (body.ask === true && also.length) return send(res, 200, { ok: false, needsConfirm: true, also: titled(eng, also), line: (body.on === true ? 'Turning this on also turns on: ' : 'Turning this off also turns off: ') + titled(eng, also).map((x) => x.title).join(', '), selection: sel });
        return send(res, 200, withStates({ ok: true, selection: r.selection, also: titled(eng, also) }));
      }
      if (op === 'inputs') return send(res, 200, inputs(eng, isObj(body.selection) ? body.selection : eng.selection()));
      if (op === 'state') {
        const sel = P.normaliseSelection(isObj(body.selection) ? body.selection : {}, model);
        const st = P.effectiveState(model, sel);
        return send(res, 200, { on: P.onIds(model, sel).length, modules: model.modules.map((x) => ({ id: x.id, on: x.items.filter((it) => st.get(it.id).on).length, total: x.items.length })) });
      }
      return send(res, 400, { error: 'unknown wizard op' });
    }

    if (p === '/api/profile/secret' && m === 'POST') {
      if (!secrets) return send(res, 503, { error: 'the secret store is not available here' });
      const name = String(body.name || '');
      const r = await secrets.put(name, typeof body.value === 'string' ? body.value : '', { apply: true });
      log('profile secret ' + name + ': ' + r.status);
      if (r.status !== 'applied' && r.status !== 'same') return send(res, 200, { ok: false, name, reason: r.reason || r.status });
      let disp = r.display;
      try { if (!disp && typeof secrets.status === 'function') disp = secrets.status(name).display; } catch (e) { disp = 'set'; }
      return send(res, 200, { ok: true, name, display: disp || 'set' });
    }

    if (p === '/api/profile/update' && m === 'GET') return send(res, 200, updateOffer(eng));
    if (p === '/api/profile/offer/dismiss' && m === 'POST') {
      let d = {};
      try { d = JSON.parse(fs.readFileSync(dismissFile(), 'utf8')) || {}; } catch (e) { d = {}; }
      d.install = true;
      try { d.update = JSON.parse(fs.readFileSync(path.join(pr.updateDir, 'profile.json'), 'utf8')).version; } catch (e) { /* no update staged */ }
      fs.mkdirSync(path.dirname(dismissFile()), { recursive: true });
      fs.writeFileSync(dismissFile(), JSON.stringify(d) + '\n');
      return send(res, 200, { ok: true });
    }
    if (p === '/api/profile/update/take' && m === 'POST') {
      const off = updateOffer(eng, true);
      if (!off.selection) return send(res, 409, { error: 'no update to take' });
      if (body.confirm !== true) return send(res, 400, { error: 'confirm required' });
      eng.saveSelection(off.selection);
      let ov = [];
      if (off.mode === 'merge' && pr.updateDir) { try { ov = eng.mergeOverrides(pr.updateDir); } catch (e) { ov = []; } }
      return send(res, 200, { ok: true, mode: off.mode, overrides: ov.map((x) => ({ module: x.module, template: x.template, result: x.result })) });
    }
    return send(res, 404, { error: 'unknown profile route' });
  }

  // The wizard opens by itself once at install (no selection yet) and once per staged
  // profile update; closing it records the dismissal (no nagging).
  function dismissFile() { return path.join(P.profileStateDir(dataDir), 'offer-dismissed.json'); }
  function offerKind(eng) {
    let d = null;
    try { d = JSON.parse(fs.readFileSync(dismissFile(), 'utf8')); } catch (e) { d = null; }
    const up = updateOffer(eng);
    if (up.mode !== 'none' && up.mode !== 'custom') { const v = (() => { try { return JSON.parse(fs.readFileSync(path.join(pr.updateDir, 'profile.json'), 'utf8')).version; } catch (e) { return null; } })(); if (!d || d.update !== v) return 'update'; return null; }
    if (!fs.existsSync(P.selectionFile(dataDir)) && !(d && d.install)) return 'install';
    return null;
  }

  function updateOffer(eng, withSel) {
    const dir = pr.updateDir;
    if (!dir || !fs.existsSync(path.join(dir, 'profile.json'))) return { mode: 'none', line: 'no profile update staged' };
    const off = eng.updateOffer(dir);
    const out = { mode: off.mode, line: off.line, preset: off.preset || null, diff: off.diff || [], conflicts: off.conflicts || [], taken: off.taken || [], newItems: off.newItems || [] };
    if (withSel) out.selection = off.selection || null;
    return out;
  }

  function recoverOpts(body) {
    return { dataDir, runDir, configDir, home: pr.home, version: pr.version, problems: Array.isArray(body.problems) ? body.problems.map((x) => String(x).slice(0, 300)).slice(0, 20) : [], username: pr.username, hostname: pr.hostname, token: pr.token };
  }

  async function machineRoute(res, p, m, body) {
    const M = machineMod();
    if (p === '/api/machine' && m === 'GET') {
      const last = [...advice.values()].pop() || null;
      let has = false;
      try { has = fs.existsSync(path.join(dataDir, 'machine')); } catch (e) { has = false; }
      return send(res, 200, { available: true, data: has, advice: last });
    }
    if (p === '/api/machine/data' && m === 'GET') return send(res, 200, M.readData ? M.readData() : { spec: null, inventory: null });
    if (p === '/api/machine/advise' && m === 'POST') {
      const adv = M.advise({});
      for (const x of adv.proposals || []) x.default = 'off'; // every change is opt-in
      advice.set(adv.stamp, adv);
      try { if (M.save) M.save(adv); } catch (e) { /* stored in memory only */ }
      return send(res, 200, adv);
    }
    const adv = advice.get(String(body.stamp || ''));
    const accept = Array.isArray(body.accept) ? body.accept.map(String) : [];
    if (p === '/api/machine/preview' && m === 'POST') {
      if (!adv) return send(res, 404, { error: 'advise first' });
      const sub = Object.assign({}, adv, { proposals: (adv.proposals || []).filter((x) => accept.includes(x.id)) });
      const pv = M.preview(sub);
      return send(res, 200, { rows: (pv.rows || []).map((r) => ({ id: r.id, status: r.status, from: r.from, to: r.to, label: r.label, reason: r.reason || null })), text: pv.text || null });
    }
    if (p === '/api/machine/apply' && m === 'POST') {
      if (!adv) return send(res, 404, { error: 'advise first' });
      if (!accept.length) return send(res, 400, { error: 'nothing accepted: every change is opt-in' });
      if (body.confirm !== true) return send(res, 200, { ok: false, reason: 'preview first; then confirm' });
      const sub = Object.assign({}, adv, { proposals: (adv.proposals || []).filter((x) => accept.includes(x.id)) });
      const r = await M.apply(dataDir, sub, { accept });
      return send(res, 200, { ok: !!r.ok, tx: r.txDir ? path.basename(r.txDir) : null, error: r.error || null, rows: r.rows || null });
    }
    if (p === '/api/machine/revert' && m === 'POST') {
      const tx = String(body.tx || '');
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(tx)) return send(res, 400, { error: 'bad transaction id' });
      if (body.confirm !== true) return send(res, 200, { ok: false, reason: 'confirm required' });
      const r = await M.revert(path.join(dataDir, 'machine', 'tx', tx), {});
      return send(res, 200, { ok: !!r.ok, error: r.error || null });
    }
    if (p === '/api/machine/delete' && m === 'POST') {
      if (body.confirm !== true) return send(res, 200, { ok: false, reason: 'confirm required' });
      const r = await M.deleteData();
      advice.clear();
      return send(res, 200, r);
    }
    return send(res, 404, { error: 'unknown machine route' });
  }
}

module.exports = { createProfileRoutes, ISSUE_REPO, REVIEW_FALLBACK };
