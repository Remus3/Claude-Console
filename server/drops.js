'use strict';
// Composer attachments: files dropped / pasted / picked in the browser are uploaded here
// and saved under drops/YYYY-MM-DD/<unique-safe-name>, so the composer can put a real
// absolute path into the prompt (claude reads an image path as an image, any other
// path as a file). drops/ is gitignored; day folders older than 14 days go to the
// Recycle Bin (pruneDrops), never a direct unlink.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const KEEP_DAYS = 14;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function pad(n) {
  return String(n).padStart(2, '0');
}

function dayDir(now) {
  const d = new Date(now);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// A file name that is safe on Windows: basename only, ASCII letters/digits/._- and
// spaces, no leading dots, no reserved device names, at most 80 characters with the
// extension kept.
function safeName(name) {
  let base = path.basename(String(name || '').replace(/\\/g, '/'));
  base = base.replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/\s+/g, ' ').replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (!base) base = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(base)) base = '_' + base;
  if (base.length > 80) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 80 - ext.length) + ext;
  }
  return base;
}

function uniqueName(name, now) {
  const d = new Date(now);
  return pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' + crypto.randomBytes(3).toString('hex') + '-' + safeName(name);
}

// Stream the request body to drops/<day>/<unique>; resolves { path, name, size, image }
// or rejects with err.status 413 (over the cap) / 400.
function saveUpload(req, opts) {
  const now = opts.now || Date.now();
  const max = opts.maxBytes || MAX_UPLOAD_BYTES;
  return new Promise((resolve, reject) => {
    const fail = (status, msg) => {
      const e = new Error(msg);
      e.status = status;
      reject(e);
    };
    const declared = parseInt(req.headers['content-length'] || '', 10);
    if (Number.isFinite(declared) && declared > max) {
      req.resume();
      return fail(413, 'file over the ' + Math.round(max / 1048576) + ' MB cap');
    }
    const dir = path.join(opts.dropsDir, dayDir(now));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, uniqueName(opts.name, now));
    const tmp = file + '.part';
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let size = 0;
    let done = false;
    const abort = (status, msg) => {
      if (done) return;
      done = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(tmp, { force: true }, () => {});
      fail(status, msg);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        abort(413, 'file over the ' + Math.round(max / 1048576) + ' MB cap');
        req.resume();
      }
    });
    req.on('error', () => abort(400, 'upload interrupted'));
    req.on('aborted', () => abort(400, 'upload interrupted'));
    out.on('error', (e) => abort(500, 'cannot save: ' + e.code));
    out.on('finish', () => {
      if (done) return;
      done = true;
      if (!size) {
        fs.rm(tmp, { force: true }, () => {});
        return fail(400, 'empty file');
      }
      fs.rename(tmp, file, (e) => {
        if (e) return fail(500, 'cannot save: ' + e.code);
        resolve({ path: file, name: path.basename(file), size, image: IMAGE_EXT.has(path.extname(file).toLowerCase()) });
      });
    });
    req.pipe(out);
  });
}

// Day folders (YYYY-MM-DD) strictly older than `days` days.
function oldDropDirs(dropsDir, now, days) {
  const cutoff = new Date(now);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (days === undefined ? KEEP_DAYS : days));
  let names = [];
  try { names = fs.readdirSync(dropsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (e) { return []; }
  const out = [];
  for (const n of names) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(n);
    if (!m) continue;
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    if (t < cutoff.getTime()) out.push(path.join(dropsDir, n));
  }
  return out.sort();
}

// Send a folder to the Recycle Bin (Windows shell API through .NET), never unlink.
function recycle(dir) {
  return new Promise((resolve) => {
    const ps = "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($args[0], 'OnlyErrorDialogs', 'SendToRecycleBin')";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps, dir], { windowsHide: true, timeout: 60000 }, (err) => resolve(!err));
  });
}

async function pruneDrops(dropsDir, opts) {
  opts = opts || {};
  const rm = opts.recycle || recycle;
  const done = [];
  for (const d of oldDropDirs(dropsDir, opts.now || Date.now(), opts.days)) {
    if (await rm(d)) done.push(d);
  }
  return done;
}

module.exports = { MAX_UPLOAD_BYTES, KEEP_DAYS, safeName, uniqueName, dayDir, saveUpload, oldDropDirs, pruneDrops, recycle };
