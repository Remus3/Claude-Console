#!/usr/bin/env node
'use strict';
// CON-013 L3x: the seeded NON-conforming demo repo for the adopt flow (addendum c.1).
// Deterministic (fixed content, fixed commit dates), all fake data. It is generated, not
// checked in, because it must carry CRLF bytes and secret-shaped strings that the LF /
// ASCII-only tree and its scanners refuse; the token shapes are assembled from pieces
// here so this source holds none. Used by tests/profile-adopt.test.js and by the release
// sandbox phase E (L6 reads it, never edits it).
//
//   node tools/demo-adopt-seed.js <empty-dir> [--no-git]
//
// Contents: a small working Node app (CLI entry + HTTP server printing READY <port>),
// its own 24 node:test tests, start.bat and a README "Run" block (detectable checks);
// mixed line endings (6 LF / 3 CRLF / 1 mixed .js under app/); an oversized messy
// CLAUDE.md, NOTES.md and docs/old-plan.md; a stray scratch_tmp/ (40 files), debug.log
// and "out (copy).txt"; fake secret-looking strings; no .githooks / .gitattributes / CI
// / hand-off / ROADMAP; 12 commits, one with a bot co-author trailer. Two planted
// breaking candidates: app/data/catalog.csv must stay CRLF (a test hashes its bytes) and
// app/templates/report.md is read by path by app/render.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CRLF = (lines) => lines.join('\r\n') + '\r\n';
const LF = (lines) => lines.join('\n') + '\n';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Deterministic filler text (no randomness).
function filler(prefix, n, width) {
  const words = ['alpha', 'bravo', 'delta', 'echo', 'kilo', 'lima', 'oscar', 'romeo', 'sierra', 'tango', 'victor', 'zulu'];
  const out = [];
  for (let i = 0; i < n; i++) {
    let s = prefix + ' ' + String(i + 1).padStart(4, '0') + ':';
    let k = i;
    while (s.length < width) { s += ' ' + words[k % words.length]; k = (k * 7 + 3) % 101; }
    out.push(s.slice(0, width));
  }
  return out;
}

function catalogCsv() {
  const rows = ['id,name,price'];
  const names = ['anchor', 'beacon', 'cable', 'dial', 'ember', 'flint', 'gasket', 'hinge', 'ingot', 'joist', 'kettle', 'lantern'];
  names.forEach((n, i) => rows.push((i + 1) + ',' + n + ',' + ((i + 1) * 3 + 0.5).toFixed(2)));
  return CRLF(rows);
}

function fakeSecrets() {
  // Pattern-valid FAKE values, built from pieces.
  return {
    sk: 's' + 'k-' + 'test-' + 'FAKE' + '0'.repeat(28),
    akia: 'AK' + 'IA' + 'FAKE' + 'FAKE' + 'FAKE' + '0000',
    ghp: 'gh' + 'p_' + 'FAKE' + 'x'.repeat(32),
  };
}

