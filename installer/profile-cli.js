'use strict';
// `claude-console profile ...` and the recovery commands (CON-013 L3). cli.js routes here.
// Every OS effect goes through deps (env / tasks / git adapters, recycle, openUrl,
// clipboard, procInfo, killTree), so tests drive it against scratch dirs. Exit codes:
// 0 ok, 1 refused or failed (one line naming the item and the reason), 2 the plan has
// conflicts that need a decision.
const fs = require('fs');
const path = require('path');
const P = require('./profile');
const TX = require('./profile-tx');
const { exists, readJson } = require('./fsutil');

const PKG_ROOT = path.resolve(__dirname, '..');
const FLAGS = new Set(['json', 'apply', 'yes', 'last', 'all', 'reset', 'force', 'grouped-consent', 'report', 'diff', 'checks-ok', 'break-ok']);
const MULTI = new Set(['var', 'ack', 'only', 'replace', 'keep', 'accept', 'skip', 'problem', 'consent-task', 'check', 'exclude']);
const COMMA = new Set(['ack', 'only', 'replace', 'keep', 'accept', 'skip', 'consent-task', 'exclude']);

function parse(argv) {
  const out = { _: [] };
  for (const k of MULTI) out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (!x.startsWith('--')) { out._.push(x); continue; }
    const k = x.slice(2);
    const next = argv[i + 1];
    if (FLAGS.has(k)) { out[k] = true; continue; }
    const v = next === undefined || next.startsWith('--') ? true : (i++, next);
    if (MULTI.has(k)) { if (v !== true) out[k].push(...(COMMA.has(k) ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [v])); }
    else out[k] = v;
  }
  return out;
}

function onPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const n of names) for (const d of dirs) { const f = path.join(d, n); if (exists(f)) return f; }
  return null;
}

function contextFor(a, L, deps) {
  const profileDir = deps.profileDir || (typeof a['profile-dir'] === 'string' ? path.resolve(a['profile-dir']) : path.join(PKG_ROOT, 'profile'));
  const dataDir = deps.dataDir || (typeof a['data-dir'] === 'string' ? path.resolve(a['data-dir']) : L.data);
  const configDir = typeof a['config-dir'] === 'string' ? path.resolve(a['config-dir']) : (deps.configDir || require('./setup').configDirFor(process.env));
  const adapters = Object.assign(deps.noDefaultAdapters ? {} : TX.defaultAdapters({ dataDir }), pick(deps, ['env', 'tasks', 'git', 'recycle', 'appConfig', 'runHook']));
  const detect = deps.detect || ((name) => {
    if (name === 'python') return process.platform === 'win32' ? onPath(['python.exe', 'python3.exe']) : onPath(['python3', 'python']);
    if (name === 'node') return process.execPath;
    if (name === 'claude-config-dir') return configDir;
    return null;
  });
  return { profileDir, dataDir, configDir, adapters, detect };
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o && o[k] !== undefined) r[k] = o[k]; return r; }

function targetOf(a, configDir) {
  const t = typeof a.target === 'string' ? a.target : 'user';
  if (t === 'user') return { repo: null, configDir };
  const m = /^repo:(.+)$/.exec(t);
  if (!m) return { error: 'target must be user or repo:<dir>' };
  const repo = path.resolve(m[1]);
  if (!exists(repo)) return { error: 'no such repo dir' };
  return { repo, configDir };
}

function parseVars(list) {
  const o = {};
  for (const v of list || []) { const i = String(v).indexOf('='); if (i > 0) o[String(v).slice(0, i)] = String(v).slice(i + 1); }
  return o;
}

const glyph = (on, total, locked) => (locked ? '[+]' : on === 0 ? '[ ]' : on === total ? '[+]' : '[-]');

