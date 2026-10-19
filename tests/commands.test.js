'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { CommandCatalog, BUILTINS, parseFrontmatter, describe } = require('../server/commands');
const { createConsoleServer } = require('../server/server');
const { tmpdir, writeFile, makeFixture } = require('./helpers');

function seed() {
  const root = tmpdir('cc-cmd-');
  const proj = path.join(root, 'proj');
  const cfgDir = path.join(root, 'cfg');
  writeFile(path.join(proj, '.claude', 'commands', 'done.md'), '---\ndescription: End-of-session ritual\n---\nBody text.\n');
  writeFile(path.join(proj, '.claude', 'commands', 'ops', 'deploy.md'), '\n\n# Deploy the thing to prod now\nmore\n');
  writeFile(path.join(proj, '.claude', 'commands', 'review.md'), '---\ndescription: "Project review wins"\n---\n');
  writeFile(path.join(proj, '.claude', 'skills', 'chart', 'SKILL.md'), '---\nname: chart-maker\ndescription: >\n  Folded description\n  over two lines\n---\n');
  writeFile(path.join(proj, '.claude', 'skills', 'nofile', 'README.md'), 'not a skill');
  writeFile(path.join(cfgDir, 'commands', 'done.md'), '---\ndescription: user done loses\n---\n');
  writeFile(path.join(cfgDir, 'commands', 'caveman.md'), 'x'.repeat(200) + '\n');
  writeFile(path.join(cfgDir, 'skills', 'synced', 'SKILL.md'), '---\ndescription: user skill\n---\n');
  return { root, proj, cfgDir };
}

test('frontmatter and description', () => {
  assert.deepStrictEqual(parseFrontmatter('---\na: 1\ndescription: \'q\'\n---\nbody').fm, { a: '1', description: 'q' });
  assert.strictEqual(parseFrontmatter('no fm').body, 'no fm');
  assert.strictEqual(describe('---\nname: x\n---\n\n## Heading line\n').description, 'Heading line');
  assert.strictEqual(describe('\r\n\r\nfirst line\r\n').description, 'first line');
  const long = describe('y'.repeat(300)).description;
  assert.strictEqual(long.length, 80);
  assert.ok(long.endsWith('...'));
  assert.strictEqual(describe('').description, '');
});

test('catalogue: sources, namespaces, precedence, built-ins', () => {
  const { proj, cfgDir } = seed();
  const rows = new CommandCatalog().list(proj, cfgDir);
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.strictEqual(by.done.description, 'End-of-session ritual');
  assert.strictEqual(by.done.source, 'project');
  assert.strictEqual(by['ops:deploy'].description, 'Deploy the thing to prod now');
  assert.strictEqual(by['chart-maker'].description, 'Folded description over two lines');
  assert.strictEqual(by.nofile, undefined);
  assert.strictEqual(by.caveman.source, 'user');
  assert.strictEqual(by.caveman.description.length, 80);
  assert.strictEqual(by.synced.description, 'user skill');
  assert.strictEqual(by.review.description, 'Project review wins');
  assert.strictEqual(by.review.source, 'project');
  for (const b of ['clear', 'compact', 'model', 'config', 'context', 'cost', 'help', 'init', 'memory', 'resume', 'status', 'agents', 'hooks', 'mcp', 'permissions', 'exit']) {
    assert.strictEqual(by[b] && by[b].source, 'builtin', b);
  }
  assert.strictEqual(BUILTINS.length, 17);
  assert.strictEqual(rows.filter((r) => r.name === 'done').length, 1);
  const names = rows.map((r) => r.name);
  assert.deepStrictEqual(names, names.slice().sort());
});

test('catalogue: missing dirs give built-ins only', () => {
  const rows = new CommandCatalog().list(path.join(tmpdir(), 'nope'), null);
  assert.strictEqual(rows.length, BUILTINS.length);
  assert.ok(rows.every((r) => r.source === 'builtin'));
});

test('catalogue: cache hit, then mtime invalidation', () => {
  const { proj, cfgDir } = seed();
  const cat = new CommandCatalog();
  const a = cat.list(proj, cfgDir);
  assert.strictEqual(cat.list(proj, cfgDir), a, 'unchanged tree returns the cached rows');
  const f = path.join(proj, '.claude', 'commands', 'done.md');
  fs.writeFileSync(f, '---\ndescription: Changed text here\n---\n');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  const b = cat.list(proj, cfgDir);
  assert.notStrictEqual(b, a);
  assert.strictEqual(b.find((r) => r.name === 'done').description, 'Changed text here');
  writeFile(path.join(proj, '.claude', 'commands', 'added.md'), 'New one\n');
  assert.ok(cat.list(proj, cfgDir).some((r) => r.name === 'added'));
});

test('GET /api/commands: token, project, pane account', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  writeFile(path.join(fx.scan, 'Alpha', '.claude', 'commands', 'done.md'), '---\ndescription: Alpha done\n---\n');
  writeFile(path.join(fx.acct2, 'commands', 'acct-two.md'), 'From account two\n');
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token };
  assert.strictEqual((await fetch(base + '/api/commands')).status, 401);
  const alpha = srv.projects.find((p) => p.name === 'Alpha');
  const r = await fetch(base + '/api/commands?project=' + encodeURIComponent(alpha.id), { headers: H });
  assert.strictEqual(r.status, 200);
  const rows = (await r.json()).commands;
  assert.strictEqual(rows.find((x) => x.name === 'done').description, 'Alpha done');
  assert.ok(rows.some((x) => x.name === 'acct-two'), 'the selected account (acct2) config dir is read');
  assert.ok(rows.some((x) => x.name === 'clear'));
  assert.strictEqual((await fetch(base + '/api/commands?project=nope', { headers: H })).status, 404);
  assert.strictEqual((await fetch(base + '/api/commands?account=nope', { headers: H })).status, 404);
});
