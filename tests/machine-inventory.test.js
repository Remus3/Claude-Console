'use strict';
// CON-013 L9: installed apps and games inventory. Steam libraries from fixture VDF files,
// uninstall entries from a stub runner, config files from the recipe registry. Read-only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const inv = require('../installer/machine-inventory');

const FIX = path.join(__dirname, 'fixtures', 'machine');

// A temp copy of the Steam fixture with real library paths filled in.
function steamFixture() {
  const d = tmpdir('cc-steam-');
  const steam = path.join(d, 'Steam');
  const lib2 = path.join(d, 'Lib2');
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  fs.mkdirSync(path.join(lib2, 'steamapps'), { recursive: true });
  const vdf = fs.readFileSync(path.join(FIX, 'steam', 'steamapps', 'libraryfolders.vdf'), 'utf8')
    .replace('STEAMROOT', steam.replace(/\\/g, '\\\\')).replace('LIB2', lib2.replace(/\\/g, '\\\\'));
  fs.writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), vdf);
  fs.copyFileSync(path.join(FIX, 'steam', 'steamapps', 'appmanifest_289070.acf'), path.join(steam, 'steamapps', 'appmanifest_289070.acf'));
  fs.copyFileSync(path.join(FIX, 'lib2', 'steamapps', 'appmanifest_3321460.acf'), path.join(lib2, 'steamapps', 'appmanifest_3321460.acf'));
  return { d, steam, lib2 };
}

test('parseVdf reads nested keys, escapes and comments', () => {
  const v = inv.parseVdf('// c\n"a"\n{\n\t"b"\t\t"x\\\\y"\n\t"c"\n\t{\n\t\t"d"\t"1"\n\t}\n}\n');
  assert.deepStrictEqual(v, { a: { b: 'x\\y', c: { d: '1' } } });
});

test('steamLibraries lists every library folder from libraryfolders.vdf', () => {
  const { steam, lib2 } = steamFixture();
  assert.deepStrictEqual(inv.steamLibraries(steam), [steam, lib2]);
  assert.deepStrictEqual(inv.steamLibraries(path.join(steam, 'nope')), []);
});

test('steamGames reads every app manifest in every library', () => {
  const { steam, lib2 } = steamFixture();
  const g = inv.steamGames(steam);
  assert.deepStrictEqual(g.map((x) => x.appid), ['289070', '3321460']);
  assert.strictEqual(g[0].name, "Sid Meier's Civilization VI");
  assert.strictEqual(g[0].install, path.join(steam, 'steamapps', 'common', "Sid Meier's Civilization VI"));
  assert.strictEqual(g[1].install, path.join(lib2, 'steamapps', 'common', 'SampleGame'));
});

test('steamRoot comes from the registry through the injected runner (read-only reg query)', async () => {
  const calls = [];
  const root = await inv.steamRoot({ runner: async (f, a) => { calls.push([path.basename(f).toLowerCase(), a]); return { code: 0, stdout: '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    c:/program files (x86)/steam\r\n', stderr: '' }; } });
  assert.strictEqual(root, path.normalize('c:/program files (x86)/steam'));
  assert.strictEqual(calls[0][0], 'reg.exe');
  assert.strictEqual(calls[0][1][0], 'query');
  const none = await inv.steamRoot({ runner: async () => ({ code: 1, stdout: '', stderr: 'not found' }) });
  assert.strictEqual(none, null);
});

test('parseUninstall keeps named entries, drops updates and system components, dedupes', () => {
  const rows = [
    { DisplayName: 'Fake Paint Studio 3', DisplayVersion: '3.1.4', Publisher: 'Fakesoft', InstallLocation: 'D:\\Apps\\FakePaint' },
    { DisplayName: 'Fake Paint Studio 3', DisplayVersion: '3.1.4', Publisher: 'Fakesoft', InstallLocation: 'D:\\Apps\\FakePaint' },
    { DisplayName: 'Security Update for X (KB123)', ParentKeyName: 'X' },
    { DisplayName: 'Runtime', SystemComponent: 1 },
    { DisplayVersion: '1' },
  ];
  const apps = inv.parseUninstall(JSON.stringify(rows));
  assert.deepStrictEqual(apps, [{ name: 'Fake Paint Studio 3', version: '3.1.4', publisher: 'Fakesoft', install: 'D:\\Apps\\FakePaint' }]);
  assert.deepStrictEqual(inv.parseUninstall('garbage'), []);
});

test('buildInventory: Steam games, apps, and each recipe app with its config files found', async () => {
  const { d, steam } = steamFixture();
  const local = path.join(d, 'Local');
  const civ = path.join(local, 'Firaxis Games', "Sid Meier's Civilization VI");
  fs.mkdirSync(civ, { recursive: true });
  fs.copyFileSync(path.join(FIX, 'civ6', 'GraphicsOptions.txt'), path.join(civ, 'GraphicsOptions.txt'));
  fs.copyFileSync(path.join(FIX, 'civ6', 'UserOptions.txt'), path.join(civ, 'UserOptions.txt'));
  const runner = async (f) => {
    if (/reg\.exe$/i.test(f)) return { code: 0, stdout: '    SteamPath    REG_SZ    ' + steam + '\r\n', stderr: '' };
    return { code: 0, stdout: JSON.stringify([{ DisplayName: 'Fake Paint Studio 3', DisplayVersion: '3', Publisher: 'F' }]), stderr: '' };
  };
  const r = await inv.buildInventory({ runner, env: { LOCALAPPDATA: local, APPDATA: path.join(d, 'Roaming'), USERPROFILE: d } });
  assert.deepStrictEqual(r.games.map((g) => g.appid), ['289070', '3321460']);
  assert.strictEqual(r.apps.length, 1);
  const c = r.configs.find((x) => x.recipe === 'civ6');
  assert.ok(c, 'civ6 detected');
  assert.strictEqual(c.installed, true);
  assert.deepStrictEqual(c.files.map((f) => path.basename(f.path)), ['GraphicsOptions.txt', 'UserOptions.txt']);
  assert.ok(c.files.every((f) => f.exists));
});

test('saveInventory / loadInventory stay under <dataDir>/machine', () => {
  const data = tmpdir('cc-mach-');
  inv.saveInventory(data, { apps: [], games: [], configs: [] });
  assert.ok(fs.existsSync(path.join(data, 'machine', 'inventory.json')));
  assert.deepStrictEqual(inv.loadInventory(data).apps, []);
  assert.strictEqual(inv.loadInventory(tmpdir('cc-mach-')), null);
});

test('PS_UNINSTALL parses under Windows PowerShell 5.1 (parse only, nothing runs)', { skip: process.platform !== 'win32' }, () => {
  const { execFileSync } = require('child_process');
  const f = path.join(tmpdir('cc-mach-'), 'uninstall.ps1');
  fs.writeFileSync(f, inv.PS_UNINSTALL);
  const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + f.replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'parsed'";
  assert.match(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, encoding: 'utf8' }), /parsed/);
});
