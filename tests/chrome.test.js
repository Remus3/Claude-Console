'use strict';
// Composer-only claude panes: the pure detector for claude's bottom chrome (input box,
// rules, status / permission / agent rows) that the UI hides and summarizes.
const test = require('node:test');
const assert = require('node:assert');
const C = require('../public/app.js');

const R = '\u2500';
const rule = (label, w) => (label ? R.repeat((w || 60) - label.length - 3) + ' ' + label + ' ' + R : R.repeat(w || 60));

// A full screen the way claude draws it once the transcript fills the pane.
function screen(rows, opts) {
  const o = opts || {};
  const tail = [
    rule(o.label === undefined ? 'Main' : o.label),
    '> ' + (o.typed || ''),
    rule(),
    '  acct2 | Opus 5.5 | Main (main) | ctx 7% | 5h 14% 7d 11%',
    '  \u23f5\u23f5 bypass permissions on \u00b7 2 shells, 1 monitor \u00b7 \u2190 for agents',
  ].concat(o.agents ? ['', '  \u25cf main', '  ( ) general-purpose  Checking worktrees   2m 32s', '  ( ) builder          Appending tests       1m 18s'] : []);
  const body = [];
  for (let i = 0; body.length + tail.length < rows - (o.trailing || 0); i++) body.push('\u25cf transcript line ' + i);
  return body.concat(tail, new Array(o.trailing || 0).fill(''));
}

test('rule and prompt rows are recognised; menus and transcript are not', () => {
  assert.ok(C.isRule(rule('Sample D')));
  assert.ok(C.isRule(rule()));
  assert.ok(C.isRule('\u256d' + R.repeat(30) + '\u256e'));
  assert.ok(!C.isRule('\u25cf Ran 2 stop hooks'));
  assert.ok(!C.isRule('--------------'));
  assert.ok(C.isPrompt('> '));
  assert.ok(C.isPrompt('>'));
  assert.ok(C.isPrompt('\u276f fix the bug'));
  assert.ok(C.isPrompt('\u2502 > old boxed input \u2502'));
  assert.ok(!C.isPrompt('\u276f 1. Yes'), 'a permission menu row is not the input box');
  assert.ok(!C.isPrompt('>> quoted'));
});

test('findChrome locates the input box block at the bottom of a full screen', () => {
  const lines = screen(30);
  const ch = C.findChrome(lines);
  assert.ok(ch);
  assert.strictEqual(ch.start, 25);
  assert.strictEqual(ch.close, 27);
  assert.strictEqual(ch.end, 29);
  assert.strictEqual(ch.status.length, 2);
  assert.strictEqual(C.planCrop(ch, 0), 5, 'crop = rows from the upper rule to the bottom');
});

test('findChrome: typed text spanning rows, agent list rows, labelled rule', () => {
  const lines = screen(40, { agents: true, typed: 'long text' });
  lines.splice(lines.length - 9, 0, '  wrapped continuation of the typed prompt');
  lines.shift();
  const ch = C.findChrome(lines);
  assert.ok(ch);
  assert.ok(C.isRule(lines[ch.start]) && /Main/.test(lines[ch.start]));
  assert.strictEqual(ch.end, 39);
  assert.strictEqual(C.planCrop(ch, 0), 40 - ch.start);
});

test('no input box (permission dialog, shell, empty) -> nothing hidden', () => {
  const dlg = ['\u25cf Bash(rm x)', rule(), ' Do you want to proceed?', ' \u276f 1. Yes', '   2. No'];
  assert.strictEqual(C.findChrome(dlg), null);
  assert.strictEqual(C.planCrop(null, 6), 0, 'no block -> crop drops to 0 so a dialog is never hidden');
  assert.strictEqual(C.findChrome(['PS C:\\> dir', 'a', 'b']), null);
  assert.strictEqual(C.findChrome(['', '', '']), null);
  // a rule followed by a prompt but never closed is not the input box
  assert.strictEqual(C.findChrome(['x', rule(), '> ', 'no closing rule']), null);
});

test('block floating above blank rows (short transcript) keeps the current crop', () => {
  const lines = screen(20, { trailing: 6 });
  const ch = C.findChrome(lines);
  assert.ok(ch && ch.end === 13);
  assert.strictEqual(C.planCrop(ch, 0), 0);
  assert.strictEqual(C.planCrop(ch, 4), 4);
  // one trailing blank row still counts as bottom-anchored
  const ch1 = C.findChrome(screen(20, { trailing: 1 }));
  assert.strictEqual(C.planCrop(ch1, 0), 6);
});

test('planCrop is capped', () => {
  const ch = C.findChrome(screen(30, { agents: true }));
  assert.strictEqual(C.planCrop(ch, 0, 5), 5);
});

test('summarize + label carry the counts the hidden rows showed', () => {
  const ch = C.findChrome(screen(40, { agents: true }));
  const sum = C.summarize(ch.status);
  assert.deepStrictEqual(sum, { agents: 2, shells: 2, monitors: 1, ctx: 7, mode: 'bypass' });
  assert.strictEqual(C.label(sum), '2 agents \u00b7 2 shells \u00b7 1 monitor \u00b7 ctx 7%');
  const one = C.summarize(['  accept edits on \u00b7 1 shell \u00b7 1 background agent']);
  assert.strictEqual(C.label(one), '1 agent \u00b7 1 shell');
  assert.strictEqual(one.mode, 'accept edits');
  assert.strictEqual(C.label(C.summarize([])), '');
  // numbers inside an agent's task description are not counts
  const busy = C.summarize(['  \u25cf main', '  ( ) builder  Appending 14 tests to 3 agents file']);
  assert.strictEqual(busy.agents, 1);
});

// Bug (2026-10-07): a composer prompt stayed unsent in claude's hidden input box when
// its Enter was absorbed as part of the paste. The pane now reads the box after
// sending and sends Enter again while it still holds text; inputText() is that read.
test('inputText reads what is left in claude\'s input box', () => {
  const empty = screen(30);
  assert.strictEqual(C.inputText(empty, C.findChrome(empty)), '');
  const typed = screen(30, { typed: '[Pasted text #1] tail of the prompt' });
  assert.strictEqual(C.inputText(typed, C.findChrome(typed)), '[Pasted text #1] tail of the prompt');
  const wrapped = screen(40, { typed: 'first row' });
  const at = C.findChrome(wrapped).start + 2;
  wrapped.splice(at, 0, '  second row');
  wrapped.shift();
  assert.strictEqual(C.inputText(wrapped, C.findChrome(wrapped)), 'first row second row');
  const boxed = ['x', '\u256d' + R.repeat(30) + '\u256e', '\u2502 > old boxed \u2502', '\u2570' + R.repeat(30) + '\u256f', ' status'];
  assert.strictEqual(C.inputText(boxed, C.findChrome(boxed)), 'old boxed');
  assert.strictEqual(C.inputText(['a', 'b'], null), null, 'no box (dialog) -> null, nothing to retry');
});
