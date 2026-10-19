'use strict';
// CON-013 L9 (inventory mach-installed-inventory): installed apps and games. Read-only:
// Steam library folders and app manifests, the uninstall registry keys, and the config
// files each recipe in machine-advisors-recipes.js knows about. LOCAL ONLY: saved to
// <dataDir>/machine/inventory.json (see machine-scan.js PRIVACY).
const fs = require('fs');
const path = require('path');
const scan = require('./machine-scan');
const recipes = require('./machine-advisors-recipes');

// Valve KeyValues text (libraryfolders.vdf, appmanifest_*.acf, localconfig.vdf).
// Returns a plain object; duplicate keys keep the first value.
function parseVdf(text) {
  const s = String(text || '');
  const root = {};
  const stack = [root];
  let pendingKey = null;
  let i = 0;
  const readStr = () => {
    let out = '';
    i++; // opening quote
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) { const n = s[i + 1]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; i += 2; continue; }
      out += s[i++];
    }
    i++; // closing quote
    return out;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '"') {
      const v = readStr();
      if (pendingKey === null) pendingKey = v;
      else { const top = stack[stack.length - 1]; if (!(pendingKey in top)) top[pendingKey] = v; pendingKey = null; }
      continue;
    }
    if (c === '{') {
      const top = stack[stack.length - 1];
      const obj = {};
      if (pendingKey !== null && !(pendingKey in top)) top[pendingKey] = obj;
      stack.push(obj);
      pendingKey = null;
      i++;
      continue;
    }
    if (c === '}') { if (stack.length > 1) stack.pop(); pendingKey = null; i++; continue; }
    i++;
  }
  return root;
}

function readVdf(file) {
  try { return parseVdf(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function steamLibraries(steamDir) {
  if (!steamDir) return [];
  const v = readVdf(path.join(steamDir, 'steamapps', 'libraryfolders.vdf'));
  const out = [];
  const add = (p) => { const n = path.normalize(p); if (!out.some((x) => x.toLowerCase() === n.toLowerCase()) && fs.existsSync(path.join(n, 'steamapps'))) out.push(n); };
  if (!v) return fs.existsSync(path.join(steamDir, 'steamapps')) ? [path.normalize(steamDir)] : [];
  const lf = v.libraryfolders || v.LibraryFolders || {};
  for (const k of Object.keys(lf)) {
    const e = lf[k];
    if (typeof e === 'string' && /^\d+$/.test(k)) add(e); // old format: "1" "D:\\Lib"
    else if (e && typeof e.path === 'string') add(e.path);
  }
  if (!out.length && fs.existsSync(path.join(steamDir, 'steamapps'))) out.push(path.normalize(steamDir));
  return out;
}

function steamGames(steamDir) {
  const out = [];
  for (const lib of steamLibraries(steamDir)) {
    let names = [];
    try { names = fs.readdirSync(path.join(lib, 'steamapps')).filter((n) => /^appmanifest_\d+\.acf$/i.test(n)).sort(); } catch (e) { names = []; }
    for (const n of names) {
      const v = readVdf(path.join(lib, 'steamapps', n));
      const a = v && (v.AppState || v.appstate);
      if (!a || !a.appid) continue;
      out.push({ appid: String(a.appid), name: String(a.name || ''), install: path.join(lib, 'steamapps', 'common', String(a.installdir || '')), library: lib });
    }
  }
  return out;
}

// reg.exe query of the Steam client's own path (HKCU). Read-only.
async function steamRoot(deps) {
  deps = deps || {};
  const run = deps.runner || scan.defaultRunner;
  const r = await run('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {});
  if (!r || r.code !== 0) return null;
  const m = /SteamPath\s+REG_\w+\s+(.+?)\s*$/m.exec(String(r.stdout));
  return m ? path.normalize(m[1]) : null;
}

// Uninstall entries (HKLM, HKLM WOW6432Node, HKCU), read-only.
const PS_UNINSTALL = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$k = @("HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*", "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*")',
  '@(Get-ItemProperty $k | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation, SystemComponent, ParentKeyName, ReleaseType) | ConvertTo-Json -Depth 2 -Compress',
].join('\n');

function parseUninstall(raw) {
  let rows = [];
  try { rows = JSON.parse(String(raw || '').trim() || '[]'); } catch (e) { return []; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (!r || typeof r.DisplayName !== 'string' || !r.DisplayName.trim()) continue;
    if (r.SystemComponent === 1 || r.ParentKeyName || /update|hotfix/i.test(String(r.ReleaseType || '')) || /\(KB\d+\)/.test(r.DisplayName)) continue;
    const e = { name: r.DisplayName.trim(), version: String(r.DisplayVersion || ''), publisher: String(r.Publisher || ''), install: String(r.InstallLocation || '') };
    const key = (e.name + '|' + e.version).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function uninstallEntries(deps) {
  deps = deps || {};
  const run = deps.runner || scan.defaultRunner;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_UNINSTALL], {});
  return r && r.code === 0 ? parseUninstall(r.stdout) : [];
}

// %VAR% expansion against an injected env (process.env by default).
function expand(p, env) {
  env = env || process.env;
  return String(p).replace(/%([A-Za-z0-9_()]+)%/g, (m, k) => {
    const hit = Object.keys(env).find((x) => x.toLowerCase() === k.toLowerCase());
    return hit !== undefined ? env[hit] : m;
  });
}

function recipeConfigs(games, env) {
  const out = [];
  for (const r of recipes.list()) {
    const files = Object.keys(r.files).map((k) => {
      const p = expand(r.files[k].path, env);
      return { key: k, path: p, format: r.files[k].format || null, exists: !/%[^%]+%/.test(p) && fs.existsSync(p) };
    });
    const installed = !!(r.steam_appid && games.some((g) => g.appid === r.steam_appid));
    if (installed || files.some((f) => f.exists)) out.push({ recipe: r.id, title: r.title, installed, files });
  }
  return out;
}

async function buildInventory(deps) {
  deps = deps || {};
  const env = deps.env || process.env;
  const root = deps.steamDir || (await steamRoot(deps));
  const games = root ? steamGames(root) : [];
  const apps = await uninstallEntries(deps);
  return { schema: 1, apps, games, configs: recipeConfigs(games, env) };
}

function saveInventory(dataDir, inv) {
  return scan.writeMachineJson(dataDir, 'inventory.json', inv);
}

function loadInventory(dataDir) {
  return scan.readMachineJson(dataDir, 'inventory.json');
}

module.exports = { parseVdf, steamLibraries, steamGames, steamRoot, parseUninstall, uninstallEntries, PS_UNINSTALL, expand, recipeConfigs, buildInventory, saveInventory, loadInventory };
