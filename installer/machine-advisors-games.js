'use strict';
// CON-013 L9 (inventory mach-adv-games): per detected game with a recipe, a list of
// app-config proposals sized from the machine spec. Proposals only: each one is off
// until the user accepts it, and profile-appconfig.js does the write.
// OH-RECIPE: a path may use %STEAMAPP_<appid>% (the game's install folder, from the
// Steam inventory or the recipe's install_default); a change with `expect` is proposed
// only while the file's current value matches it; an installed game with none of its
// config files yet gets one finding (kind 'finding') carrying the recipe's `missing`.
const fs = require('fs');
const recipes = require('./machine-advisors-recipes');
const ac = require('./profile-appconfig');
const { expand } = require('./machine-inventory');

function resolveTo(change, spec) {
  return typeof change.to === 'function' ? change.to(spec) : change.to;
}

function readText(p) {
  try { return ac.decode(fs.readFileSync(p)).text; } catch (e) { return null; }
}

// The file's current value of key, or null when absent / unreadable / not a single value.
function currentValue(f, key) {
  if (f.text === undefined) f.text = readText(f.path);
  if (f.text === null) return null;
  const v = ac.getValue(f.format, f.text, key);
  return v && v.count === 1 ? String(v.value) : null;
}

function advise(ctx) {
  ctx = ctx || {};
  const spec = ctx.spec || {};
  const games = (ctx.inventory && Array.isArray(ctx.inventory.games)) ? ctx.inventory.games : [];
  const env = recipes.withAppDirs(ctx.env || process.env, games, expand);
  const out = [];
  for (const r of recipes.list()) {
    const files = {};
    for (const k of Object.keys(r.files)) {
      const p = expand(r.files[k].path, env);
      files[k] = { path: p, format: r.files[k].format, exists: !/%[^%]+%/.test(p) && fs.existsSync(p) };
    }
    if (r.missing && !Object.keys(files).some((k) => files[k].exists)) {
      const dir = r.steam_appid ? env['STEAMAPP_' + r.steam_appid] : null;
      const installed = games.some((g) => g && String(g.appid) === r.steam_appid) || !!(dir && fs.existsSync(dir));
      if (installed) {
        out.push({
          id: r.id + '.launch-once', advisor: 'games', app: r.id, app_title: r.title, kind: 'finding', level: 'info',
          title: r.title + ': launch once to generate config', text: r.missing,
          files: Object.keys(files).map((k) => files[k].path),
        });
      }
      continue;
    }
    for (const c of r.changes) {
      const f = files[c.file];
      if (!f || !f.exists) continue;
      if (c.when && !c.when(spec)) continue;
      const to = resolveTo(c, spec);
      if (to === undefined || to === null || to === '') continue;
      if (c.expect || c.satisfied) {
        const cur = currentValue(f, c.key);
        if (cur === null) continue;
        if (c.expect && !c.expect.test(cur)) continue;
        if (c.satisfied && c.satisfied.test(cur)) continue;
      }
      out.push({
        id: r.id + '.' + c.id,
        advisor: 'games',
        app: r.id,
        app_title: r.title,
        kind: 'app-config',
        title: c.title,
        why: c.why,
        default: 'off',
        risk: 'high',
        target: { file: f.path, key: c.key },
        format: f.format,
        to,
        processes: r.processes.slice(),
        requires: (c.requires || []).map((q) => r.id + '.' + q),
        confirm: r.confirm || null,
      });
    }
  }
  // A requirement that was filtered out (its own `when` failed) is dropped from the
  // dependants, never left dangling.
  const ids = new Set(out.filter((p) => p.kind === 'app-config').map((p) => p.id));
  for (const p of out) if (p.requires) p.requires = p.requires.filter((q) => ids.has(q));
  return out;
}

module.exports = { advise };
