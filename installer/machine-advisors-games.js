'use strict';
// CON-013 L9 (inventory mach-adv-games): per detected game with a recipe, a list of
// app-config proposals sized from the machine spec. Proposals only: each one is off
// until the user accepts it, and profile-appconfig.js does the write.
const fs = require('fs');
const recipes = require('./machine-advisors-recipes');
const { expand } = require('./machine-inventory');

function resolveTo(change, spec) {
  return typeof change.to === 'function' ? change.to(spec) : change.to;
}

function advise(ctx) {
  ctx = ctx || {};
  const spec = ctx.spec || {};
  const env = ctx.env || process.env;
  const out = [];
  for (const r of recipes.list()) {
    const files = {};
    for (const k of Object.keys(r.files)) {
      const p = expand(r.files[k].path, env);
      files[k] = { path: p, format: r.files[k].format, exists: !/%[^%]+%/.test(p) && fs.existsSync(p) };
    }
    for (const c of r.changes) {
      const f = files[c.file];
      if (!f || !f.exists) continue;
      if (c.when && !c.when(spec)) continue;
      const to = resolveTo(c, spec);
      if (to === undefined || to === null || to === '') continue;
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
  const ids = new Set(out.map((p) => p.id));
  for (const p of out) p.requires = p.requires.filter((q) => ids.has(q));
  return out;
}

module.exports = { advise };
