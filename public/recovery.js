/* Claude Console - crash report, Stop everything and Get help in the browser
   (CON-013 L5, addendum e.2 / e.3). The report and the recovery prompt are shown in
   full before anything happens; every action is one deliberate click; Stop everything
   is two-step (click, then confirm). ASCII only. */

(function (root) {
  'use strict';
  function sizeText(bytes) { return bytes >= 1024 ? (Math.round(bytes / 102.4) / 10) + ' KB' : bytes + ' bytes'; }
  function actionLine(r) {
    if (!r) return '';
    if (!r.ok) return '[x] ' + (r.reason || r.error || 'refused');
    if (r.action === 'issue') return '[+] opened the GitHub issue form in your browser' + (r.truncated ? ' (report cut to fit: save the report to a file and attach it)' : '');
    if (r.action === 'claude') return '[+] opened a Claude pane with the report in its message box; review it and press Enter';
    if (r.action === 'save') return '[+] saved to ' + r.file;
    return '[+] done';
  }
  // R3-4: what the Stop dialog says when an earlier stop has not been resumed.
  function openStopLine(line) { return 'A stop is still open. ' + String(line || '').replace(' - confirm to go ahead', ''); }
  const api = { sizeText, actionLine, openStopLine };
  if (typeof module === 'object' && module.exports) module.exports.Recovery = api;
  else root.CCRecovery = api;
})(this);

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const RV = window.CCRecovery;
  const U = window.CCUI;
  const { h, api } = U;
  const $ = (s) => document.querySelector(s);
  let report = null;

  // ---- crash report: preview the exact text, then one of three actions
  async function crash(step) {
    U.open($('#dlg-crash'));
    const ta = $('#cr-text');
    ta.value = 'Building the report...';
    U.note($('#cr-note'), '');
    for (const b of document.querySelectorAll('#dlg-crash .cr-act')) b.disabled = true;
    try { report = await api('POST', '/api/profile/crash', { step: step || null }); } catch (e) { ta.value = ''; U.note($('#cr-note'), '[x] ' + e.message, true); return; }
    if (!report.ok) { ta.value = ''; U.note($('#cr-note'), '[x] ' + (report.reason || 'refused'), true); return; }
    ta.value = report.text;
    $('#cr-size').textContent = 'Exactly this text, ' + RV.sizeText(report.bytes) + '. Nothing is sent until you pick one action.';
    for (const b of document.querySelectorAll('#dlg-crash .cr-act')) b.disabled = false;
  }
  async function act(action) {
    if (!report || !report.ok) return;
    let r;
    try { r = await api('POST', '/api/profile/crash/action', { id: report.id, action, confirm: true }); } catch (e) { r = { ok: false, error: e.message }; }
    if (r.ok && action === 'claude' && r.text && window.__cc && window.__cc.openPane) {
      const v = await window.__cc.openPane({ kind: 'claude', title: 'crash report' });
      if (v && v.ta) { v.ta.value = r.text; v.ta.dispatchEvent(new Event('input')); }
    }
    U.note($('#cr-note'), RV.actionLine(r), !r.ok);
  }

  // ---- Stop everything: step 1 shows what it would do, step 2 does it
  // stopGen: an answer that arrives after the dialog moved on never overwrites its line.
  let stopGen = 0;
  function setResume(on, title) {
    const b = $('#st-resume');
    b.disabled = !on;
    b.title = on ? (title || '') : 'Available after Stop everything';
  }
  // R3-4: the Resume button follows the records on disk, not this dialog's own history. A
  // stop run earlier (a closed dialog, another window, a restart, the terminal) can be
  // undone here; the route without confirm is a dry run. Stop stays off until it answered.
  async function stop() {
    const gen = ++stopGen;
    U.open($('#dlg-stop'));
    const line = $('#st-line');
    const go = $('#st-go');
    go.textContent = 'Stop everything';
    go.dataset.step = '1';
    go.disabled = true;
    setResume(false);
    U.note($('#st-confirm'), '');
    U.note(line, 'Checking...');
    let can = false;
    try { const r = await api('POST', '/api/recover/stop', {}); if (gen !== stopGen) return; U.note(line, r.line); can = true; } catch (e) { if (gen !== stopGen) return; U.note(line, '[x] ' + e.message, true); }
    try {
      const x = await api('POST', '/api/recover/resume', {});
      if (gen !== stopGen) return;
      if (x.ok && x.dryRun) { const t = RV.openStopLine(x.line); setResume(true, t); U.note(line, t); }
    } catch (e) { /* the line above stands; Resume stays off */ }
    if (gen === stopGen) go.disabled = !can;
  }
  async function stopGo() {
    const go = $('#st-go');
    const line = $('#st-line');
    if (go.dataset.step === '1') { go.dataset.step = '2'; go.textContent = 'Yes, stop everything now'; U.note($('#st-confirm'), 'Second step: every console pane and headless run (background Claude session) ends, profile tasks are disabled and profile hooks (scripts Claude runs around its actions) go off. Resume undoes the tasks and hooks. Open panes are not reopened by Resume.'); go.focus(); return; }
    stopGen++;
    go.disabled = true;
    U.note($('#st-confirm'), '');
    try {
      const r = await api('POST', '/api/recover/stop', { confirm: true });
      U.note(line, (r.ok ? '[+] ' : '[x] ') + r.line, !r.ok);
      if (r.id) setResume(true);
    } catch (e) { U.note(line, '[x] ' + e.message, true); }
  }
  // A second stop writes its own (often empty) record and the route takes the newest open
  // one, so one press undoes every open stop, newest first, as recover.ps1 -Resume does.
  async function resume() {
    stopGen++;
    const line = $('#st-line');
    $('#st-resume').disabled = true;
    let r = null;
    let n = 0;
    let open = null;
    try {
      for (let i = 0; i < 50; i++) {
        r = await api('POST', '/api/recover/resume', { confirm: true });
        n++;
        if (r.nothing) break;
        const x = await api('POST', '/api/recover/resume', {});
        open = x.ok && x.dryRun ? x : null;
        if (!r.ok || !open) break;
      }
      U.note(line, (r.ok ? '[+] ' : '[x] ') + r.line + (n > 1 ? ' (' + n + ' open stops undone)' : ''), !r.ok);
      if (open) setResume(true, RV.openStopLine(open.line)); else setResume(false);
    } catch (e) { U.note(line, '[x] ' + e.message, true); $('#st-resume').disabled = false; }
  }

  // ---- Get help in the browser: preview the prompt, then copy + open claude.ai
  // (gh-* ids: hp-* belongs to another panel, UX-B2)
  async function help() {
    U.open($('#dlg-help'));
    const ta = $('#gh-text');
    ta.value = 'Building the prompt...';
    $('#gh-go').disabled = true;
    U.note($('#gh-note'), '');
    try { const r = await api('POST', '/api/recover/prompt', {}); ta.value = r.text; $('#gh-size').textContent = RV.sizeText(r.bytes) + ', scrubbed: setting, hook and project folder names only; no user names, paths, keys or values.'; $('#gh-go').disabled = false; } catch (e) { ta.value = ''; U.note($('#gh-note'), '[x] ' + e.message, true); }
  }
  async function helpGo() {
    let r;
    try { r = await api('POST', '/api/recover/prompt/go', { confirm: true }); } catch (e) { r = { ok: false, reason: e.message }; }
    U.note($('#gh-note'), r.ok ? '[+] ' + r.line : '[x] ' + (r.reason || 'failed'), !r.ok);
  }

  function wire() {
    if (!$('#dlg-crash')) return;
    $('#cr-issue').addEventListener('click', () => act('issue'));
    $('#cr-claude').addEventListener('click', () => act('claude'));
    $('#cr-save').addEventListener('click', () => act('save'));
    $('#cr-close').addEventListener('click', () => $('#dlg-crash').close());
    $('#st-go').addEventListener('click', stopGo);
    $('#st-resume').addEventListener('click', resume);
    $('#st-close').addEventListener('click', () => $('#dlg-stop').close());
    $('#gh-go').addEventListener('click', helpGo);
    $('#gh-close').addEventListener('click', () => $('#dlg-help').close());
  }
  window.CCRecoveryUI = { crash, stop, help, wire };
})();
