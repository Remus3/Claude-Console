'use strict';
// FB-1021 (second-machine feedback 2026-10-21): account setup problems, words only, and the
// other accounts the setup profile applies user-scope settings to.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const C = require('../server/config');

const home = path.resolve('H:/home');
const have = new Set([path.join(home, '.claude'), path.resolve('H:/acct2'), path.resolve('H:/acct3')].map((d) => d.toLowerCase()));
const o = { home, exists: (d) => have.has(path.resolve(d).toLowerCase()) };

test('two accounts on one login (configDir null on both) and one label are named', () => {
  const p = C.accountProblems({ acct1: { label: 'Account 1', configDir: null }, acct2: { label: 'Account 1', configDir: null } }, o);
  assert.deepStrictEqual(Object.keys(p), ['acct2']);
  assert.match(p.acct2, /dir missing, create \+ log in/);
  assert.match(p.acct2, /same label as acct1/);
});

test('a later account on the first account\'s dir, or on a dir that does not exist', () => {
  const same = C.accountProblems({ acct1: { configDir: null }, acct2: { configDir: path.join(home, '.claude') } }, o);
  assert.match(same.acct2, /same config dir as acct1 \(one login\)/);
  const gone = C.accountProblems({ acct1: { configDir: null }, acct2: { configDir: 'H:/nowhere' } }, o);
  assert.strictEqual(gone.acct2, 'dir missing, create + log in');
  assert.deepStrictEqual(C.accountProblems({ acct1: { configDir: null }, acct2: { configDir: 'H:/acct2', label: 'B' } }, o), {});
  // words only: never a path in a problem
  for (const t of Object.values(Object.assign({}, same, gone))) assert.ok(!/[A-Za-z]:[\\/]|\.claude/.test(t), t);
});

test('extra account dirs: every account but the primary with a dir of its own', () => {
  const accts = { acct1: { label: 'A', configDir: null }, acct2: { label: 'B', configDir: 'H:/acct2' }, acct3: { label: 'C', configDir: null } };
  // primary acct2 (the main account): acct1 owns ~/.claude, acct3 has no dir
  assert.deepStrictEqual(C.extraAccountDirs(accts, 'acct2', o), { acct1: { dir: path.join(home, '.claude'), label: 'A' } });
  assert.deepStrictEqual(C.extraAccountDirs(accts, 'acct1', o), { acct2: { dir: path.resolve('H:/acct2'), label: 'B' } });
  assert.deepStrictEqual(C.extraAccountDirs({ acct1: { configDir: null }, acct2: { configDir: null } }, 'acct1', o), {});
});
