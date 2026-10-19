'use strict';
// Minimal semver compare: MAJOR.MINOR.PATCH with an optional -prerelease (beta channel).
function parse(v) {
  const m = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function cmp(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) throw new Error('bad version');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    if (xp[i] === undefined) return -1;
    if (yp[i] === undefined) return 1;
    const xn = /^[0-9]+$/.test(xp[i]);
    const yn = /^[0-9]+$/.test(yp[i]);
    if (xn && yn && +xp[i] !== +yp[i]) return +xp[i] < +yp[i] ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (xp[i] !== yp[i]) return xp[i] < yp[i] ? -1 : 1;
  }
  return 0;
}

module.exports = { parse, cmp, valid: (v) => !!parse(v) };
