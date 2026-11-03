'use strict';
// MERGE-CON G5: the "Update available vX" header badge (left to the UI lane by
// docs/g5-wiring.patch) and the wiring of the /api/updates routes + the Settings
// "Updates & repair" section. The badge stays hidden while updates.repo is unset.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const U = require('../public/app.js').Upd;
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const PUB = path.join(__dirname, '..', 'public');
const st = (o) => Object.assign({ mode: 'installed', version: '0.1.0', installed: { version: '0.1.0', channel: 'stable' }, settings: { auto: false, repo: 'someone/claude-console' }, lastCheck: null, auto: null }, o);

test('Upd.badge: hidden without a repo, without a state or with nothing available', () => {
  assert.strictEqual(U.badge(null), null);
  assert.strictEqual(U.badge(st({ settings: { repo: null }, lastCheck: { checked: true, available: true, latest: { version: '0.2.0' } } })), null, 'repo unset = hidden even with a stale check');
  assert.strictEqual(U.badge(st({ settings: {} , auto: { available: '0.2.0' } })), null);
  assert.strictEqual(U.badge(st({})), null);
  assert.strictEqual(U.badge(st({ lastCheck: { checked: true, available: false } })), null);
});

test('Upd.badge: the available version from the last check, else from the auto-update tick', () => {
  assert.deepStrictEqual(U.badge(st({ lastCheck: { checked: true, available: true, latest: { version: '0.2.0' } } })), { text: 'Update available v0.2.0', title: 'v0.1.0 installed; v0.2.0 is available. Opens Settings > Updates & repair.' });
  assert.strictEqual(U.badge(st({ auto: { available: '0.3.1' } })).text, 'Update available v0.3.1');
  assert.strictEqual(U.badge(st({ mode: 'checkout', installed: null, lastCheck: { checked: true, available: true, latest: { version: '0.2.0' } } })).title, 'v0.1.0 running; v0.2.0 is available. Opens Settings > Updates & repair.');
  assert.match(U.badge(st({ auto: { available: '0.2.0', review: { version: '0.2.0', conflicts: ['a', 'b'] } } })).title, /needs review: 2 conflicting files/);
});

test('header: badge button hidden by default, in the top actions; Settings has Updates & repair', () => {
  const h = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const top = /<div class="top-actions">[\s\S]*?<\/div>/.exec(h)[0];
  assert.match(top, /<button id="upd-badge"[^>]*hidden[^>]*>/);
  assert.match(h, /<fieldset[^>]*id="set-updates"/);
  for (const id of ['upd-state', 'btn-upd-check', 'btn-upd-apply', 'upd-last', 'btn-upd-contrib', 'btn-upd-repair']) assert.match(h, new RegExp('id="' + id + '"'), id);
  // R3-5: no promise of an automatic check; R1-25: the way out is named
  assert.doesNotMatch(h, /upd-auto|Auto-update|update window/);
  assert.match(h, /id="upd-how">Nothing checks in the background\. Press Check now to look for a new version\.</);
  assert.match(h, /To remove the console: Apps &amp; features &gt; Claude Console &gt; Uninstall\./);
  assert.doesNotMatch(h, /id="upd-state"[^>]*>Checking/, 'nothing is checking when the page loads');
  // CON-CONTRIB-LABEL: the patch button says what it does, with a one-line help beside it
  assert.doesNotMatch(h, /Contribute\?/);
  assert.match(h, /<span class="muted small" id="upd-contrib-help">[^<]*scrubbed patch file in reports\/[^<]*nothing is sent\.<\/span><button type="button" id="btn-upd-contrib" class="small">Save my edits as a patch<\/button>/);
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.match(css, /#upd-badge \{[^}]*font-size: var\(--fs-badge\)/);
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(js, /UP\.badge\(/);
});

test('server: /api/updates routes are wired behind the token', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  assert.strictEqual((await fetch(base + '/api/updates')).status, 401);
  const s = await (await fetch(base + '/api/updates', { headers: H })).json();
  assert.ok(['installed', 'checkout'].includes(s.mode));
  assert.strictEqual(s.settings.repo, null, 'no repo on a fresh config');
  assert.strictEqual(U.badge(s), null);
  const c = await (await fetch(base + '/api/updates/check', { method: 'POST', headers: H, body: '{}' })).json();
  assert.strictEqual(c.reason, 'no-repo');
});