async function cliProfile(argv, L, deps) {
  deps = deps || {};
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const a = parse(argv);
  const sub = a._[0] || 'list';
  const ctx = contextFor(a, L, deps);
  if (!exists(path.join(ctx.profileDir, 'profile.json'))) { out('no setup profile in this build'); return 1; }
  const eng = P.openEngine({ profileDir: ctx.profileDir, dataDir: ctx.dataDir, configDir: ctx.configDir, deps: ctx.adapters, ctx: { detect: ctx.detect }, platform: deps.platform });
  if (!eng.model.ok) { const e = eng.model.errors[0]; out('refused: the profile does not validate: ' + e.path + ' ' + e.msg); return 1; }
  const json = (o) => out(JSON.stringify(o));
  const model = eng.model;

  if (sub === 'list') {
    const mods = eng.list();
    if (a.json) { json({ profile: model.profile.version, modules: mods }); return 0; }
    out('Setup profile ' + model.profile.version + ' (optional; nothing is written until apply)');
    for (const m of mods) {
      out(glyph(m.on, m.total, m.locked) + ' ' + String(m.order).padStart(2) + ' ' + m.title + '  ' + (m.locked ? 'always on' : m.on + '/' + m.total));
      for (const it of m.items) out('      ' + (it.state || 'off').padEnd(3) + ' ' + it.id + '  ' + (it.risk === 'high' ? 'high risk !' : it.risk) + (it.platform.length === 1 && it.platform[0] === 'win32' ? '  Windows only' : '') + '  ' + it.title);
    }
    return 0;
  }

  if (sub === 'view') {
    const v = eng.view(a._[1]);
    if (!v) { out('refused: unknown item or module ' + (a._[1] || '')); return 1; }
    if (a.json) { json(v); return 0; }
    if (v.kind === 'module') {
      const m = v.module;
      out(m.title + ' (' + (m.locked ? 'always on' : m.on + ' of ' + m.total + ' on') + ')');
      out('Summary: ' + m.summary);
      for (const it of m.items) out('  ' + it.state + ' ' + it.id + ' - ' + it.title);
      return 0;
    }
    const it = v.item;
    out(it.title + '  [' + it.state + (it.locked ? ', always on' : '') + ', ' + it.risk + ' risk]');
    out('Does: ' + it.does);
    out('Why on: ' + it.why);
    out('Needs: ' + (it.depends_on.join(', ') || '-') + '   Usually with: ' + (it.pairs_with.join(', ') || '-') + '   Clashes with: ' + (it.conflicts_with.join(', ') || '-'));
    for (const c of it.contributes) out('  contributes ' + c.kind + ' ' + (c.target || c.name || c.key || (c.files || []).join(',')) + (c.template ? ' from ' + c.template : ''));
    return 0;
  }

  if (sub === 'enable' || sub === 'disable') {
    const ids = a._.slice(1);
    if (!ids.length) { out('name the items or modules to ' + sub); return 1; }
    const r = sub === 'enable' ? eng.enable(ids) : eng.disable(ids);
    if (!r.ok) { out('refused: ' + r.reason); return 1; }
    const st = eng.status({});
    const lines = [(sub === 'enable' ? 'on: ' : 'off: ') + ids.join(', ')];
    if (r.added && r.added.length) lines.push('also on (needed): ' + r.added.join(', '));
    if (r.removed && r.removed.length) lines.push('also off (they need it): ' + r.removed.join(', '));
    lines.push(st.pending.length + ' pending change(s) - review with: claude-console profile diff');
    if (a.json) json(Object.assign({}, r, { pending: st.pending })); else lines.forEach(out);
    return 0;
  }

  if (sub === 'edit') {
    const id = a._[1];
    const o = { template: typeof a.template === 'string' ? a.template : undefined, reset: !!a.reset };
    if (typeof a.file === 'string') { try { o.text = fs.readFileSync(path.resolve(a.file), 'utf8'); } catch (e) { out('refused: cannot read ' + path.basename(a.file)); return 1; } }
    const r = await eng.edit(id, o);
    if (!r.ok) { out('refused: ' + r.reason); return 1; }
    if (o.reset) out(r.reset ? 'override dropped; back to the shipped template ' + r.template : 'no override to drop');
    else if (o.text !== undefined) out('override saved: ' + r.template + ' (the next plan renders it)');
    else { out('# ' + r.template + ' (' + (fs.existsSync(r.file) ? 'your override' : 'shipped') + '; save a changed copy with --file F)'); out(r.text.replace(/\n$/, '')); }
    return 0;
  }

  if (sub === 'revert') {
    const tx = typeof a.tx === 'string' ? a.tx : 'last';
    const r = await eng.revert(tx, { confirm: a.apply === true && a.yes === true });
    if (a.json) json(r); else out(r.line + (r.dryRun ? '' : ''));
    if (!r.dryRun && r.flagged) r.flagged.forEach((f) => out('kept: ' + f));
    return r.code;
  }

  if (sub === 'verify') {
    const t = targetOf(a, ctx.configDir);
    if (t.error) { out('refused: ' + t.error); return 1; }
    const v = eng.verify(t, { values: parseVars(a.var) });
    if (a.json) { json(v); return v.items.ok && v.lock.ok ? 0 : 1; }
    for (const r of v.items.rows) out((r.ok ? '[+] ' : r.skipped ? '[-] ' : '[x] ') + r.item + ' ' + r.check + (r.reason ? ' - ' + r.reason : ''));
    for (const r of v.lock.rows.filter((x) => x.state !== 'ok')) out('[x] lock ' + r.side + ':' + r.rel + ' ' + r.state);
    return v.items.ok && v.lock.ok ? 0 : 1;
  }

  if (sub === 'status') {
    const t = targetOf(a, ctx.configDir);
    if (t.error) { out('refused: ' + t.error); return 1; }
    const s = eng.status(t);
    if (a.json) { json(s); return 0; }
    out('profile ' + s.profile + ' - ' + s.on + ' of ' + s.total + ' items on' + (s.preset ? ' (preset ' + s.preset + ')' : ''));
    out('lock: ' + s.applied.length + ' item(s), ' + s.drift.length + ' drift');
    for (const d of s.drift) out('  drift: ' + d.side + ':' + d.rel + ' ' + d.state);
    out('last tx: ' + (s.lastTx ? s.lastTx.id + (s.lastTx.reverted ? ' (reverted)' : s.lastTx.ok ? ' (applied)' : ' (failed)') : 'none'));
    out('pending: ' + s.pending.length + (s.pending.length ? ' (' + s.pending.join(', ') + ')' : ''));
    return 0;
  }

  if (sub === 'update') {
    if (typeof a.from !== 'string') { out('update needs --from <new profile dir>'); return 1; }
    const offer = eng.updateOffer(path.resolve(a.from));
    if (a.json && !(a.apply && a.yes)) { json(offer); return 0; }
    out(offer.line);
    for (const r of offer.diff || []) out('  ' + r.change + ' ' + r.item + (r.to ? ' -> ' + r.to : ''));
    for (const c of offer.conflicts || []) out('  conflict ' + c.item + ': yours ' + c.mine + ', new ' + c.theirs + (c.note ? ' - ' + c.note : ''));
    if (!(a.apply && a.yes)) { if (offer.selection) out('take it with: claude-console profile update --from <dir> --apply --yes (then review with profile diff)'); return 0; }
    if (!offer.selection) return 0;
    eng.saveSelection(offer.selection);
    const ov = offer.mode === 'merge' ? eng.mergeOverrides(path.resolve(a.from)) : [];
    for (const r of ov) out('  override ' + r.module + '/' + r.template + ': ' + r.result + (r.side ? ' (see ' + r.side + ')' : ''));
    out('selection updated; review with: claude-console profile diff, then profile apply --apply --yes');
    return 0;
  }

  if (sub === 'adopt') {
    let adopt;
    try { adopt = require('./profile-adopt'); } catch (e) { out('adopt is not in this build'); return 1; }
    if (typeof adopt.cliAdopt !== 'function') { out('adopt is not in this build'); return 1; }
    const adeps = Object.assign({}, ctx.adapters, { detect: ctx.detect, platform: deps.platform }, pick(deps, ['ask', 'runCheck', 'zip', 'unzip', 'adoptRoot', 'now', 'runId']));
    // remove-original and revert send folders to the Recycle Bin: the CLI gets the real
    // one, as the console route does (013-VERIFY sandbox E7: "no Recycle Bin adapter").
    if (!adeps.recycle && !deps.noDefaultAdapters) adeps.recycle = TX.defaultRecycle(ctx.dataDir);
    return adopt.cliAdopt(a, { engine: eng, out, deps: adeps, dataDir: ctx.dataDir, configDir: ctx.configDir });
  }

  if (sub === 'diff' || sub === 'apply' || sub === 'uninstall') {
    const t = targetOf(a, ctx.configDir);
    if (t.error) { out('refused: ' + t.error); return 1; }
    let sel = eng.selection();
    let grouped = false;
    if (typeof a.preset === 'string') {
      const ps = eng.presetSelection(a.preset, { skipped: a.skip, values: sel.variables });
      if (!ps.ok) { out('refused: ' + ps.reason); return 1; }
      sel = ps.selection;
      for (const n of ps.offNeeds) out('off - needs ' + n.needs.join(', ') + ': ' + n.item);
      grouped = a['grouped-consent'] === true;
    }
    const values = Object.assign({}, sel.variables, parseVars(a.var));
    const resolve = {};
    for (const id of a.replace) resolve[id] = 'replace';
    for (const id of a.keep) resolve[id] = 'keep';
    let plan;
    let removeIds = null;
    if (sub === 'uninstall') {
      removeIds = a.all ? 'all' : a._.slice(1);
      if (removeIds !== 'all' && !removeIds.length) { out('uninstall needs <module|item ...> or --all'); return 1; }
      plan = eng.plan({ target: t, remove: removeIds === 'all' ? model.order.slice() : removeIds, values, resolve, selection: sel });
    } else plan = eng.plan({ target: t, only: a.only.length ? a.only : null, values, resolve, selection: sel });
    const v = eng.verdict(plan);
    const taskNames = TX.tasksNeedingConsent(plan).map((t) => t.name);
    if (sub === 'diff') {
      if (a.json) json({ rows: plan.rows, counts: plan.counts, diff: eng.diff(plan), verdict: v });
      else { const d = eng.diff(plan); out(d ? d.replace(/\n$/, '') : 'no changes'); if (v.line) out(v.line); }
      return v.code;
    }
    if (!(a.apply === true)) {
      if (a.json) json({ rows: plan.rows, counts: plan.counts, highRisk: plan.highRisk, needsAck: plan.needsAck, missing: plan.missing, verdict: v });
      else {
        eng.planLines(plan).forEach(out);
        if (v.line) out(v.line);
        const acks = plan.highRisk.concat(plan.needsAck).map((x) => ' --ack ' + x).join('');
        // Scheduled tasks: one consent per task (custom) or one grouped yes / no (preset).
        if (taskNames.length) out(grouped ? 'scheduled tasks (one grouped consent): ' + taskNames.join(', ') : 'scheduled tasks need consent: ' + taskNames.join(', ') + ' (one --consent-task per task)');
        const consent = grouped ? '' : taskNames.map((x) => ' --consent-task ' + x).join('');
        out('apply with: claude-console profile ' + sub + ' ' + (a.target ? '--target ' + a.target + ' ' : '') + (removeIds ? (removeIds === 'all' ? '--all ' : removeIds.join(' ') + ' ') : '') + '--apply --yes' + acks + consent);
      }
      return v.code;
    }
    if (a.yes !== true) { out(sub + ' --apply writes files; add --yes after reviewing the plan'); return 1; }
    const nextSel = P.normaliseSelection(JSON.parse(JSON.stringify(sel)), model);
    nextSel.variables = Object.assign({}, sel.variables, parseVars(a.var));
    if (removeIds) for (const id of plan.removing) nextSel.items[id] = 'off';
    let taskConsent = null;
    if (taskNames.length && grouped) {
      out('scheduled tasks (one grouped consent): ' + taskNames.join(', '));
      taskConsent = { mode: 'grouped', yes: true, listed: taskNames };
    } else if (taskNames.length) {
      taskConsent = { mode: 'per-task', tasks: Object.fromEntries(a['consent-task'].map((n) => [n, true])) };
    }
    const res = await eng.apply(plan, { confirm: true, acks: a.ack, groupedConsent: grouped, taskConsent, selection: nextSel });
    if (a.json) { json(res.report || res); return res.code; }
    out(res.line);
    for (const f of res.flagged || []) out('kept: ' + f);
    if (res.ok && res.commit) {
      out('suggested commit (the profile never commits):');
      out('  git add -- ' + res.commit.paths.map((p) => (/\s/.test(p) ? '"' + p + '"' : p)).join(' '));
      out('  git commit -m "' + res.commit.message + '"');
    }
    return res.code;
  }

  out('unknown profile command: ' + sub);
  return 2;
}

