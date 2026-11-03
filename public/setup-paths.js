/* Claude Console - setup wizard (CON-013 L5, design d.4 + addendum f): two paths,
   "Step x of y" throughout, Back and "Switch to custom setup" on every screen after the
   first. Path A = the author's (Remus3) current settings, path B = custom. Both
   collect only the inputs they need, then the review / liability step, the dry-run
   preview, apply and a verification summary. Nothing is written before Apply.
   The wizard is a full-page view, never a modal (VERIFY ruling on UX-F23, operator
   agreed 2026-10-19): it covers the console window, the rest of the page is hidden from
   view and from Tab while it shows, and "Skip for now" leaves it at any step before
   Apply. The pure helpers at the top are also loaded by tests/profile-ui-client.test.js.
   ASCII only. */

(function (root) {
  'use strict';
  const TITLES = {
    path: 'How do you want to set up?',
    update: 'Update your setup',
    glance: 'Modules at a glance',
    modules: 'Choose modules',
    env: 'Environment variables',
    keys: 'API keys',
    account: 'Second account and proxy',
    details: 'Your details',
    tasks: 'Scheduled tasks',
    review: 'Before you enable anything',
    preview: 'Preview (dry run)',
    apply: 'Apply and verify',
  };
  const PROXY_VAR = 'headless_base_url';
  const PROXY_ENV = 'CLAUDE_HEADLESS_BASE_URL';
  // The env step's cards: the proxy variable belongs to the account step (R1-7).
  function envCards(inputs) { return ((inputs && inputs.env) || []).filter((e) => !e.secret && e.name !== PROXY_ENV); }
  // The steps a path needs, from what its selection asks for. y = steps.length is fixed
  // when path A is chosen or path B's modules are confirmed; skipping an input later
  // never changes it (the step stays, its dependants show as off). Only a change of
  // target on those two steps moves y, since a target decides what applies at all.
  // o.accounts: how many accounts are configured. The account step needs two (R1-7).
  // A value that already has one asks nothing, so it alone does not make a details step.
  function stepsFor(pathName, inputs, o) {
    o = o || {};
    const first = o.update ? 'update' : 'path';
    if (o.update && !pathName) return [first, 'review', 'preview', 'apply'];
    const s = [first];
    if (pathName === 'custom') s.push('modules');
    else s.push('glance');
    const i = inputs || {};
    if (envCards(i).length) s.push('env');
    if ((i.secrets || []).length) s.push('keys');
    if (o.accounts >= 2 && ((i.account && i.account.needed) || (i.variables || []).some((v) => v.name === PROXY_VAR))) s.push('account');
    if ((i.variables || []).some((v) => v.name !== PROXY_VAR && (v.value === null || v.value === undefined))) s.push('details');
    if ((i.tasks || []).length) s.push('tasks');
    s.push('review', 'preview', 'apply');
    return s;
  }
  function label(steps, idx) { return 'Step ' + (idx + 1) + ' of ' + steps.length + ' - ' + (TITLES[steps[idx]] || steps[idx]); }
  // The words a screen reader gets for each rail item (UX-F2): step name + state. The rail
  // has no visual row: "Step x of y" says it, and tooltips do not reach a phone (R1-26).
  function railWord(steps, idx, i) { return (TITLES[steps[i]] || steps[i]) + ', ' + (i < idx ? 'done' : i === idx ? 'current' : 'to do'); }
  // Path card marker: a chosen / not chosen mark outside the state vocabulary (UX-F1).
  function cardMark(chosen) { return chosen ? '(o) ' : '( ) '; }
  // o.labels: {variable name: plain label}; o.oneAccount: the proxy was never asked (R1-7).
  function inputLabel(n, o) {
    o = o || {};
    const s = String(n);
    if (s.startsWith('secret:')) return 'API key ' + s.slice(7);
    if (s.startsWith('env:')) return s.slice(4);
    if (s.startsWith('task:')) return 'task ' + s.slice(5);
    if (s === PROXY_VAR) return o.oneAccount ? 'a second Claude account' : 'proxy URL';
    return (o.labels && o.labels[s]) || s;
  }
  function offLine(x, o) { return '[ ] off - needs ' + (x.needs || []).map((n) => inputLabel(n, o)).join(', ') + ' - ' + (x.title || x.item); }
  // The Stays off box: what a group of items needs is said once, then their titles (N2).
  function offLines(rows, o) {
    const groups = new Map();
    for (const x of rows || []) {
      const k = (x.needs || []).join('\n');
      if (!groups.has(k)) groups.set(k, { needs: x.needs, titles: [] });
      groups.get(k).titles.push(x.title || x.item);
    }
    return [...groups.values()].map((g) => offLine({ needs: g.needs, title: g.titles.join(', ') }, o));
  }
  // A task question not answered yet is not a skip: those rows wait for the answer (R1-8).
  function offRows(offNeeds, pathName, tasksYes) {
    const waiting = pathName !== 'custom' && tasksYes === null;
    return (offNeeds || []).filter((x) => !(waiting && (x.needs || []).length && x.needs.every((n) => String(n).startsWith('task:'))));
  }
  // The inputs that start skipped, once each: hardware most people lack (start_skipped),
  // and the proxy on a one-account machine. seen keeps a later untick from being undone.
  function startSkips(inputs, accounts, seen) {
    const i = inputs || {};
    const out = [];
    const add = (k) => { if (!seen.has(k)) { seen.add(k); out.push(k); } };
    for (const v of i.variables || []) if (v.startSkipped) add(v.name);
    if (!(accounts >= 2) && ((i.account && i.account.needed) || (i.variables || []).some((v) => v.name === PROXY_VAR))) add(PROXY_VAR);
    return out;
  }
  // The preset card's text (R3-7), its numbers from the preset itself.
  function presetCardSub(items, tasks) {
    const n = (tasks || []).length;
    const word = (tasks || []).every((t) => t.hidden) ? 'hidden ' : '';
    return "The author's full setup: " + items + ' items. It changes your Claude settings, adds rules, hooks and scripts to the project you pick'
      + (n ? ', and can register ' + n + ' ' + word + 'scheduled task' + (n === 1 ? '' : 's') : '')
      + '. It suits people who already run Claude Code daily. The next screens list everything; nothing is written until Apply.';
  }
  // FB-1021: an item the preset itself leaves off, with the reason (glance step).
  function presetOffLine(x) { return '[ ] off - ' + (x.why || 'off in this preset') + ' - ' + (x.title || x.item); }
  // Skip keys an input card adds: env:NAME, secret:ref, a variable name, task:NAME.
  function skipKey(kind, name) { return kind === 'env' ? 'env:' + name : kind === 'secret' ? 'secret:' + name : kind === 'task' ? 'task:' + name : name; }
  function validValue(v, value) {
    if (value === undefined || value === null || value === '') return false;
    if (v && v.pattern) { try { return new RegExp(v.pattern).test(String(value)); } catch (e) { return true; } }
    return true;
  }
  // A plain-English hint for a value that does not match (UX-F20); never the regex.
  function hintFor(v) {
    v = v || {};
    if (v.hint) return String(v.hint);
    if (v.name === PROXY_VAR || v.type === 'url') return 'must look like http://127.0.0.1:8080 (this computer, a port number)';
    if (v.name === 'repo_code' || v.type === 'code') return 'must be 2 to 6 capital letters or digits, starting with a letter, for example SA';
    if (v.type === 'git-ident') return 'must look like Your Name <you@example.com>';
    if (v.type === 'relpath') return 'must be a folder inside the project, for example docs';
    if (v.type === 'int') return 'must be a whole number';
    return 'is not in the form this value needs';
  }
  // Path A tasks: one grouped yes / no. Path B: one unticked consent per task.
  function taskSkips(pathName, tasks, groupedYes, consent) {
    const out = [];
    for (const t of tasks || []) {
      const yes = pathName === 'preset' ? groupedYes === true : !!(consent && consent[t.name]);
      if (!yes) out.push(skipKey('task', t.name));
    }
    return out;
  }
  // What Apply sends for the high-risk items (R1-3, R3-1). Path B: the phrases as typed, the
  // server checks them. Path A: the Preview tick, and only it, stands for the high-risk items
  // that take a grouped yes; a needsAck id is never sent, so the engine refuses it. o.seen:
  // the ids the human was shown (another account's plan may hold more; those stay refused).
  function applyConsent(plan, pathName, o) {
    o = o || {};
    const ids = ((plan && plan.highRisk) || []).map((x) => x.id);
    const seen = o.seen ? new Set(o.seen) : null;
    if (pathName === 'custom') {
      const acks = ids.filter((id) => !seen || seen.has(id));
      const typed = {};
      for (const id of acks) if (o.typed && o.typed[id] !== undefined) typed[id] = o.typed[id];
      return { groupedConsent: false, acks, typed };
    }
    const need = new Set((plan && plan.needsAck) || []);
    const yes = o.tick === true && (!seen || ids.every((id) => seen.has(id)));
    return { groupedConsent: yes || !ids.length, acks: yes ? ids.filter((id) => !need.has(id)) : [], typed: {} };
  }
  // Preview's Next. Path A with a needsAck id stays shut: this path takes no typed phrase.
  function nextBlocked(plan, pathName, o) {
    o = o || {};
    if (plan.empty || plan.verdict.code !== 0 || (plan.missing && plan.missing.length > 0)) return true;
    if (pathName === 'custom') return !o.acksDone;
    if ((plan.needsAck || []).length) return true;
    return (plan.highRisk || []).length > 0 && o.tick !== true;
  }
  // Why Preview's Apply is shut, in one line beside the button (N1); '' when it is open.
  function blockedWhy(plan, pathName, o) {
    if (!nextBlocked(plan, pathName, o)) return '';
    if (plan.missing && plan.missing.length) return 'Fill in or skip the value above to continue.';
    if (plan.verdict.code !== 0) return 'This plan was refused; the reason is above.';
    if (plan.empty) return 'Nothing to apply: this target already matches. Skip for now closes setup.';
    if (pathName === 'custom') return 'Type the apply phrase beside each high-risk item above to continue.';
    if ((plan.needsAck || []).length) return 'This path cannot apply that item; the way out is above.';
    return 'Tick "Yes, apply them" above to continue.';
  }
  function typedOnlyLine(plan) {
    const hr = (plan && plan.highRisk) || [];
    const names = ((plan && plan.needsAck) || []).map((id) => { const x = hr.find((y) => y.id === id); return x && x.title ? x.title : id; });
    return names.join(', ') + ' needs its own typed yes, which this path does not ask. Use Switch to custom setup to type it, or to turn it off.';
  }
  // The result line (R1-10 step 3). left: rows left out because no project was picked.
  function doneLine(plan, left) {
    return plan && plan.target && plan.target.user && left > 0
      ? '[+] Your Claude settings are set up. Project modules were left out; run setup again on a project to add them. Restart Claude panes to load this.'
      : '[+] Setup complete - restart Claude panes to load it';
  }
  const api = { TITLES, stepsFor, envCards, label, railWord, cardMark, inputLabel, offLine, offLines, offRows, startSkips, presetCardSub, presetOffLine, skipKey, validValue, hintFor, taskSkips, applyConsent, nextBlocked, blockedWhy, typedOnlyLine, doneLine, PROXY_VAR };
  if (typeof module === 'object' && module.exports) module.exports.Setup = api;
  else root.CCSetup = api;
})(this);

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const SP = window.CCSetup;
  const PF = window.CCProfile;
  const U = window.CCUI;
  const { h, api } = U;
  const $ = (s) => document.querySelector(s);
  const ARM_MS = 6000;
  let W = null;
  let st = null;

  function fresh(o) {
    return { update: !!(o && o.update), offer: null, path: null, steps: null, idx: 0, base: null, sel: null, offNeeds: [], presetOff: [], draft: null, skipped: new Set(), values: {}, inputs: null,
      target: 'user', tick: false, tasksYes: null, consent: {}, plan: null, typed: {}, modIdx: 0, saved: {}, result: null, states: {}, baseStates: {}, useSaved: false,
      applying: false, arm: null, shown: null, opener: null, accounts: 0, seeded: new Set(), card: { items: 0, tasks: [] }, hrTick: false, missSeen: new Map(), why: '' };
  }

  // ---- the page: shown over the console, the rest hidden from view and Tab (CSS
  // body.wz-on), focus returned to the opener when it closes.
  function isOpen() { const p = $('#wz-page'); return !!p && !p.hidden; }
  function showPage() {
    const p = $('#wz-page');
    p.hidden = false;
    document.body.classList.add('wz-on');
    p.scrollTop = 0;
  }
  function closeWizard() {
    if (!W || W.applying) return;
    clearArm();
    const p = $('#wz-page');
    if (!p || p.hidden) return;
    p.hidden = true;
    document.body.classList.remove('wz-on');
    // closing records the offer dismissal (shown once at install, once per update)
    api('POST', '/api/profile/offer/dismiss', {}).catch(() => {});
    const o = W.opener;
    W.opener = null;
    const back = o && o.isConnected && o.offsetParent ? o : $('#btn-more');
    if (back) back.focus();
  }

  async function openSetup(o) {
    o = o || {};
    W = fresh(o);
    W.opener = o.opener || (typeof window.__ccTakeReturn === 'function' ? window.__ccTakeReturn() : null) || document.activeElement;
    showPage();
    setChrome(true);
    $('#wz-step').textContent = 'Setup';
    $('#wz-rail').textContent = '';
    $('#wz-body').textContent = 'Loading the setup profile...';
    U.note($('#wz-note'), '');
    try { st = await api('GET', '/api/profile'); } catch (e) { st = { available: false, reason: e.message }; }
    if (!st.available) { noProfile(st.reason || 'No setup profile in this build.'); return; }
    // The review tick is asked again only when the profile's major version changes.
    const major = (v) => String(v || '').split('.')[0];
    const ack = st.selection && st.selection.review_ack;
    W.tick = !!(ack && major(ack.version) === major(st.profile.version));
    try { W.accounts = ((await api('GET', '/api/info')).accounts || []).length; } catch (e) { W.accounts = 0; }
    if (W.update) { try { W.offer = await api('GET', '/api/profile/update'); } catch (e) { W.offer = { mode: 'none' }; } if (!W.offer || W.offer.mode === 'none') W.update = false; }
    // Before a path is chosen, y shows path A's count (the shorter, common case).
    try { await choosePresetBaseline(); } catch (e) { noProfile('The setup profile could not be read: ' + e.message); return; }
    W.steps = SP.stepsFor(W.update ? null : 'preset', W.inputs, { update: W.update, accounts: W.accounts });
    W.path = null;
    render();
  }

  // No profile: only the reason and the way out (UX-F4).
  function setChrome(on) {
    $('#wz-step').hidden = !on;
    $('#wz-rail').hidden = !on;
    for (const id of ['#wz-back', '#wz-switch', '#wz-next']) $(id).hidden = !on;
  }
  function noProfile(reason) {
    setChrome(false);
    const body = $('#wz-body');
    body.textContent = '';
    body.appendChild(h('p', { role: 'status', text: '[-] ' + reason + ' The rest of the console works without it.' }));
    $('#wz-cancel').textContent = 'Close';
    $('#wz-cancel').focus();
  }

  async function choosePresetBaseline() {
    const name = presetName();
    const r = await api('POST', '/api/profile/wizard', { op: 'preset', name });
    setBase(r);
    W.presetOff = r.presetOff || [];
    // The card states the whole preset, whatever the target (no target = no filter).
    W.card = { items: r.on, tasks: (await api('POST', '/api/profile/wizard', { op: 'inputs', selection: W.base })).tasks };
    W.inputs = await inputsFor(W.base);
  }
  function inputsFor(selection) { return api('POST', '/api/profile/wizard', { op: 'inputs', selection, target: U.targetOf(W.target) }); }
  function presetName() { return st.presets.includes('remus3') ? 'remus3' : st.presets[0]; }
  function presetTitle(n) { return (st.presetTitles && st.presetTitles[n]) || n; }

  // base = the chosen selection (preset, or custom toggles); sel = base with the skipped
  // inputs' dependants turned off. Each answer carries its effective item states.
  function setBase(r) { W.base = r.selection; W.baseStates = r.states || {}; W.sel = r.selection; W.states = r.states || {}; W.offNeeds = r.offNeeds || []; }
  async function recomputeSel() {
    const r = await api('POST', '/api/profile/wizard', { op: 'skip', selection: W.base, skipped: [...W.skipped] });
    W.sel = r.selection;
    W.states = r.states || {};
    W.offNeeds = r.offNeeds || [];
  }

  function cur() { return W && W.steps ? W.steps[W.idx] : null; }

  // The "click again to switch back" arm: cleared by any navigation and after a few
  // seconds without the second click (UX-F6).
  function clearArm() {
    if (!W || !W.arm) return;
    clearTimeout(W.arm.timer);
    W.arm = null;
    U.note($('#wz-note'), W.why);
  }
  // The reason a button is shut stays in the footer beside it, unless the switch-back arm
  // is talking. Unchanged text is not set again: the note is an alert region.
  function setWhy(text) {
    W.why = text;
    const n = $('#wz-note');
    if (!W.arm && n.textContent !== text) U.note(n, text);
  }

  // A new step moves focus to its heading (UX-F3); a re-render of the same step keeps
  // focus on the control's replacement and the scroll where it was (UX-B1, UX-F8).
  function render() {
    const step = cur();
    if (!step) return;
    const key = W.idx + ':' + step;
    const moved = W.shown !== key;
    const first = W.shown === null;
    W.shown = key;
    if (moved) clearArm();
    const page = $('#wz-page');
    const run = () => build(step);
    if (!moved) return U.keep(page, [page, $('#wz-body')], run);
    const r = run();
    return Promise.resolve(r).then(() => {
      page.scrollTop = 0;
      const card = step === 'path' && first ? $('.wz-card') : null;
      (card || $('#wz-step')).focus({ preventScroll: true });
    });
  }

  function build(step) {
    $('#wz-step').textContent = SP.label(W.steps, W.idx);
    const rl = $('#wz-rail');
    rl.textContent = '';
    W.steps.forEach((s, i) => rl.appendChild(h('li', { 'aria-current': i === W.idx ? 'step' : null }, h('span.sr-only', { text: SP.railWord(W.steps, W.idx, i) }))));
    W.why = '';
    if (!W.arm) U.note($('#wz-note'), '');
    const body = $('#wz-body');
    body.textContent = '';
    const done = step === 'apply' && !!W.result;
    $('#wz-back').disabled = W.idx === 0 || done || W.applying;
    const sw = $('#wz-switch');
    sw.textContent = W.path === 'custom' ? "Use Remus3's settings instead" : 'Switch to custom setup';
    // on the path step, "Switch" would do the same as picking card B (UX-N19)
    sw.hidden = step === 'path';
    sw.disabled = done || W.applying;
    const cancel = $('#wz-cancel');
    cancel.textContent = done ? 'Close' : 'Skip for now';
    cancel.disabled = W.applying;
    const next = $('#wz-next');
    next.textContent = step === 'preview' ? 'Apply' : step === 'apply' ? 'Done' : step === 'modules' ? 'Done with modules' : 'Next';
    next.disabled = false;
    return (VIEWS[step] || (() => body.appendChild(h('p', { text: step }))))(body, next);
  }

  // "What this does" on every step, and what skipping the step means (design d.4, UX-F24).
  function whatThis(body, text, skipStep) {
    body.appendChild(h('p.wz-what', h('b', { text: 'What this does: ' }), text));
    if (skipStep) body.appendChild(h('p.small.muted.wz-skipline', { text: 'Skip this step: ' + skipStep }));
  }
  // One "Skip" label per card, next to its one-line consequence (UX-F24).
  function skipRow(cb, consequence) {
    return h('div.wz-skiprow', h('label.check.small', cb, 'Skip'), h('span.small.muted', { text: '- ' + consequence }));
  }
  // Sits below the step's content, so showing it never moves anything above it (UX-N13).
  function offList(body) {
    const rows = SP.offRows(W.offNeeds, W.path, W.tasksYes);
    if (!rows.length) return;
    const labels = {};
    for (const v of st.variables || []) if (v.label) labels[v.name] = v.label;
    for (const m of W.missSeen.values()) if (m.label) labels[m.name] = m.label;
    for (const v of (W.inputs && W.inputs.variables) || []) if (v.label) labels[v.name] = v.label;
    const box = h('div.wz-off', h('div.small', { text: 'Stays off:' }));
    for (const line of SP.offLines(rows, { labels, oneAccount: !(W.accounts >= 2) })) box.appendChild(h('div.mono.small', { text: line }));
    body.appendChild(box);
  }
  // The target decides what the path asks. On path A it re-reads the inputs at once, so y
  // and the rows below are right; path B re-reads them when its modules are confirmed.
  async function setTarget(v) {
    if (v === W.target) return;
    W.target = v;
    if (W.path === 'custom') return;
    const next = $('#wz-next');
    next.disabled = true;
    try { await fixSteps(); render(); } catch (e) { next.disabled = false; U.note($('#wz-note'), '[x] ' + e.message, true); }
  }
  function targetRow(body) {
    const sel = U.targetSelect('wz-target', setTarget, { value: W.target });
    body.appendChild(h('label.wz-target', 'Apply to (choose one) ', sel));
    body.appendChild(h('p.small.muted', { text: 'This user: only your Claude settings change. The rules, hooks and safety floors go into a project, so they are skipped here. A project: settings, rules, hooks and floors all apply.' }));
  }
  function itemTitles(ids) {
    const t = {};
    for (const m of st.modules) for (const it of m.items) t[it.id] = it.title;
    return (ids || []).map((id) => t[id] || id).join(', ');
  }
  // Enter in a valid field moves on, like Next (UX-N15).
  function enterNext(inp, ok) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && ok()) { e.preventDefault(); onNext(); } });
  }
  async function reskip(k, on) { if (on) W.skipped.add(k); else W.skipped.delete(k); await recomputeSel(); render(); }

  const VIEWS = {
    path(body, next) {
      body.appendChild(h('p.wz-lead', { text: 'Optional setup. Claude Console works without it. Skip for now opens the console; you can run this later from the ... menu, Run setup.' }));
      whatThis(body, 'Pick how much you want to decide yourself. Nothing is written until the Apply step, and everything can be reverted later.');
      const grp = h('div.wz-cards', { role: 'radiogroup', 'aria-label': 'Setup path' });
      const pick = (id) => {
        W.path = id;
        for (const b of grp.querySelectorAll('.wz-card')) {
          const on = b.dataset.path === id;
          b.setAttribute('aria-checked', on ? 'true' : 'false');
          b.querySelector('.wz-ctitle').textContent = SP.cardMark(on) + b.dataset.title;
        }
        next.disabled = false;
      };
      const card = (id, title, sub) => h('button.wz-card', { type: 'button', role: 'radio', 'aria-checked': W.path === id ? 'true' : 'false', dataset: { path: id, title },
        on: { click: () => pick(id) } },
      h('span.wz-ctitle', { text: SP.cardMark(W.path === id) + title }), h('span.small.muted', { text: sub }));
      grp.appendChild(card('preset', "Use Remus3's current settings (for experienced users)", SP.presetCardSub(W.card.items, W.card.tasks)));
      grp.appendChild(card('custom', 'Custom setup (best if you are new)', 'Starts from the recommended set. Choose each module and review every change'));
      U.arrowNav(grp, '.wz-card');
      body.appendChild(grp);
      next.disabled = !W.path;
    },
    update(body) {
      const o = W.offer;
      whatThis(body, o.mode === 'preset' ? 'You use the author\'s settings unchanged, so you can move to the latest version in one step. The list shows every change.' : 'You changed the author\'s settings. Your choices win; the new version\'s changes are merged in and anything both sides changed is listed, with yours kept.',
        '"Skip for now" keeps your current setup; the update is offered again from Run setup.');
      body.appendChild(h('p.wz-ctitle', { text: o.mode === 'preset' ? "Update to Remus3's latest settings" : 'Merge the latest settings into your setup' }));
      body.appendChild(h('p.small', { text: o.line }));
      const list = h('div.wz-diff');
      for (const d of o.diff || []) list.appendChild(h('div.mono.small', { text: (d.change === 'added' ? '[+] ' : d.change === 'removed' ? '[-] ' : '[~] ') + d.change + ' ' + d.item + (d.to ? ' (' + d.from + ' -> ' + d.to + ')' : '') }));
      for (const c of o.conflicts || []) list.appendChild(h('div.mono.small', { text: '[-] ' + c.item + ': yours ' + c.mine + ', new ' + c.theirs + ' - kept yours' }));
      body.appendChild(list);
    },
    glance(body) {
      whatThis(body, 'These are the modules the author runs. Each line says what it does; open one to see its items (read-only here). Use "Switch to custom setup" to change any of them.');
      body.appendChild(h('p.small.muted.wz-skipline', { text: "Choose where this applies. Next keeps the author's modules as listed." }));
      targetRow(body);
      const on = (m) => m.items.filter((it) => it.locked || W.states[it.id] === 'on').length;
      const listBox = h('div#wz-glance', { hidden: true });
      const tog = h('button.small#wz-showlist', { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'wz-glance', text: st.modules.length + ' modules - Show list' });
      tog.addEventListener('click', () => { listBox.hidden = !listBox.hidden; tog.setAttribute('aria-expanded', listBox.hidden ? 'false' : 'true'); tog.textContent = st.modules.length + ' modules - ' + (listBox.hidden ? 'Show list' : 'Hide list'); });
      for (const m of st.modules) {
        const n = on(m);
        const det = h('details.wz-mod');
        det.appendChild(h('summary.mono', { text: PF.moduleGlyph({ locked: m.locked, on: n, total: m.total }) + ' ' + String(m.order).padStart(2) + ' ' + m.title + ' - ' + (m.locked ? 'always on' : n + ' of ' + m.total + ' on') + ' - ' + m.summary }));
        for (const it of m.items) det.appendChild(h('div.small.mono', { text: (it.locked || W.states[it.id] === 'on' ? '[+] on  ' : '[ ] off ') + it.title + (it.risk === 'high' ? '  ! high risk' : '') }));
        listBox.appendChild(det);
      }
      body.appendChild(tog);
      body.appendChild(listBox);
      // FB-1021: what the preset itself leaves off, and why, before anything is applied
      const po = h('details.wz-off#wz-presetoff', h('summary.small', { text: W.presetOff.length + ' item(s) off in this preset - why' }));
      for (const x of W.presetOff) po.appendChild(h('div.mono.small', { text: SP.presetOffLine(x) }));
      if (W.presetOff.length) body.appendChild(po);
      offList(body);
    },
    modules(body) {
      whatThis(body, 'Go through the modules one by one. Turn a module or single items on or off; when a change pulls others in, the row asks first. Nothing is written yet.',
        'Next keeps the modules as they are now.');
      targetRow(body);
      const presets = h('div.wz-presets', h('span.small', { text: 'Start from: ' }));
      for (const name of st.presets) presets.appendChild(h('button.small', { type: 'button', text: presetTitle(name), dataset: { key: 'preset-' + name }, on: { click: async () => { const r = await api('POST', '/api/profile/wizard', { op: 'preset', name }); setBase(await api('POST', '/api/profile/wizard', { op: 'custom', selection: r.selection })); render(); } } }));
      body.appendChild(presets);
      const m = st.modules[W.modIdx];
      const pager = h('div.wz-pager',
        h('button.small', { type: 'button', text: 'Previous module', disabled: W.modIdx === 0, on: { click: () => { W.modIdx--; render(); } } }),
        h('span.mono#wz-modpos', { text: 'Module ' + (W.modIdx + 1) + ' of ' + st.modules.length }),
        h('button.small', { type: 'button', text: 'Next module', disabled: W.modIdx >= st.modules.length - 1, on: { click: () => { W.modIdx++; render(); } } }));
      body.appendChild(pager);
      const isOn = (it) => it.locked || W.baseStates[it.id] === 'on';
      const n = m.items.filter(isOn).length;
      const head = h('div.pf-mhead', h('h4', { text: m.order + ' ' + m.title }), m.locked ? null : h('span.pf-c.num', { text: 'on ' + n + ' of ' + m.total }));
      const mslot = h('div.pf-slot#wz-modslot', { role: 'status' });
      if (!m.locked) {
        const cb = h('input#wz-modtoggle', { type: 'checkbox', checked: n > 0, 'aria-label': 'Module ' + m.title + ' on or off' });
        cb.addEventListener('change', () => draftToggle(m.id, cb.checked, mslot, cb));
        head.appendChild(h('label.check', cb, h('span.pf-word', { text: n > 0 ? 'on' : 'off' })));
      } else head.appendChild(h('span.pf-lock', { text: 'always on - a safety rule you cannot turn off' }));
      body.appendChild(head);
      body.appendChild(mslot);
      body.appendChild(h('p.small', { text: m.summary }));
      if (m.why) body.appendChild(h('p.small.muted', { text: 'Why the author uses it: ' + m.why }));
      for (const it of m.items) {
        const row = h('div.pf-itop');
        const slot = h('div.pf-slot.wz-islot', { role: 'status', dataset: { slot: it.id } });
        if (it.locked) row.appendChild(h('span.pf-word.pf-always', { text: 'always on' }));
        else {
          const cb = h('input', { type: 'checkbox', checked: isOn(it), dataset: { item: it.id }, 'aria-label': it.title + ' on or off' });
          cb.addEventListener('change', () => draftToggle(it.id, cb.checked, slot, cb));
          row.appendChild(h('label.check.pf-sw', cb, h('span.pf-word', { text: isOn(it) ? 'on' : 'off' })));
        }
        row.appendChild(h('span.pf-t', { text: it.title }));
        row.appendChild(h('span.pf-risk' + (it.risk === 'high' ? '.pf-high' : ''), { text: PF.riskWord(it.risk) }));
        row.appendChild(h('span.small.muted', { text: PF.scopeWord(it) }));
        body.appendChild(row);
        body.appendChild(h('div.small.muted.wz-does', { text: it.does }));
        body.appendChild(slot);
      }
    },
    env(body) {
      whatThis(body, 'These user environment variables are what the modules you chose need. They are written for your Windows user only (new terminals see them).',
        'skip each variable below; the items that need it are turned off and listed.');
      for (const e of SP.envCards(W.inputs)) {
        const k = SP.skipKey('env', e.name);
        const skip = W.skipped.has(k);
        const card = h('div.wz-input', h('div.mono.wz-ctitle', { text: e.name + (e.proposed ? ' = ' + e.proposed : '') }),
          h('div.small', { text: 'Does: ' + e.does }), h('div.small.muted', { text: 'Why the author uses it: ' + e.why }),
          h('div.small', { text: 'Scope: your user. Now: ' + e.current + '. Used by: ' + itemTitles(e.items) }));
        const rg = h('div.wz-choice', { role: 'radiogroup', 'aria-label': e.name });
        for (const [v, t] of [['set', 'Set it'], ['skip', 'Skip']]) {
          const r = h('input', { type: 'radio', name: 'env-' + e.name, value: v, checked: (v === 'skip') === skip });
          r.addEventListener('change', () => reskip(k, v === 'skip'));
          rg.appendChild(h('label.check', r, t));
        }
        card.appendChild(rg);
        card.appendChild(h('div.small.muted', { text: 'Skip - the variable is not set and the items that use it stay off.' }));
        body.appendChild(card);
      }
      offList(body);
    },
    keys(body) {
      whatThis(body, 'Type an API key once. It is stored encrypted, so only your Windows user can read it, and it is never shown again: afterwards you only see "set (N chars)". Claude logins are never asked for here; they happen inside Claude itself.',
        'skip each key below; the items that need it are turned off and listed.');
      for (const s of W.inputs.secrets) {
        const k = SP.skipKey('secret', s.name);
        const disp = h('span.small.wz-disp', { text: W.saved[s.name] || s.display });
        const pw = h('input.wz-pw', { type: 'password', autocomplete: 'new-password', spellcheck: 'false', 'aria-label': 'API key ' + s.name });
        const saveKey = async () => {
          if (!pw.value) { U.note($('#wz-note'), 'Type the key first, or skip it.', true); return; }
          const r = await api('POST', '/api/profile/secret', { name: s.name, value: pw.value });
          pw.value = '';
          if (!r.ok) { U.note($('#wz-note'), '[x] ' + r.reason, true); return; }
          W.saved[s.name] = r.display;
          W.skipped.delete(k);
          await recomputeSel();
          render();
        };
        const save = h('button.small', { type: 'button', text: 'Save key', dataset: { key: 'save-' + s.name }, on: { click: saveKey } });
        pw.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pw.value) { e.preventDefault(); saveKey(); } });
        const sk = h('input', { type: 'checkbox', checked: W.skipped.has(k), 'aria-label': 'Skip ' + s.name });
        sk.addEventListener('change', () => reskip(k, sk.checked));
        body.appendChild(h('div.wz-input', h('div.mono.wz-ctitle', { text: s.name + ' (for ' + s.for + ')' }), h('div', pw, ' ', save, ' ', disp), skipRow(sk, 'no key is stored; ' + itemTitles(s.items) + ' stay off.')));
      }
      offList(body);
    },
    async account(body) {
      whatThis(body, 'Headless runs (Claude sessions the console starts in the background, with no window) can use a second Claude account through a proxy you run on this computer only. Pick the account and log in to it yourself in a console pane; then give the proxy URL. Deleting the CLAUDE_HEADLESS_BASE_URL user variable later stops every headless run.',
        'skip the proxy below; the headless items are turned off and listed.');
      let info = { accounts: [] };
      try { info = await api('GET', '/api/info'); } catch (e) { info = { accounts: [] }; }
      const acc = h('select#wz-acct', { 'aria-label': 'Second account' });
      for (const a of info.accounts || []) acc.appendChild(h('option', { value: a.id, text: a.label + (a.problem ? ' - ' + a.problem : '') }));
      // FB-1021: two accounts on one login / one label, or a missing dir, said before apply
      for (const a of (info.accounts || []).filter((x) => x.problem)) body.appendChild(h('p.small.pf-bad.wz-acctwarn', { text: '[x] ' + a.id + ': ' + a.problem }));
      const login = h('button.small', { type: 'button', text: 'Log in to it in a pane', on: { click: () => { if (window.__cc && window.__cc.openPane) window.__cc.openPane({ kind: 'claude', account: acc.value, title: 'login' }); } } });
      body.appendChild(h('div.wz-input', h('div.wz-ctitle', { text: 'Second account' }), h('div', acc, ' ', login), h('div.small.muted', { text: 'You log in inside Claude; this console never sees the login.' })));
      const v = (W.inputs.variables || []).find((x) => x.name === SP.PROXY_VAR) || { name: SP.PROXY_VAR, pattern: '^http:/' + '/127\\.0\\.0\\.1:[0-9]{2,5}/?$' /* split: a pattern, not a URL (no-egress scan) */, why: 'The address of the proxy you run on this computer.' };
      const url = h('input#wz-proxy.mono', { type: 'text', spellcheck: 'false', placeholder: 'http://127.0.0.1:<port>', value: W.values[SP.PROXY_VAR] || '', 'aria-label': 'Proxy URL' });
      const line = h('span.small.wz-val', { role: 'status' });
      const sk = h('input', { type: 'checkbox', checked: W.skipped.has(SP.PROXY_VAR), 'aria-label': 'Skip the proxy' });
      url.addEventListener('input', () => { const ok = SP.validValue(v, url.value); U.note(line, url.value ? (ok ? '[+] an address on this computer' : '[x] ' + SP.hintFor(v)) : '', !ok); if (ok) W.values[SP.PROXY_VAR] = url.value; else delete W.values[SP.PROXY_VAR]; });
      enterNext(url, () => SP.validValue(v, url.value));
      sk.addEventListener('change', () => reskip(SP.PROXY_VAR, sk.checked));
      body.appendChild(h('div.wz-input', h('div.wz-ctitle', { text: 'Proxy URL' }), h('div.small.muted', { text: v.why || '' }), h('div', url, ' ', line), skipRow(sk, 'no headless runs for now; the headless items stay off.')));
      offList(body);
    },
    details(body) {
      const askGit = W.inputs.variables.some((x) => x.name === 'operator_ident');
      whatThis(body, 'A few values the chosen modules write into files.' + (askGit ? ' Your git identity is stored in this project\'s local git config only, so commits carry your name and never an AI co-author line.' : ''),
        'skip each value below; the items that use it are turned off and listed.');
      for (const v of W.inputs.variables.filter((x) => x.name !== SP.PROXY_VAR)) {
        const name = v.label || v.name;
        const inp = h('input.mono', { type: 'text', spellcheck: 'false', value: W.values[v.name] || v.value || '', 'aria-label': name, dataset: { var: v.name } });
        const line = h('span.small.wz-val', { role: 'status' });
        const sk = h('input', { type: 'checkbox', checked: W.skipped.has(v.name), 'aria-label': 'Skip ' + name });
        const upd = () => { const ok = SP.validValue(v, inp.value); U.note(line, inp.value ? (ok ? '[+]' : '[x] ' + SP.hintFor(v)) : '', !ok); if (ok) W.values[v.name] = inp.value; else delete W.values[v.name]; };
        inp.addEventListener('input', upd);
        enterNext(inp, () => SP.validValue(v, inp.value));
        if (inp.value) upd();
        sk.addEventListener('change', () => reskip(v.name, sk.checked));
        body.appendChild(h('div.wz-input', { title: 'Used by: ' + itemTitles(v.items) }, h(v.label ? 'div.wz-ctitle' : 'div.mono.wz-ctitle', { text: name }), v.why ? h('div.small.muted', { text: v.why }) : null, h('div', inp, ' ', line), skipRow(sk, 'the items that use it stay off.')));
      }
      offList(body);
    },
    tasks(body) {
      const preset = W.path !== 'custom';
      whatThis(body, preset ? 'The author\'s setup registers these scheduled tasks for your user. Say yes or no for all of them at once.' : 'Each scheduled task needs its own yes: tick the ones you want. Unticked tasks are not registered.',
        preset ? 'answer No and no task is registered; the task-backed items are turned off and listed.' : 'leave every task unticked; the task-backed items are turned off and listed.');
      if (preset) body.appendChild(h('p.small', { text: 'Want only some of them? Use Switch to custom setup.' }));
      for (const t of W.inputs.tasks) {
        const card = h('div.wz-input', h('div.mono.wz-ctitle', { text: t.name }),
          h('div.small', { text: 'When: ' + (t.trigger || 'see the task file') + (t.limitMinutes ? '; stops after ' + t.limitMinutes + ' min' : '') + (t.hidden ? '; runs hidden' : '') }),
          h('div.small', { text: 'Runs: ' + t.does }),
          h('div.small', { text: 'May delete: ' + (t.deletes || 'not stated') }),
          h('div.small.muted', { text: 'Why the author uses it: ' + t.why }));
        if (!preset) {
          const cb = h('input', { type: 'checkbox', checked: !!W.consent[t.name], dataset: { task: t.name }, 'aria-label': 'Register ' + t.name });
          cb.addEventListener('change', async () => { W.consent[t.name] = cb.checked; await applyTaskSkips(); render(); });
          card.appendChild(h('label.check', cb, 'Yes, register this task'));
        }
        body.appendChild(card);
      }
      if (preset) {
        const rg = h('div.wz-choice#wz-taskall', { role: 'radiogroup', 'aria-label': 'All scheduled tasks' });
        for (const [v, t] of [['yes', 'Yes, register all of them'], ['no', 'No, none of them']]) {
          const r = h('input', { type: 'radio', name: 'tasks-all', value: v, checked: W.tasksYes === (v === 'yes') });
          r.addEventListener('change', async () => { W.tasksYes = v === 'yes'; await applyTaskSkips(); render(); });
          rg.appendChild(h('label.check', r, t));
        }
        body.appendChild(rg);
      }
      offList(body);
    },
    review(body, next) {
      const r = st.review;
      body.appendChild(h('p.wz-lead', { text: r.lead }));
      body.appendChild(h('p.small', { text: r.licence }));
      body.appendChild(h('h4', { text: r.safeguards_heading }));
      const ul = h('ul.wz-safe');
      for (const s of r.safeguards) ul.appendChild(h('li', h('span.mono', { text: s.glyph + ' ' }), h('b', { text: s.word }), ' - ' + s.text));
      body.appendChild(ul);
      const cb = h('input#wz-tick', { type: 'checkbox', checked: W.tick });
      cb.addEventListener('change', () => { W.tick = cb.checked; next.disabled = !W.tick; });
      body.appendChild(h('label.check.wz-tickrow', cb, r.checkbox));
      body.appendChild(h('p.small.muted.wz-skipline', { text: 'This step cannot be skipped: the preview and Apply need the tick. "Skip for now" leaves setup without writing anything.' }));
      next.disabled = !W.tick;
    },
    async preview(body, next) {
      whatThis(body, 'This is everything Apply would write, per module. Open a module to see each file, settings key, variable and task. Nothing is written yet.');
      next.disabled = true;
      const draft = W.useSaved ? null : Object.assign({}, W.sel, { review_ack: { version: st.profile.version, at: new Date().toISOString() } });
      W.draft = draft;
      let plan;
      try { plan = await api('POST', '/api/profile/plan', { target: U.targetOf(W.target), draft, values: W.values }); } catch (e) { body.appendChild(h('p.pf-bad', { text: '[x] ' + e.message })); return; }
      W.plan = plan;
      W.typed = {};
      // A new plan can list other high-risk items, so the yes is asked again.
      W.hrTick = false;
      // a value the plan still needs is asked right here (UX-F25), then planned again; a
      // skip turns its items off (R1-4), and its tick stays here so it can be undone
      for (const m of plan.missing || []) W.missSeen.set(m.name, m);
      const skippedRows = [...W.missSeen.values()].filter((m) => W.skipped.has(m.name) && !(plan.missing || []).some((x) => x.name === m.name));
      if ((plan.missing && plan.missing.length) || skippedRows.length) {
        const card = U.missingCard(plan, (W.inputs && W.inputs.variables) || st.variables || [], W.values, (nv) => { Object.assign(W.values, nv); W.shown = null; render(); }, {
          titleOf: (id) => itemTitles([id]),
          onSkip: reskip,
          canSkip: (m) => !m.items.some((id) => st.modules.some((x) => x.locked && x.items.some((it) => it.id === id))),
          skippedRows,
        });
        card.id = 'wz-missing';
        body.appendChild(card);
      }
      const custom = W.path === 'custom';
      const upd = () => {
        const o = { acksDone: PF.acksComplete(plan.highRisk, W.typed), tick: W.hrTick };
        next.disabled = SP.nextBlocked(plan, W.path, o);
        setWhy(SP.blockedWhy(plan, W.path, o));
      };
      // The yes sits right under the high-risk list, above the per-module rows, so it is in
      // view on arrival (N1). A plan still missing a value asks it first: a new plan resets
      // the tick anyway.
      const consent = [];
      if (!custom && (plan.needsAck || []).length) consent.push(h('p.pf-bad#wz-typedonly', { role: 'alert', text: '[x] ' + SP.typedOnlyLine(plan) }));
      else if (!custom && plan.highRisk.length && !(plan.missing && plan.missing.length)) {
        const cb = h('input#wz-hrtick', { type: 'checkbox', checked: false });
        cb.addEventListener('change', () => { W.hrTick = cb.checked; upd(); });
        consent.push(h('label.check.wz-tickrow', cb, 'These high-risk items are part of this preset. Yes, apply them.'));
        consent.push(h('p.small.muted', { text: 'Your answer on scheduled tasks covers tasks only.' }));
      }
      body.appendChild(U.planView(plan, st.modules, { typedAcks: custom, typed: W.typed, onAck: upd, riskFirst: true, consent }));
      offList(body);
      upd();
    },
    async apply(body, next) {
      if (W.result) return showResult(body, next);
      next.disabled = true;
      // while the transaction runs, nothing can leave the page (UX-F5)
      W.applying = true;
      $('#wz-back').disabled = true;
      $('#wz-switch').disabled = true;
      $('#wz-cancel').disabled = true;
      body.appendChild(h('div.mono#wz-applying', { role: 'status', text: '[>] applying ' + W.plan.counts.new + ' new and ' + W.plan.counts.differs + ' changed item(s)...' }));
      let r;
      // Task consent in the engine's shape: path A one grouped yes that lists every task
      // shown, path B the per-task ticks (profile-tx taskConsentCheck).
      const planTasks = (W.plan.tasks || []).map((t) => t.name);
      const taskConsent = W.path !== 'custom'
        ? { mode: 'grouped', yes: W.tasksYes === true, listed: planTasks }
        : { mode: 'per-task', tasks: Object.fromEntries(planTasks.filter((n) => W.consent[n]).map((n) => [n, true])) };
      try { r = await api('POST', '/api/profile/apply', Object.assign({ planId: W.plan.planId, confirm: true, taskConsent }, SP.applyConsent(W.plan, W.path, { typed: W.typed, tick: W.hrTick }))); } catch (e) { r = { ok: false, line: e.message, verify: [] }; }
      if (r.ok) r.accounts = await applyOtherAccounts();
      W.result = r;
      W.applying = false;
      body.textContent = '';
      $('#wz-cancel').disabled = false;
      $('#wz-cancel').textContent = 'Close';
      showResult(body, next);
    },
  };

  function showResult(body, next) {
    const r = W.result;
    body.appendChild(h('p' + (r.ok ? '' : '.pf-bad'), { role: 'status', text: (r.ok ? '[+] ' : '[x] ') + PF.refusedLine(r.line, W.plan) }));
    if (r.verify && r.verify.length) body.appendChild(U.verifyRows(r.verify, U.report));
    for (const a of r.accounts || []) body.appendChild(h('p.small' + (a.ok ? '' : '.pf-bad'), { text: (a.ok ? '[+] ' : '[x] ') + a.label + ' settings: ' + a.line }));
    const bad = r.ok && (r.verify || []).some((v) => !v.ok && !v.skipped);
    if (r.ok && !bad) body.appendChild(h('p.wz-done', { text: SP.doneLine(W.plan, (W.plan.rows || []).filter(PF.leftOut).length) }));
    if (!r.ok) body.appendChild(h('button', { type: 'button', text: 'Report a problem', on: { click: () => U.report({ id: 'apply', reason: r.line }) } }));
    if (r.commit) body.appendChild(h('p.small.muted', { text: 'Nothing was committed. Suggested commit message: ' + r.commit.message }));
    next.disabled = false;
    $('#wz-back').disabled = true;
    $('#wz-switch').disabled = true;
    next.focus();
  }

  // FB-1021: user-scope settings also go to every other configured account with a config
  // dir of its own (files only; env, tasks and git are machine-wide and already applied).
  async function applyOtherAccounts() {
    const out = [];
    for (const a of st.accounts || []) {
      let x;
      try {
        const pl = await api('POST', '/api/profile/plan', { target: { account: a.id }, draft: W.draft, values: W.values });
        if (pl.empty) x = { ok: true, line: 'already up to date' };
        else if (pl.verdict.code !== 0) x = { ok: false, line: pl.verdict.line || 'refused' };
        else {
          const c = SP.applyConsent(pl, W.path, { typed: W.typed, tick: W.hrTick, seen: W.plan.highRisk.map((y) => y.id) });
          x = await api('POST', '/api/profile/apply', Object.assign({ planId: pl.planId, confirm: true, taskConsent: { mode: 'grouped', yes: false, listed: [] } }, c));
          x.line = PF.refusedLine(x.line, pl);
        }
      } catch (e) { x = { ok: false, line: e.message }; }
      out.push({ label: a.label, ok: !!x.ok, line: x.line });
    }
    return out;
  }

  async function applyTaskSkips() {
    for (const k of [...W.skipped]) if (k.startsWith('task:')) W.skipped.delete(k);
    for (const k of SP.taskSkips(W.path === 'custom' ? 'custom' : 'preset', W.inputs.tasks, W.tasksYes, W.consent)) W.skipped.add(k);
    await recomputeSel();
  }

  // A module / item toggle on path B. When it pulls others in (or out), the toggled
  // row's own slot asks first, as the browser does (design d.2, UX-F7).
  async function draftToggle(id, on, slot, cb, confirm) {
    let r;
    try { r = await api('POST', '/api/profile/wizard', { op: 'toggle', selection: W.base, id, on, ask: !confirm }); } catch (e) { if (cb) cb.checked = !on; U.note(slot, '[x] ' + e.message, true); return; }
    if (r.conflict) {
      if (cb) cb.checked = !on;
      U.note(slot, '[?] Clashes with "' + r.conflict[1].title + '": turn that one off first.');
      return;
    }
    if (r.needsConfirm) {
      if (cb) cb.checked = !on;
      slot.textContent = '';
      slot.classList.remove('pf-bad');
      slot.appendChild(h('span', { text: r.line + '. ' }));
      slot.appendChild(h('button.small', { type: 'button', text: on ? 'Turn on all' : 'Turn off all', on: { click: () => draftToggle(id, on, slot, null, true) } }));
      slot.appendChild(h('button.small', { type: 'button', text: 'Cancel', on: { click: () => { slot.textContent = ''; if (cb) cb.focus(); } } }));
      return;
    }
    setBase(r);
    await recomputeSel();
    await render();
    // the confirm buttons are gone: focus the switch that was toggled
    const a = document.activeElement;
    if (!a || a === document.body || !a.isConnected) {
      const t = document.querySelector('#wz-body input[data-item="' + CSS.escape(id) + '"]') || $('#wz-modtoggle');
      if (t) t.focus();
    }
  }

  // Leaving the path / modules step fixes y for the rest of the run.
  async function fixSteps() {
    W.inputs = await inputsFor(W.base);
    for (const k of SP.startSkips(W.inputs, W.accounts, W.seeded)) W.skipped.add(k);
    W.steps = SP.stepsFor(W.path, W.inputs, { accounts: W.accounts });
    // tasks start unconsented (path B) / unanswered (path A): no task registers without a yes
    await applyTaskSkips();
  }

  async function onNext() {
    try {
      const step = cur();
      if (!step || W.applying) return;
      if (step === 'path') {
        if (!W.path) return;
        // A fresh Custom starts from the recommended set, never the author's (R1-5). Back to
        // this step and Custom again keeps the toggles made so far; a Custom base never
        // carries over into the preset path.
        const hadCustom = W.base && W.base.path === 'custom';
        if (W.path === 'custom') {
          if (!hadCustom) {
            const r = await api('POST', '/api/profile/wizard', { op: 'preset', name: 'recommended' });
            setBase(await api('POST', '/api/profile/wizard', { op: 'custom', selection: r.selection }));
          }
          W.inputs = await inputsFor(W.base);
          W.steps = SP.stepsFor('custom', W.inputs, { accounts: W.accounts });
        } else {
          if (hadCustom) await choosePresetBaseline();
          await fixSteps();
        }
      } else if (step === 'update') {
        // the offer's selection is saved (selection only; no target is touched) and the
        // preview plans from it
        await api('POST', '/api/profile/update/take', { confirm: true });
        W.useSaved = true;
      } else if (step === 'modules') {
        await fixSteps();
      } else if (step === 'tasks' && W.path !== 'custom' && W.tasksYes === null) {
        U.note($('#wz-note'), 'Answer yes or no for the scheduled tasks.', true);
        return;
      } else if (step === 'review') {
        // FB-1021: record the choice now, so a run that stops before Apply leaves a trace
        if (!W.useSaved && W.sel) api('POST', '/api/profile/wizard', { op: 'record', selection: W.sel, path: W.path, skipped: [...W.skipped], values: W.values, tasks: W.tasksYes }).catch(() => {});
      } else if (step === 'apply') {
        closeWizard();
        if (window.CCSettingsProfile) window.CCSettingsProfile();
        return;
      }
      W.idx = Math.min(W.steps.length - 1, W.idx + 1);
      render();
    } catch (e) { U.note($('#wz-note'), '[x] ' + e.message, true); }
  }

  function onBack() {
    if (!W || W.idx === 0 || W.applying) return;
    W.idx--;
    render();
  }

  async function onSwitch() {
    if (!W || !W.steps || W.applying) return;
    try {
      if (W.path === 'custom') {
        const pre = await api('POST', '/api/profile/wizard', { op: 'preset', name: presetName() });
        const b = await api('POST', '/api/profile/wizard', { op: 'back', custom: W.base, preset: pre.selection });
        // nothing to lose: switch at once; else a second click within a few seconds
        if (b.dropped > 0 && !W.arm) {
          U.note($('#wz-note'), 'This drops your ' + b.dropped + ' custom change(s). Click again to switch.');
          W.arm = { timer: setTimeout(clearArm, ARM_MS) };
          return;
        }
        clearArm();
        W.path = 'preset';
        setBase(b);
        await fixSteps();
        W.idx = W.steps.indexOf('glance');
      } else {
        // Path B at its module step, every toggle pre-filled from the current baseline;
        // skipped-input dependants stay off. Unanswered task consent is not a skip: path B
        // asks it per task later.
        for (const k of [...W.skipped]) if (k.startsWith('task:')) W.skipped.delete(k);
        if (W.base) await recomputeSel();
        const c = await api('POST', '/api/profile/wizard', { op: 'custom', selection: W.sel || W.base });
        W.path = 'custom';
        W.update = false;
        W.useSaved = false;
        setBase(c);
        W.steps = SP.stepsFor('custom', W.inputs, { accounts: W.accounts });
        W.idx = W.steps.indexOf('modules');
        W.modIdx = 0;
      }
      render();
    } catch (e) { U.note($('#wz-note'), '[x] ' + e.message, true); }
  }

  function wire() {
    const page = $('#wz-page');
    if (!page) return;
    $('#wz-next').addEventListener('click', onNext);
    $('#wz-back').addEventListener('click', onBack);
    $('#wz-switch').addEventListener('click', onSwitch);
    $('#wz-cancel').addEventListener('click', closeWizard);
  }
  window.CCSetupUI = { open: openSetup, close: closeWizard, wire, get isOpen() { return isOpen(); }, get state() { return W; } };
})();
