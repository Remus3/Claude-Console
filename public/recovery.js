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
    if (r.action === 'claude') return '[+] opened a Claude pane with the report in its composer; review it and press Enter';
    if (r.action === 'save') return '[+] saved to ' + r.file;
    return '[+] done';
  }
  const api = { sizeText, actionLine };
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
  async function stop() {
    U.open($('#dlg-stop'));
    const line = $('#st-line');
    const go = $('#st-go');
    go.textContent = 'Stop everything';
    go.dataset.step = '1';
    go.disabled = true;
    $('#st-resume').disabled = true;
    U.note(line, 'Checking...');
    try { const r = await api('POST', '/api/recover/stop', {}); U.note(line, r.line); go.disabled = false; } catch (e) { U.note(line, '[x] ' + e.message, true); }
  }
  async function stopGo() {
    const go = $('#st-go');
    const line = $('#st-line');
    if (go.dataset.step === '1') { go.dataset.step = '2'; go.textContent = 'Yes, stop everything now'; U.note($('#st-confirm'), 'Second step: every console pane and headless run (background Claude session) ends, profile tasks are disabled and profile hooks (scripts Claude runs around its actions) go off. Resume undoes the tasks and hooks.'); go.focus(); return; }
    go.disabled = true;
    U.note($('#st-confirm'), '');
    try {
      const r = await api('POST', '/api/recover/stop', { confirm: true });
      U.note(line, (r.ok ? '[+] ' : '[x] ') + r.line, !r.ok);
      $('#st-resume').disabled = false;
    } catch (e) { U.note(line, '[x] ' + e.message, true); }
  }
  async function resume() {
    try { const r = await api('POST', '/api/recover/resume', { confirm: true }); U.note($('#st-line'), (r.ok ? '[+] ' : '[x] ') + r.line, !r.ok); } catch (e) { U.note($('#st-line'), '[x] ' + e.message, true); }
  }

  // ---- Get help in the browser: preview the prompt, then copy + open claude.ai
  // (gh-* ids: hp-* belongs to another panel, UX-B2)
  async function help() {
    U.open($('#dlg-help'));
    const ta = $('#gh-text');
    ta.value = 'Building the prompt...';
    $('#gh-go').disabled = true;
    U.note($('#gh-note'), '');
    try { const r = await api('POST', '/api/recover/prompt', {}); ta.value = r.text; $('#gh-size').textContent = RV.sizeText(r.bytes) + ', scrubbed: no names, paths, keys or values.'; $('#gh-go').disabled = false; } catch (e) { ta.value = ''; U.note($('#gh-note'), '[x] ' + e.message, true); }
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
