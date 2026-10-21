'use strict';
// CON-013 L9: the machine-profile advisors. advise() gathers findings (read-only) and
// proposals (opt-in changes); saveAdvice() stores them under <dataDir>/machine/advice;
// preview() is the dry run; applyAdvice() writes ONLY the accepted proposal ids, in one
// app-config transaction under <dataDir>/machine/tx/; revertAdvice() undoes it.
const path = require('path');
const scan = require('./machine-scan');
const ac = require('./profile-appconfig');
const games = require('./machine-advisors-games');
const machine = require('./machine-advisors-machine');
const recipes = require('./machine-advisors-recipes');

const ADVISORS = Object.freeze([
  Object.freeze({ id: 'mach-adv-machine', kind: 'findings', run: machine.advise }),
  Object.freeze({ id: 'mach-adv-games', kind: 'proposals', run: games.advise }),
]);

function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
}

function advise(ctx) {
  ctx = ctx || {};
  const now = ctx.now ? ctx.now() : Date.now();
  const findings = [];
  const proposals = [];
  for (const a of ADVISORS) {
    let got = [];
    try { got = a.run(ctx) || []; } catch (e) { got = []; }
    // A proposals advisor may also report a finding (kind 'finding'): it is shown, never applied.
    for (const x of got) (a.kind === 'findings' || (x && x.kind === 'finding') ? findings : proposals).push(x);
  }
  return { schema: 1, stamp: stampOf(now), created: new Date(now).toISOString(), findings, proposals };
}

function saveAdvice(dataDir, advice) {
  return scan.writeMachineJson(dataDir, path.join('advice', advice.stamp + '.json'), advice);
}

function preview(advice) {
  const rows = ac.plan((advice.proposals || []).filter((p) => p.kind === 'app-config'));
  return { rows, text: ac.preview(rows) };
}

let seq = 0;
async function applyAdvice(dataDir, advice, opts) {
  opts = opts || {};
  const txDir = path.join(scan.machineDir(dataDir), 'tx', advice.stamp + '-' + process.pid + '-' + (++seq));
  const edits = (advice.proposals || []).filter((p) => p.kind === 'app-config');
  const r = await ac.apply(edits, Object.assign({}, opts, { txDir }));
  return Object.assign({ txDir }, r);
}

function revertAdvice(txDir, opts) {
  return ac.revert(txDir, opts);
}

module.exports = { ADVISORS, advise, saveAdvice, preview, applyAdvice, revertAdvice, recipes };