function files() {
  const s = fakeSecrets();
  const csv = catalogCsv();
  const f = {};
  f['package.json'] = LF([JSON.stringify({ name: 'demo-nonconforming', version: '1.4.2', private: true, scripts: { test: 'node --test', build: 'node app/build.js', start: 'node app/server.js' } }, null, 2)]);
  f['README.md'] = LF(['# Demo catalog', '', 'A small demo app that renders a catalog report.', '', '## Run', '', '```', 'node app/main.js', '```', '', '## Test', '', '```', 'npm test', '```']);
  f['start.bat'] = CRLF(['@echo off', 'node app\\server.js']);
  // app/ - 6 LF, 3 CRLF, 1 mixed .js files.
  f['app/main.js'] = LF([
    "'use strict';",
    "const pkg = require('../package.json');",
    "const { loadCatalog } = require('./catalog');",
    "const { render } = require('./render');",
    '',
    "if (process.argv.includes('--version')) { console.log(pkg.version); process.exit(0); }",
    "console.log(render({ name: 'demo', items: loadCatalog() }).split('\\n').slice(0, 3).join('\\n'));",
  ]);
  f['app/catalog.js'] = LF([
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    '// The catalog is exported by a spreadsheet tool that writes CRLF; rows split on CRLF.',
    'function loadCatalog() {',
    "  const text = fs.readFileSync(path.join(__dirname, 'data', 'catalog.csv'), 'latin1');",
    "  const lines = text.split('\\r\\n').filter(Boolean);",
    "  const head = lines.shift().split(',');",
    "  return lines.map((l) => { const c = l.split(','); return { id: +c[0], name: c[1], price: +c[2], cols: c.length === head.length }; });",
    '}',
    '',
    'module.exports = { loadCatalog };',
  ]);
  f['app/render.js'] = LF([
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    "const ROOT = path.join(__dirname, '..');",
    '',
    '// The report template is read by its path inside the repo.',
    'function render(data) {',
    "  const items = data.items || [];",
    "  const total = items.reduce((a, b) => a + b.price, 0);",
    "  const lines = items.map((it) => '- ' + it.name + ': ' + it.price.toFixed(2));",
    "  const head = '# Report for ' + data.name;",
    "  // template body",
    "  const t = fs.readFileSync(path.join(ROOT, 'app/templates/report.md'), 'utf8');",
    "  return t.replace('{{title}}', head).replace('{{count}}', String(items.length)).replace('{{total}}', total.toFixed(2)).replace('{{items}}', lines.join('\\n'));",
    '}',
    '',
    'module.exports = { render };',
  ]);
  f['app/server.js'] = LF([
    "'use strict';",
    "const http = require('http');",
    '',
    'const server = http.createServer((req, res) => {',
    "  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }",
    "  res.writeHead(404); res.end();",
    '});',
    "server.listen(0, '127.0.0.1', () => { console.log('READY ' + server.address().port); });",
  ]);
  f['app/build.js'] = LF([
    "'use strict';",
    "const { loadCatalog } = require('./catalog');",
    "console.log('built ' + loadCatalog().length + ' items');",
  ]);
  f['app/lib/fmt.js'] = LF([
    "'use strict';",
    '// Sample credential for the docs (fake): ' + s.akia,
    "function money(n) { return '$' + Number(n).toFixed(2); }",
    'module.exports = { money };',
  ]);
  f['app/lib/sum.js'] = CRLF(["'use strict';", 'function sum(a) { return a.reduce((x, y) => x + y, 0); }', 'module.exports = { sum };']);
  f['app/lib/slug.js'] = CRLF(["'use strict';", "function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }", 'module.exports = { slug };']);
  f['app/lib/pad.js'] = CRLF(["'use strict';", "function pad(s, n) { return String(s).padStart(n, '0'); }", 'module.exports = { pad };']);
  f['app/lib/range.js'] = "'use strict';\r\nfunction range(n) { return Array.from({ length: n }, (_, i) => i); }\nmodule.exports = { range };\r\n";
  f['app/data/catalog.csv'] = csv;
  f['app/templates/report.md'] = LF(['{{title}}', '', 'Items: {{count}}, total {{total}}', '', '{{items}}', '', '## Boilerplate'].concat(filler('- boilerplate line', 470, 96)));
  // tests - 24 node:test tests.
  f['tests/catalog.test.js'] = LF([
    "'use strict';",
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const fs = require('fs');",
    "const path = require('path');",
    "const crypto = require('crypto');",
    "const { loadCatalog } = require('../app/catalog');",
    '',
    "test('catalog checksum', () => {",
    "  const b = fs.readFileSync(path.join(__dirname, '..', 'app', 'data', 'catalog.csv'));",
    "  assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), '" + sha(Buffer.from(csv, 'latin1')) + "');",
    '});',
    "test('catalog has 12 rows', () => { assert.strictEqual(loadCatalog().length, 12); });",
    "test('catalog ids are unique', () => { const ids = loadCatalog().map((r) => r.id); assert.strictEqual(new Set(ids).size, ids.length); });",
    "test('catalog prices are numbers', () => { assert.ok(loadCatalog().every((r) => Number.isFinite(r.price))); });",
  ]);
  f['tests/render.test.js'] = LF([
    "'use strict';",
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const { render } = require('../app/render');",
    '',
    "const items = [{ name: 'a', price: 1 }, { name: 'b', price: 2.5 }];",
    "test('render uses the template', () => { assert.ok(render({ name: 'demo', items }).startsWith('# Report for demo\\n\\nItems: 2, total 3.50')); });",
    "test('render lists every item', () => { assert.match(render({ name: 'x', items }), /- b: 2\\.50/); });",
  ]);
  const lib = ["'use strict';", "const test = require('node:test');", "const assert = require('node:assert');",
    "const { money } = require('../app/lib/fmt');", "const { sum } = require('../app/lib/sum');", "const { slug } = require('../app/lib/slug');",
    "const { pad } = require('../app/lib/pad');", "const { range } = require('../app/lib/range');", ''];
  const cases = [
    ["money 1", "assert.strictEqual(money(1), '$1.00')"], ["money 2.5", "assert.strictEqual(money(2.5), '$2.50')"], ["money 0", "assert.strictEqual(money(0), '$0.00')"],
    ['sum empty', 'assert.strictEqual(sum([]), 0)'], ['sum three', 'assert.strictEqual(sum([1, 2, 3]), 6)'], ['sum negative', 'assert.strictEqual(sum([-1, 1]), 0)'],
    ['slug simple', "assert.strictEqual(slug('Hello World'), 'hello-world')"], ['slug trim', "assert.strictEqual(slug('  a  '), 'a')"], ['slug symbols', "assert.strictEqual(slug('a&b'), 'a-b')"], ['slug digits', "assert.strictEqual(slug('v1.2'), 'v1-2')"],
    ['pad 2', "assert.strictEqual(pad(7, 2), '07')"], ['pad none', "assert.strictEqual(pad(123, 2), '123')"], ['pad 4', "assert.strictEqual(pad(5, 4), '0005')"],
    ['range 0', 'assert.deepStrictEqual(range(0), [])'], ['range 3', 'assert.deepStrictEqual(range(3), [0, 1, 2])'], ['range length', 'assert.strictEqual(range(10).length, 10)'],
    ['range first', 'assert.strictEqual(range(5)[0], 0)'], ['range last', 'assert.strictEqual(range(5)[4], 4)'],
  ];
  f['tests/lib.test.js'] = LF(lib.concat(cases.map(([n, b]) => "test('" + n + "', () => { " + b + '; });')));
  // Oversized, messy docs.
  f['CLAUDE.md'] = LF(['# Demo catalog - Claude notes', '', 'Purpose: a demo app that renders a catalog report.', '',
    '## Rules', '', '- Always run the tests before committing.', '- Never commit secrets.', '- Always run the tests before committing.', '- Keep answers short.', '',
    '## Never', '', '- Never edit app/data by hand.', '- Never skip editing app/data by hand when a price changes.', '',
    '## Pasted transcript', ''].concat(filler('> user/assistant', 160, 110), ['', '## Code dump', '', '```js'], filler('const x', 260, 100), ['```']));
  f['NOTES.md'] = LF(['# Notes', ''].concat(filler('note', 450, 100)));
  f['docs/old-plan.md'] = LF(['# Old plan', ''].concat(filler('plan step', 420, 100)));
  // Stray scratch.
  for (let i = 1; i <= 40; i++) f['scratch_tmp/try-' + String(i).padStart(2, '0') + '.txt'] = LF(['scratch ' + i]);
  f['debug.log'] = LF(['[debug] started', '[debug] stopped']);
  f['out (copy).txt'] = LF(['copied output']);
  // Fake secret-looking strings.
  f['config/settings.ini'] = LF(['[api]', 'endpoint = http://localhost:9000', 'api_key = ' + s.sk]);
  f['.env.example'] = LF(['GITHUB_TOKEN=' + s.ghp, 'PORT=0']);
  return f;
}