// ------------------------------------------------------------------ recovery commands

async function cliRecover(cmd, argv, L, deps) {
  deps = deps || {};
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const a = parse(argv);
  const ctx = contextFor(a, L, deps);
  const version = (readJson(path.join(PKG_ROOT, 'package.json'), {}) || {}).version || '?';
  const token = (() => { try { return fs.readFileSync(path.join(L.run, 'token'), 'utf8').trim(); } catch (e) { return null; } })();
  const R = require('./recover');
  const CR = require('./crashreport');
  const rdeps = Object.assign({}, ctx.adapters, pick(deps, ['procInfo', 'killTree']));

  if (cmd === 'stop-all') {
    const r = await R.stopAll({ dataDir: ctx.dataDir, runDir: L.run, configDir: ctx.configDir, confirm: a.yes === true, deps: rdeps });
    if (a.json) out(JSON.stringify(r)); else out(r.line);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'resume') {
    const r = await R.resume({ dataDir: ctx.dataDir, id: typeof a.record === 'string' ? a.record : undefined, confirm: a.yes === true, deps: rdeps });
    if (a.json) out(JSON.stringify(r)); else out(r.line);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'recover-prompt') {
    const p = R.recoverPrompt({ dataDir: ctx.dataDir, runDir: L.run, configDir: ctx.configDir, home: L.home, version, problems: a.problem, token });
    if (a.yes !== true) {
      out('Recovery prompt preview (' + p.bytes + ' bytes; nothing copied or opened yet):');
      out(p.text.replace(/\n$/, ''));
      out('copy it and open claude.ai with: claude-console recover-prompt --yes');
      return 0;
    }
    const r = await R.promptActions(p, { confirm: true, clipboard: deps.clipboard, openUrl: deps.openUrl });
    out(r.ok ? r.line : 'refused: ' + r.reason);
    return r.ok ? 0 : 1;
  }
  // crash-report
  let profileState = null;
  let lastTx = null;
  try {
    if (exists(path.join(ctx.profileDir, 'profile.json'))) {
      const eng = P.openEngine({ profileDir: ctx.profileDir, dataDir: ctx.dataDir, configDir: ctx.configDir, deps: ctx.adapters });
      const s = eng.status({});
      profileState = 'profile ' + s.profile + ' - ' + s.on + ' of ' + s.total + ' items on' + (s.lastTx ? ' - last applied ' + String(s.lastTx.at || s.lastTx.id).slice(0, 10) : '');
      if (s.lastTx) lastTx = { id: s.lastTx.id, status: s.lastTx.reverted ? 'reverted' : s.lastTx.ok ? 'applied' : 'failed' };
    }
  } catch (e) { profileState = 'unreadable'; }
  const rep = CR.buildReport({ version, channel: deps.channel, step: { id: typeof a.step === 'string' ? a.step : null, reason: typeof a.reason === 'string' ? a.reason : null, exit: a.exit !== undefined && a.exit !== true ? +a.exit : null },
    runDir: L.run, dataDir: ctx.dataDir, home: L.home, profileState, lastTx, token, git: deps.gitPresent });
  if (!rep.ok) { out('refused: ' + rep.reason); return 1; }
  if (typeof a.action !== 'string' || a.yes !== true) {
    out('Crash report preview (' + rep.bytes + ' bytes; nothing sent):');
    out(rep.text.replace(/\n$/, ''));
    out('pick one: --action issue (GitHub issue in your browser) | --action claude (ask your Claude) | --action save (a file in Documents), then --yes');
    return 0;
  }
  const r = await CR.runAction(rep, a.action, { confirm: true, openUrl: deps.openUrl, clipboard: deps.clipboard, openPane: deps.openPane, documents: deps.documents });
  if (!r.ok) { out('refused: ' + r.reason); return 1; }
  out(a.action === 'issue' ? 'opened the issue page in your browser' + (r.truncated ? ' (cut to fit; attach the saved file)' : '') : a.action === 'save' ? 'saved: ' + path.basename(r.file) + ' in Documents' : 'copied the report for your Claude' + (r.via === 'clipboard' ? ' (clipboard; paste it into a pane)' : ''));
  return 0;
}

module.exports = { cliProfile, cliRecover, parse };
