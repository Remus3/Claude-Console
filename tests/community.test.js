'use strict';
// GH-PUBLIC: the public repo's community and CI files (SECURITY, CONTRIBUTING, code of
// conduct, issue / PR templates, dependabot, CI workflow) and the generic privacy scan
// the CI workflow runs over the public tree.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const scan = require('../tools/privacy-scan.js');

const FILES = [
  'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md',
  '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/crash_report.yml',
  '.github/ISSUE_TEMPLATE/feature_request.yml', '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md', '.github/dependabot.yml', '.github/workflows/ci.yml',
  'tools/privacy-scan.js',
];

test('every community / CI file exists, ASCII and LF only', () => {
  for (const f of FILES) {
    const t = read(f);
    assert.ok(t.length > 0, f + ' is empty');
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(t), f + ' is not ASCII');
    assert.ok(!t.includes('\r'), f + ' has CR');
  }
});

test('no FUNDING.yml (the owner has no sponsors listing)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '.github/FUNDING.yml')));
});

test('SECURITY.md points to private vulnerability reporting and lists supported versions', () => {
  const t = read('SECURITY.md');
  assert.match(t, /security\/advisories\/new/);
  assert.match(t, /## Supported versions/);
  assert.match(t, /Do not open a public issue/i);
});

test('code of conduct is Contributor Covenant 2.1 with a non-email contact', () => {
  const t = read('CODE_OF_CONDUCT.md');
  assert.match(t, /Contributor Covenant/);
  assert.match(t, /version 2\.1/);
  assert.ok(!/INSERT CONTACT METHOD/.test(t));
});

test('crash report template carries the crash-report output fields and the secrets warning', () => {
  const t = read('.github/ISSUE_TEMPLATE/crash_report.yml');
  assert.match(t, /never paste secrets/i);
  for (const field of ['Console version', 'Channel', 'OS build', 'Node version', 'Git present',
    'Failing step', 'Exit code', 'Reason', 'Profile state', 'Last transaction', 'Console log']) {
    assert.ok(t.includes(field), 'crash template lacks field: ' + field);
  }
  assert.match(t, /claude-console crash-report/);
});

test('issue chooser sends questions to Discussions and keeps blank issues (contribute.js URL)', () => {
  const t = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(t, /blank_issues_enabled: true/);
  assert.match(t, /discussions/);
  for (const f of ['bug_report.yml', 'feature_request.yml']) {
    assert.match(read('.github/ISSUE_TEMPLATE/' + f), /never paste secrets/i);
  }
});

test('dependabot: npm and github-actions, weekly', () => {
  const t = read('.github/dependabot.yml');
  assert.match(t, /package-ecosystem: "npm"/);
  assert.match(t, /package-ecosystem: "github-actions"/);
  assert.strictEqual((t.match(/interval: "weekly"/g) || []).length, 2);
});

test('CI: windows-latest, Node 24, read-only token, actions pinned by full SHA', () => {
  const t = read('.github/workflows/ci.yml');
  assert.match(t, /runs-on: windows-latest/);
  assert.match(t, /node-version: "24"/);
  assert.match(t, /^permissions:\n  contents: read$/m);
  assert.match(t, /npm ci/);
  assert.match(t, /npm test/);
  assert.match(t, /node tools\/privacy-scan\.js \./);
  assert.match(t, /shell: powershell\n/);
  assert.match(t, /Parser\]::ParseFile/);
  const uses = t.match(/uses: .+/g) || [];
  assert.ok(uses.length >= 2);
  for (const u of uses) assert.match(u, /^uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/, 'not SHA-pinned: ' + u);
});

test('public README starts with the GH-PUBLIC badge row', () => {
  // the public build ships release/README.md as README.md
  const lines = read(fs.existsSync(path.join(__dirname, '..', 'release', 'README.md')) ? 'release/README.md' : 'README.md').split('\n');
  assert.strictEqual(lines[0], '# Claude Console');
  assert.strictEqual(lines[1], '');
  const badges = lines.slice(2, 7).join('\n');
  assert.ok(lines.slice(2, 7).every((l) => l.startsWith('[![')), 'five badges, one per line');
  for (const b of ['releases/latest', 'actions/workflows/ci.yml', 'license', 'downloads', 'Windows']) {
    assert.ok(badges.includes(b), 'badge row lacks ' + b);
  }
});

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pscan-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

test('privacy scan flags planted emails, tokens, user paths, private IPs and artifact ids', () => {
  const tok = 'gh' + 'p_' + 'a'.repeat(30);
  const dir = tree({
    'a.md': 'mail me: some.one@' + 'company.com\n',
    'b.js': "const t = '" + tok + "';\n",
    'c.txt': 'C:\\Users\\' + 'jdoe\\x and 192.168' + '.1.20\n',
    'd.md': 'https://claude.ai/' + 'artifact/abc123def\n',
    'node_modules/x/e.js': 'ignored@' + 'company.com\n',
  });
  const hits = scan.scanDir(dir);
  const terms = hits.map((h) => h.term).sort();
  assert.deepStrictEqual(terms, ['artifact-url', 'email', 'private-ip', 'token', 'user-path']);
  assert.ok(hits.every((h) => h.file !== 'node_modules/x/e.js'));
});

test('privacy scan passes neutral text and the documented placeholders', () => {
  const dir = tree({
    'a.md': 'C:\\Users\\you\\x, %USERPROFILE%, noreply 1+x@' + 'users.noreply.github.com, a@example.com\n',
    'b.json': '{"dependencies": {"@xterm/xterm": "6.0.0"}}\n',
    'c.png': 'some.one@' + 'company.com',
  });
  assert.deepStrictEqual(scan.scanDir(dir), []);
});
