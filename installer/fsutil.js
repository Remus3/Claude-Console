'use strict';
// Small file helpers for the installer. No dependencies. Deletes of anything a user may
// want back go through recycle(), which the callers inject in tests (
// irreplaceable data goes to the Recycle Bin, never a direct unlink).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function exists(p) {
  try { fs.statSync(p); return true; } catch (e) { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Relative file list under root, forward slashes, sorted. skip(rel, isDir) prunes.
function walk(root, skip) {
  const out = [];
  const rec = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (skip && skip(r, true)) continue;
        rec(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (skip && skip(r, false)) continue;
        out.push(r);
      }
    }
  };
  rec(root, '');
  return out.sort();
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyTree(src, dst, skip) {
  const files = walk(src, skip);
  for (const rel of files) copyFile(path.join(src, ...rel.split('/')), path.join(dst, ...rel.split('/')));
  return files;
}

// Recycle Bin on Windows (Microsoft.VisualBasic, no prompt). Only the real CLI uses it;
// every test injects its own recycle function.
function recycleWindows(target) {
  return new Promise((resolve, reject) => {
    const p = String(target).replace(/'/g, "''");
    const dir = isDir(target);
    const ps = 'Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::' +
      (dir ? 'DeleteDirectory' : 'DeleteFile') + "('" + p + "','OnlyErrorDialogs','SendToRecycleBin')";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 120000 }, (err) => {
      if (err) return reject(new Error('recycle failed: ' + err.message));
      resolve(true);
    });
  });
}

module.exports = { sha256File, sha256Buf, exists, isDir, readJson, writeJsonAtomic, walk, copyFile, copyTree, recycleWindows };
