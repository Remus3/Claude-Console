'use strict';
// CON-UX-SUBCAT (S49 intake, screenshot 1 mark 2 + screenshot 2): a project's
// sub-pins (local model, chat), its stack rows and its tools showed while the project
// was collapsed, and flat when it was open. Now an item renders only inside its own
// sub-category, and only while the project AND that sub-category are open. A project
// with a single kind of child (tools only) keeps the flat list under its row.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../public/app.js').Side;

test('collapsed project: nothing under it, whatever the sub-category state', () => {
  assert.deepStrictEqual(S.plan(['pins', 'stack', 'tools'], false, new Set(['pins', 'stack', 'tools'])), []);
});

test('open project with several kinds: one header per sub-category, items only when it is open', () => {
  assert.deepStrictEqual(S.plan(['pins', 'stack', 'tools'], true, new Set()), [
    { kind: 'head', cat: 'pins', open: false }, { kind: 'head', cat: 'stack', open: false }, { kind: 'head', cat: 'tools', open: false },
  ]);
  assert.deepStrictEqual(S.plan(['pins', 'stack', 'tools'], true, new Set(['stack'])), [
    { kind: 'head', cat: 'pins', open: false }, { kind: 'head', cat: 'stack', open: true }, { kind: 'items', cat: 'stack' }, { kind: 'head', cat: 'tools', open: false },
  ]);
});

test('open project with one kind (tools only): flat list, no header', () => {
  assert.deepStrictEqual(S.plan(['tools'], true, new Set()), [{ kind: 'items', cat: 'tools' }]);
  assert.deepStrictEqual(S.plan([], true, new Set()), []);
});

test('sub-category order is fixed: pins, stack, tools', () => {
  assert.deepStrictEqual(S.cats({ tools: true, stack: true, pins: true }), ['pins', 'stack', 'tools']);
  assert.deepStrictEqual(S.cats({ tools: true }), ['tools']);
  assert.deepStrictEqual(S.cats({}), []);
});

test('renderProjects draws the local / chat rows through the plan only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /SD\.plan\(/);
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.css'), 'utf8');
  assert.match(css, /#project-list li\.subcat-row \{/);
  assert.match(css, /#project-list li\.tool-row\.in-sub \{/);
});
