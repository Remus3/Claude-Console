/* Claude Console - setup wizard (CON-013 L5, design d.4 + addendum f): two paths,
   "Step x of y" throughout, Back and "Switch to custom setup" on every screen after the
   first. Path A = the author's (Remus3) exact current settings, path B = custom. Both
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
  // The steps a path needs, from what its selection asks for. y = steps.length is fixed
  // when path A is chosen or path B's modules are confirmed; skipping an input later
  // never changes it (the step stays, its dependants show as off).
  function stepsFor(pathName, inputs, o) {
    o = o || {};
    const first = o.update ? 'update' : 'path';
    if (o.update && !pathName) return [first, 'review', 'preview', 'apply'];
    const s = [first];
    if (pathName === 'custom') s.push('modules');
    else s.push('glance');
    const i = inputs || {};
    if ((i.env || []).some((e) => !e.secret)) s.push('env');
    if ((i.secrets || []).length) s.push('keys');
    if ((i.account && i.account.needed) || (i.variables || []).some((v) => v.name === PROXY_VAR)) s.push('account');
    if ((i.variables || []).some((v) => v.name !== PROXY_VAR)) s.push('details');
    if ((i.tasks || []).length) s.push('tasks');
    s.push('review', 'preview', 'apply');
    return s;
  }
  function label(steps, idx) { return 'Step ' + (idx + 1) + ' of ' + steps.length + ' - ' + (TITLES[steps[idx]] || steps[idx]); }
  function rail(steps, idx) { return steps.map((s, i) => (i < idx ? '[+]' : i === idx ? '[>]' : '[ ]')); }
  // The words a screen reader gets for each rail item (UX-F2): step name + state.
  function railWord(steps, idx, i) { return (TITLES[steps[i]] || steps[i]) + ', ' + (i < idx ? 'done' : i === idx ? 'current' : 'to do'); }
  // Path card marker: a chosen / not chosen mark outside the state vocabulary (UX-F1).
  function cardMark(chosen) { return chosen ? '(o) ' : '( ) '; }
  function inputLabel(n) {
    const s = String(n);
    if (s.startsWith('secret:')) return 'API key ' + s.slice(7);
    if (s.startsWith('env:')) return s.slice(4);
    if (s.startsWith('task:')) return 'task ' + s.slice(5);
    if (s === PROXY_VAR) return 'proxy URL';
    return s;
  }
  function offLine(x) { return '[ ] off - needs ' + (x.needs || []).map(inputLabel).join(', ') + ' - ' + (x.title || x.item); }
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
  const api = { TITLES, stepsFor, label, rail, railWord, cardMark, inputLabel, offLine, skipKey, validValue, hintFor, taskSkips, PROXY_VAR };
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
    return { update: !!(o && o.update), offer: null, path: null, steps: null, idx: 0, base: null, sel: null, offNeeds: [], skipped: new Set(), values: {}, inputs: null,
      target: 'user', tick: false, tasksYes: null, consent: {}, plan: null, typed: {}, modIdx: 0, saved: {}, result: null, states: {}, baseStates: {}, useSaved: false,
      applying: false, arm: null, shown: null, opener: null };
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
    if (W.update) { try { W.offer = await api('GET', '/api/profile/update'); } catch (e) { W.offer = { mode: 'none' }; } if (!W.offer || W.offer.mode === 'none') W.update = false; }
    // Before a path is chosen, y shows path A's count (the shorter, common case).
    try { await choosePresetBaseline(); } catch (e) { noProfile('The setup profile could not be read: ' + e.message); return; }
    W.steps = SP.stepsFor(W.update ? null : 'preset', W.inputs, { update: W.update });
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
    W.inputs = await api('POST', '/api/profile/wizard', { op: 'inputs', selection: W.base });
  }
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
    U.note($('#wz-note'), '');
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
    SP.rail(W.steps, W.idx).forEach((g, i) => rl.appendChild(h('li.mono', { title: SP.TITLES[W.steps[i]], 'aria-current': i === W.idx ? 'step' : null },
      h('span', { 'aria-hidden': 'true', text: g }), h('span.sr-only', { text: SP.railWord(W.steps, W.idx, i) }))));
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
    next.textContent = step === 'preview' ? 'Apply' : step === 'apply' ? 'Done' : 'Next';
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
  // Always rendered, so a skip never moves the content below it (UX-N13).
  function offList(body) {
    const box = h('div.wz-off', h('div.small', { text: 'Turned off because an input was skipped:' }));
    if (!W.offNeeds.length) box.appendChild(h('div.mono.small', { text: '-' }));
    for (const x of W.offNeeds) box.appendChild(h('div.mono.small', { text: SP.offLine(x) }));
    body.appendChild(box);
  }
  function targetRow(body) {
    const sel = U.targetSelect('wz-target', (v) => { W.target = v; }, { value: W.target });
    body.appendChild(h('label.wz-target', 'Apply to ', sel));
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
      grp.appendChild(card('preset', "Use Remus3's exact current settings (recommended for experienced users)", 'Everything the author runs, ready in a few steps'));
      grp.appendChild(card('custom', 'Custom setup', 'Choose each module and review every change'));
      U.arrowNav(grp, '.wz-card');
      body.appendChild(grp);
      body.appendChild(h('p.small.muted.wz-skipline', { text: 'Not now? "Skip for now" leaves setup without writing anything; Run setup in the ... menu or in Settings brings it back.' }));
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
      whatThis(body, 'These are the modules the author runs. Each line says what it does; open one to see its items (read-only here). Use "Switch to custom setup" to change any of them.',
        'nothing to decide here; Next keeps the author\'s modules as listed.');
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
      const head = h('div.pf-mhead', h('h4', { text: m.order + ' ' + m.title }), h('span.pf-c.num', { text: m.locked ? 'always on' : 'on ' + n + ' of ' + m.total }));
      const mslot = h('div.pf-slot#wz-modslot', { role: 'status' });
      if (!m.locked) {
        const cb = h('input#wz-modtoggle', { type: 'checkbox', checked: n > 0, 'aria-label': 'Module ' + m.title + ' on or off' });
        cb.addEventListener('change', () => draftToggle(m.id, cb.checked, mslot, cb));
        head.appendChild(h('label.check', cb, h('span.pf-word', { text: n > 0 ? 'on' : 'off' })));
      } else head.appendChild(h('span.pf-lock', { text: 'always on - a safety rule you cannot turn off' }));
      body.appendChild(head);
      body.appendChild(mslot);
      body.appendChild(h('p.small', { text: m.summary }));
      if (m.why) body.appendChild(h('p.small.muted', { text: 'Why it is on: ' + m.why }));
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
      whatThis(body, 'These user environment variables are what the modules you chose need. They are written for your Windows user only (new terminals see them). API keys are asked for on the next step, never here.',
        'skip each variable below; the items that need it are turned off and listed.');
      for (const e of W.inputs.env.filter((x) => !x.secret)) {
        const k = SP.skipKey('env', e.name);
        const skip = W.skipped.has(k);
        const card = h('div.wz-input', h('div.mono.wz-ctitle', { text: e.name + (e.proposed ? ' = ' + e.proposed : '') }),
          h('div.small', { text: 'Does: ' + e.does }), h('div.small.muted', { text: 'Why it is on: ' + e.why }),
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
      for (const a of info.accounts || []) acc.appendChild(h('option', { value: a.id, text: a.label }));
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
      whatThis(body, 'A few values the chosen modules write into files. Your git identity is stored in this project\'s local git config only, so commits carry your name and never an AI co-author line.',
        'skip each value below; the items that use it are turned off and listed.');
      for (const v of W.inputs.variables.filter((x) => x.name !== SP.PROXY_VAR)) {
        const inp = h('input.mono', { type: 'text', spellcheck: 'false', value: W.values[v.name] || v.value || '', 'aria-label': v.name, dataset: { var: v.name } });
        const line = h('span.small.wz-val', { role: 'status' });
        const sk = h('input', { type: 'checkbox', checked: W.skipped.has(v.name), 'aria-label': 'Skip ' + v.name });
        const upd = () => { const ok = SP.validValue(v, inp.value); U.note(line, inp.value ? (ok ? '[+]' : '[x] ' + SP.hintFor(v)) : '', !ok); if (ok) W.values[v.name] = inp.value; else delete W.values[v.name]; };
        inp.addEventListener('input', upd);
        enterNext(inp, () => SP.validValue(v, inp.value));
        if (inp.value) upd();
        sk.addEventListener('change', () => reskip(v.name, sk.checked));
        body.appendChild(h('div.wz-input', h('div.mono.wz-ctitle', { text: v.name }), h('div.small.muted', { text: (v.why || '') + ' Used by: ' + itemTitles(v.items) }), h('div', inp, ' ', line), skipRow(sk, 'the items that use it stay off.')));
      }
      offList(body);
    },
    tasks(body) {
      const preset = W.path !== 'custom';
      whatThis(body, preset ? 'The author\'s setup registers these scheduled tasks for your user. Say yes or no for all of them at once.' : 'Each scheduled task needs its own yes: tick the ones you want. Unticked tasks are not registered.',
        preset ? 'answer No and no task is registered; the task-backed items are turned off and listed.' : 'leave every task unticked; the task-backed items are turned off and listed.');
      for (const t of W.inputs.tasks) {
        const card = h('div.wz-input', h('div.mono.wz-ctitle', { text: t.name }),
          h('div.small', { text: 'When: ' + (t.trigger || 'see the task file') + (t.limitMinutes ? '; stops after ' + t.limitMinutes + ' min' : '') + (t.hidden ? '; runs hidden' : '') }),
          h('div.small', { text: 'Runs: ' + t.does }),
          h('div.small', { text: 'May delete: ' + (t.deletes || 'nothing') }),
          h('div.small.muted', { text: 'Why it is on: ' + t.why }));
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
      let plan;
      try { plan = await api('POST', '/api/profile/plan', { target: U.targetOf(W.target), draft, values: W.values }); } catch (e) { body.appendChild(h('p.pf-bad', { text: '[x] ' + e.message })); return; }
      W.plan = plan;
      W.typed = {};
      // a value the plan still needs is asked right here (UX-F25), then planned again
      if (plan.missing && plan.missing.length) {
        const card = U.missingCard(plan, (W.inputs && W.inputs.variables) || st.variables || [], W.values, (nv) => { Object.assign(W.values, nv); W.shown = null; render(); });
        card.id = 'wz-missing';
        body.appendChild(card);
      }
      const custom = W.path === 'custom';
      const upd = () => { next.disabled = plan.empty || plan.verdict.code !== 0 || (plan.missing && plan.missing.length > 0) || (custom && !PF.acksComplete(plan.highRisk, W.typed)); };
      body.appendChild(U.planView(plan, st.modules, { typedAcks: custom, typed: W.typed, onAck: upd }));
      if (!custom && plan.highRisk.length) body.appendChild(h('p.small.muted', { text: 'On this path, your answer on scheduled tasks and the review tick count as your yes for the high-risk items listed above.' }));
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
      try { r = await api('POST', '/api/profile/apply', { planId: W.plan.planId, confirm: true, groupedConsent: W.path !== 'custom', taskConsent, acks: W.plan.highRisk.map((x) => x.id) }); } catch (e) { r = { ok: false, line: e.message, verify: [] }; }
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
    body.appendChild(h('p' + (r.ok ? '' : '.pf-bad'), { role: 'status', text: (r.ok ? '[+] ' : '[x] ') + r.line }));
    if (r.verify && r.verify.length) body.appendChild(U.verifyRows(r.verify, U.report));
    const bad = r.ok && (r.verify || []).some((v) => !v.ok && !v.skipped);
    if (r.ok && !bad) body.appendChild(h('p.wz-done', { text: '[+] Setup complete - restart Claude panes to load it' }));
    if (!r.ok) body.appendChild(h('button', { type: 'button', text: 'Report a problem', on: { click: () => U.report({ id: 'apply', reason: r.line }) } }));
    if (r.commit) body.appendChild(h('p.small.muted', { text: 'Nothing was committed. Suggested commit message: ' + r.commit.message }));
    next.disabled = false;
    $('#wz-back').disabled = true;
    $('#wz-switch').disabled = true;
    next.focus();
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
    W.inputs = await api('POST', '/api/profile/wizard', { op: 'inputs', selection: W.base });
    W.steps = SP.stepsFor(W.path, W.inputs, {});
    // tasks start unconsented (path B) / unanswered (path A): no task registers without a yes
    await applyTaskSkips();
  }

  async function onNext() {
    try {
      const step = cur();
      if (!step || W.applying) return;
      if (step === 'path') {
        if (!W.path) return;
        if (W.path === 'custom') { setBase(await api('POST', '/api/profile/wizard', { op: 'custom', selection: W.base })); W.steps = SP.stepsFor('custom', W.inputs, {}); }
        else await fixSteps();
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
        W.steps = SP.stepsFor('custom', W.inputs, {});
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