// 12 commits: file groups in a fixed order, fixed dates, one bot co-author trailer.
const GROUPS = [
  ['package.json', 'README.md'], ['app/main.js', 'app/catalog.js'], ['app/data/catalog.csv'], ['app/render.js', 'app/templates/report.md'],
  ['app/server.js', 'start.bat'], ['app/build.js'], ['app/lib/'], ['tests/'], ['CLAUDE.md'], ['NOTES.md', 'docs/'],
  ['config/', '.env.example'], ['scratch_tmp/', 'debug.log', 'out (copy).txt'],
];

function git(dir, args, env) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + path.join(dir, '.git', 'no-hooks')].concat(args),
    { cwd: dir, encoding: 'utf8', windowsHide: true, env: Object.assign({}, process.env, env || {}) });
  if (r.status !== 0) throw new Error('git ' + args[0] + ' failed: ' + String(r.stderr || '').split('\n')[0]);
  return r.stdout;
}

function seed(dir, opts) {
  opts = opts || {};
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length) throw new Error('seed needs an empty directory');
  const f = files();
  for (const [rel, text] of Object.entries(f)) {
    const abs = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(text, 'latin1'));
  }
  let commits = 0;
  if (opts.git !== false) {
    git(dir, ['init', '-q', '-b', 'main']);
    GROUPS.forEach((g, i) => {
      git(dir, ['add', '--'].concat(g));
      const when = '2026-09-' + String(i + 1).padStart(2, '0') + 'T10:00:00Z';
      const env = { GIT_AUTHOR_NAME: 'Demo User', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo User', GIT_COMMITTER_EMAIL: 'demo@example.invalid', GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when };
      const msg = 'Demo commit ' + (i + 1) + ': ' + g.join(', ') + (i === 6 ? '\n\nCo-' + 'authored-by: helper-bot <bot@example.invalid>' : '');
      git(dir, ['commit', '-q', '-m', msg], env);
      commits++;
    });
  }
  return { dir, files: Object.keys(f).sort(), commits, secrets: fakeSecrets() };
}

module.exports = { seed, files, fakeSecrets, catalogCsv, EXPECTED: path.join(__dirname, '..', 'tests', 'fixtures', 'adopt-demo', 'expected-report.json') };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node tools/demo-adopt-seed.js <empty-dir> [--no-git]\n'); process.exit(2); }
  const r = seed(path.resolve(dir), { git: !process.argv.includes('--no-git') });
  process.stdout.write('seeded ' + r.files.length + ' files, ' + r.commits + ' commits\n');
}
