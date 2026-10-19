'use strict';
// Operator-made groups in the Projects sidebar, saved on the server in settings.json
// (settings.sidebarGroups). Each group: { id, name, open, items } where an item is
// 'p:<projectId>' or 't:<toolId>'. An item sits in at most one group; anything not in
// a group stays in its usual place (projects in projectOrder, tools under their project).
const GID_RE = /^g-[a-z0-9]{1,24}$/;
const ITEM_RE = /^[pt]:[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_GROUPS = 50;
const MAX_ITEMS = 200;

function sanitizeGroups(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const ids = new Set();
  const used = new Set();
  for (const g of v.slice(0, MAX_GROUPS)) {
    if (!g || typeof g !== 'object' || !GID_RE.test(String(g.id || '')) || ids.has(g.id)) continue;
    ids.add(g.id);
    const name = String(g.name || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 40) || 'Group';
    const items = [];
    for (const it of Array.isArray(g.items) ? g.items.slice(0, MAX_ITEMS) : []) {
      if (typeof it !== 'string' || !ITEM_RE.test(it) || used.has(it)) continue;
      used.add(it);
      items.push(it);
    }
    out.push({ id: g.id, name, open: g.open !== false, items });
  }
  return out;
}

module.exports = { sanitizeGroups };
