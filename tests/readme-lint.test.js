'use strict';
// The public README lints clean (CON-013 f.6): no repetition, valid links, screenshots
// that exist. In Main the README is release/README.md (the export moves it to README.md);
// its links are relative to the console root in both layouts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { lint, SECTIONS } = require('../tools/readme-lint');

const ROOT = path.resolve(__dirname, '..');
const README = fs.existsSync(path.join(ROOT, 'release', 'README.md')) ? path.join(ROOT, 'release', 'README.md') : path.join(ROOT, 'README.md');

test('the public README lints clean', () => {
  assert.deepStrictEqual(lint(fs.readFileSync(README, 'utf8'), ROOT), []);
});

test('the README shows the screenshots and GIFs it names, and they exist', () => {
  const text = fs.readFileSync(README, 'utf8');
  const imgs = [...text.matchAll(/!\[[^\]]+\]\((docs\/images\/[^)]+)\)/g)].map((m) => m[1]);
  assert.ok(imgs.length >= 3 && imgs.some((i) => i.endsWith('.gif')), imgs.join(' '));
  for (const i of imgs) assert.ok(fs.statSync(path.join(ROOT, i)).size > 1000, i);
});

const OK = ['# Claude Console', '', 'A console for Claude Code that runs on your own computer only.', '']
  .concat(SECTIONS.flatMap((s, i) => ['## ' + s, '', 'Section number ' + i + ' says something different about ' + s.toLowerCase() + ' here.', '']))
  .join('\n');

test('lint passes a minimal README with every section', () => {
  assert.deepStrictEqual(lint(OK, ROOT), []);
});

test('lint fails on a planted duplicate paragraph, sentence and heading', () => {
  const dupPara = OK + '\nSection number 2 says something different about first run here.\n';
  assert.ok(lint(dupPara, ROOT).some((p) => /repeated (paragraph|sentence)/.test(p)));
  const dupSent = OK.replace('## Privacy\n\n', '## Privacy\n\nIt checks for updates once a day against the releases.\nNothing else leaves. ')
    + '\nIn short, nothing more. It checks for updates once a day against the releases.\n';
  assert.ok(lint(dupSent, ROOT).some((p) => /repeated sentence/.test(p)), lint(dupSent, ROOT).join('; '));
  assert.ok(lint(OK + '\n## Install\n\nmore\n', ROOT).some((p) => /repeated heading: Install/.test(p)));
});

test('lint fails on a missing image, a dead link, a missing section and a non-ASCII byte', () => {
  assert.ok(lint(OK + '\n![x](docs/images/nope.png)\n', ROOT).some((p) => /image target missing/.test(p)));
  assert.ok(lint(OK + '\nSee [the guide](help/nope.md).\n', ROOT).some((p) => /link target missing/.test(p)));
  assert.ok(lint(OK.replace('## Privacy', '## Secrets'), ROOT).some((p) => /missing section: Privacy/.test(p)));
  assert.ok(lint(OK + '\ncaf\u00e9\n', ROOT).some((p) => /non-ASCII/.test(p)));
  assert.ok(lint(OK + '\n' + 'x '.repeat(60) + '\n', ROOT).some((p) => /longer than/.test(p)));
});
