'use strict';
// Timestamped zip backups (CON-PUBLIC D/F) with the bsdtar that ships in Windows 10+
// (System32\tar.exe writes zip with -a). node_modules is left out: it is restored by
// `npm ci` from the zipped package-lock.json.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stamp } = require('./paths');

function tarExe(env) {
  env = env || process.env;
  if (process.platform === 'win32') {
    const sys = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'tar';
}

function run(args, cwd) {
  const r = spawnSync(tarExe(), args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new Error('tar failed: ' + r.error.message);
  if (r.status !== 0) throw new Error('tar failed (' + r.status + '): ' + String(r.stderr || '').trim().slice(0, 300));
}

// Zips srcDir (its contents, not the dir itself) to backupsDir/<stamp>-<label>.zip.
function zipDir(srcDir, backupsDir, label, opts) {
  opts = opts || {};
  fs.mkdirSync(backupsDir, { recursive: true });
  const name = stamp(opts.now) + '-' + String(label || 'backup').replace(/[^0-9A-Za-z._-]/g, '_').slice(0, 60) + '.zip';
  const out = path.join(backupsDir, name);
  const args = ['-a', '-c', '-f', out];
  for (const ex of opts.exclude || ['node_modules']) args.push('--exclude', ex);
  // opts.entries: named top-level entries (no leading "./" in the zip, VMFIX).
  args.push('-C', srcDir, ...(opts.entries && opts.entries.length ? opts.entries : ['.']));
  run(args);
  return out;
}

function unzipTo(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  run(['-x', '-f', zipFile, '-C', destDir]);
  return destDir;
}

module.exports = { zipDir, unzipTo, tarExe };
