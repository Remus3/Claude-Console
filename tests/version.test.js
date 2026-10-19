'use strict';
// CON-UX-VERSION (S49 intake): the console version sits at the bottom right of the
// footer bar, from /api/info (package.json), never hard-coded in the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');

test('footer ends with the version slot', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const m = /<footer id="taskbar">([\s\S]*?)<\/footer>/.exec(html);
  assert.ok(m, 'footer present');
  assert.match(m[1], /<span id="tb-version"[^>]*><\/span>$/, 'version is the last footer child and starts empty');
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  assert.match(css, /#tb-version \{[^}]*margin-left: auto;/);
  assert.match(css, /#tb-version \{[^}]*white-space: nowrap;/);
});

test('app.js fills it from /api/info version', () => {
  const js = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(js, /\$\('#tb-version'\)\.textContent = 'v' \+ info\.version/);
  const pkg = require('../package.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.ok(!js.includes("'v" + pkg.version + "'"), 'not hard-coded');
});
