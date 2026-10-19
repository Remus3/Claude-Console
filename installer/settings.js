'use strict';
// The `updates` setting (CON-PUBLIC E), read from the console config
// (config/console.json merged with data/console.local.json):
//   {"auto": false, "channel": "stable", "checkHours": 24, "window": "04:00-05:00",
//    "check": true, "repo": null, "reintegrate": {"enabled": false, "command": null}}
// auto defaults to false for strangers. repo is "<owner>/<name>" of the public repo and
// stays null until the operator publishes (CON-PUBLIC A); no repo = no check.
const DEFAULTS = Object.freeze({
  auto: false,
  channel: 'stable',
  checkHours: 24,
  window: '04:00-05:00',
  check: true,
  repo: null,
  reintegrate: Object.freeze({ enabled: false, command: null, timeoutSec: 1800 }),
});

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const WINDOW_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])-([01][0-9]|2[0-3]):([0-5][0-9])$/;

function normalizeUpdates(u) {
  u = u && typeof u === 'object' ? u : {};
  const out = {
    auto: u.auto === true,
    channel: u.channel === 'beta' ? 'beta' : 'stable',
    checkHours: Number.isFinite(u.checkHours) && u.checkHours >= 1 && u.checkHours <= 24 * 30 ? u.checkHours : DEFAULTS.checkHours,
    window: u.window === null || u.window === '' ? null : (typeof u.window === 'string' && WINDOW_RE.test(u.window) ? u.window : DEFAULTS.window),
    check: u.check !== false,
    repo: typeof u.repo === 'string' && REPO_RE.test(u.repo) ? u.repo : null,
    reintegrate: { enabled: false, command: null, timeoutSec: DEFAULTS.reintegrate.timeoutSec },
  };
  const r = u.reintegrate && typeof u.reintegrate === 'object' ? u.reintegrate : {};
  if (r.enabled === true && Array.isArray(r.command) && r.command.length && r.command.every((a) => typeof a === 'string' && a.length < 2000)) {
    out.reintegrate.enabled = true;
    out.reintegrate.command = r.command.slice();
  }
  if (Number.isFinite(r.timeoutSec) && r.timeoutSec >= 60 && r.timeoutSec <= 4 * 3600) out.reintegrate.timeoutSec = r.timeoutSec;
  return out;
}

// Inside "HH:MM-HH:MM" local time (a window may wrap midnight). null window = always.
function inWindow(win, now) {
  if (!win) return true;
  const m = WINDOW_RE.exec(win);
  if (!m) return false;
  const d = now || new Date();
  const t = d.getHours() * 60 + d.getMinutes();
  const a = +m[1] * 60 + +m[2];
  const b = +m[3] * 60 + +m[4];
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

// Auto mode decision for a staged/available update. Returns {apply, restart, reason}.
//   - manual mode never applies on its own (badge + button only);
//   - auto applies only inside the window;
//   - conflicts or local mods that need review skip with a badge;
//   - never restarts while a pane is busy: it applies (stages) and waits.
function decideAuto(o) {
  const s = normalizeUpdates(o.settings);
  if (!o.available) return { apply: false, restart: false, reason: 'up-to-date' };
  if (!s.auto) return { apply: false, restart: false, reason: 'manual' };
  if (!inWindow(s.window, o.now)) return { apply: false, restart: false, reason: 'outside-window' };
  if (o.needsReview) return { apply: false, restart: false, reason: 'needs-review' };
  const busy = (o.panes || []).filter((p) => p && (p.state === 'busy' || p.state === 'starting')).length;
  if (busy) return { apply: true, restart: false, reason: 'panes-busy', busy };
  return { apply: true, restart: !!o.serverRunning, reason: 'ok' };
}

module.exports = { DEFAULTS, normalizeUpdates, inWindow, decideAuto, REPO_RE };
