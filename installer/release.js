'use strict';
// Releases (CON-PUBLIC E). A release is a zip `claude-console-<version>.zip` holding the
// release files plus MANIFEST.json (SHA-256 per file), published with a sibling
// `claude-console-<version>.zip.sha256`. This module builds that locally, checks the
// GitHub releases API (one unauthenticated GET, ETag-cached, opt-out; no telemetry),
// downloads, verifies the zip hash and every file against the manifest, and extracts.
// Nothing here publishes: uploading a release waits for the operator's go (CON-PUBLIC A).
const fs = require('fs');
const path = require('path');
const { copyTree, sha256File, sha256Buf, readJson, writeJsonAtomic, exists } = require('./fsutil');
const { buildManifest, writeManifest, readManifest, verifyTree, skipRelease } = require('./manifest');
const { zipDir, unzipTo } = require('./backup');
const semver = require('./semver');
const { REPO_RE } = require('./settings');
const egress = require('./egress');

const assetName = (v) => 'claude-console-' + v + '.zip';

const SUMS = 'SHA256SUMS.txt';

// Builds the release assets in outDir (VMFIX): claude-console-<v>.zip (one top-level
// claude-console-<v>/ folder with MANIFEST.json), install.ps1 and the release notes
// copied from the source's release/ dir when present, and SHA256SUMS.txt covering the
// zip and install.ps1. The staging dir is removed again.
function buildRelease(srcDir, outDir, meta) {
  meta = meta || {};
  const pkg = readJson(path.join(srcDir, 'package.json'), {});
  const version = meta.version || pkg.version;
  if (!semver.valid(version)) throw new Error('bad version: ' + version);
  const top = 'claude-console-' + version;
  const stageRoot = path.join(outDir, '.stage-' + version);
  const stage = path.join(stageRoot, top);
  if (exists(stageRoot)) throw new Error('release staging exists: ' + stageRoot);
  fs.mkdirSync(stage, { recursive: true });
  copyTree(srcDir, stage, skipRelease);
  const manifest = buildManifest(stage, { version, channel: meta.channel || (semver.parse(version).pre ? 'beta' : 'stable'), created: meta.created });
  writeManifest(stage, manifest);
  const zipTmp = zipDir(stageRoot, outDir, 'tmp-' + version, { exclude: [], entries: [top] });
  const zip = path.join(outDir, assetName(version));
  fs.renameSync(zipTmp, zip);
  const manifestSha256 = sha256File(path.join(stage, 'MANIFEST.json'));
  fs.rmSync(stageRoot, { recursive: true, force: true }); // our own staging output
  const sha = sha256File(zip);
  const sums = [sha + '  ' + assetName(version)];
  const ps1 = path.join(srcDir, 'release', 'install.ps1');
  if (exists(ps1)) {
    fs.copyFileSync(ps1, path.join(outDir, 'install.ps1'));
    sums.push(sha256File(path.join(outDir, 'install.ps1')) + '  install.ps1');
  }
  fs.writeFileSync(path.join(outDir, SUMS), sums.join('\n') + '\n');
  const notes = path.join(srcDir, 'release', 'notes', version + '.md');
  if (exists(notes)) fs.copyFileSync(notes, path.join(outDir, 'RELEASE-NOTES-' + version + '.md'));
  const info = { version, channel: manifest.channel, asset: assetName(version), sha256: sha, files: Object.keys(manifest.files).length, manifestSha256, assets: fs.readdirSync(outDir).sort() };
  return { zip, sha256: sha, info };
}

// With a name: that file's hash out of a SHA256SUMS file (null when absent). Without:
// the first hash of a single-asset .sha256 file.
function parseShaFile(text, name) {
  const t = String(text || '');
  if (name) {
    for (const line of t.split(/\r?\n/)) {
      const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
      if (m && m[2] === name) return m[1].toLowerCase();
    }
    return null;
  }
  const m = /^([0-9a-f]{64})\b/i.exec(t.trim());
  return m ? m[1].toLowerCase() : null;
}

// Picks the newest release for the channel from a GitHub releases API list.
function pickRelease(list, channel, current) {
  let best = null;
  for (const r of Array.isArray(list) ? list : []) {
    if (!r || r.draft) continue;
    const v = String(r.tag_name || '').replace(/^v/, '');
    if (!semver.valid(v)) continue;
    const pre = !!semver.parse(v).pre || !!r.prerelease;
    if (pre && channel !== 'beta') continue;
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const zip = assets.find((a) => a && a.name === assetName(v));
    const one = assets.find((a) => a && a.name === assetName(v) + '.sha256');
    const sums = one ? null : assets.find((a) => a && a.name === SUMS);
    const sha = one || sums;
    if (!zip || !sha) continue;
    if (!best || semver.cmp(v, best.version) > 0) best = { version: v, zipUrl: zip.browser_download_url, shaUrl: sha.browser_download_url, sums: !!sums, prerelease: pre };
  }
  if (best && current && semver.valid(current) && semver.cmp(best.version, current) <= 0) return { latest: best, available: false };
  return { latest: best, available: !!best };
}

const GH_HOST = /^https:\/\/(api\.github\.com|github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;

// One GET of the releases list, ETag-cached in cacheFile. opts.fetch is injectable.
async function checkReleases(o) {
  if (!o.settings || o.settings.check === false) return { checked: false, reason: 'check-off' };
  const repo = o.settings.repo;
  if (!repo || !REPO_RE.test(repo)) return { checked: false, reason: 'no-repo' };
  const doFetch = o.fetch || globalThis.fetch;
  const cache = readJson(o.cacheFile, {}) || {};
  const url = 'https://api.github.com/repos/' + repo + '/releases?per_page=30';
  egress.check(url, 'update'); // CON-013 e.1: the one allowed update host, logged
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-console-updater' };
  if (cache.url === url && cache.etag) headers['If-None-Match'] = cache.etag;
  let body;
  const res = await doFetch(url, { headers });
  if (res.status === 304 && cache.body) {
    body = cache.body;
  } else if (res.status === 200) {
    body = await res.json();
    const etag = res.headers && typeof res.headers.get === 'function' ? res.headers.get('etag') : null;
    writeJsonAtomic(o.cacheFile, { url, etag: etag || null, body, at: new Date().toISOString() });
  } else {
    return { checked: false, reason: 'http-' + res.status };
  }
  const pick = pickRelease(body, o.settings.channel, o.current);
  return Object.assign({ checked: true, cached: res.status === 304 }, pick);
}

async function getBuffer(doFetch, url) {
  if (!GH_HOST.test(url)) throw new Error('refused download host');
  egress.check(url, 'update');
  const res = await doFetch(url, { headers: { 'User-Agent': 'claude-console-updater', Accept: 'application/octet-stream' } });
  if (res.status !== 200) throw new Error('download http ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Downloads the zip + .sha256, verifies, extracts to destRoot/claude-console-<v>/ and
// verifies every file against its MANIFEST. Returns the extracted dir.
async function downloadRelease(latest, destRoot, opts) {
  opts = opts || {};
  const doFetch = opts.fetch || globalThis.fetch;
  fs.mkdirSync(destRoot, { recursive: true });
  const want = parseShaFile((await getBuffer(doFetch, latest.shaUrl)).toString('utf8'), latest.sums ? assetName(latest.version) : undefined);
  if (!want) throw new Error('bad checksum asset (no hash for ' + assetName(latest.version) + ')');
  const buf = await getBuffer(doFetch, latest.zipUrl);
  if (sha256Buf(buf) !== want) throw new Error('release zip SHA-256 mismatch');
  const zip = path.join(destRoot, assetName(latest.version));
  fs.writeFileSync(zip, buf);
  return extractRelease(zip, path.join(destRoot, 'claude-console-' + latest.version), latest.version);
}

function extractRelease(zip, dest, version) {
  if (exists(dest)) fs.rmSync(dest, { recursive: true, force: true }); // our own scratch extraction dir
  unzipTo(zip, dest);
  // A release zip holds one top-level claude-console-<v>/ folder (VMFIX); older ones
  // held the files at the root.
  let dir = dest;
  if (!exists(path.join(dest, 'MANIFEST.json'))) {
    const subs = fs.readdirSync(dest, { withFileTypes: true }).filter((e) => e.isDirectory() && /^claude-console-/.test(e.name));
    if (subs.length === 1) dir = path.join(dest, subs[0].name);
  }
  return verifyReleaseDir(dir, version);
}

function verifyReleaseDir(dir, version) {
  const m = readManifest(dir);
  if (!m) throw new Error('release has no MANIFEST.json');
  if (version && m.version !== version) throw new Error('manifest version ' + m.version + ' != ' + version);
  const v = verifyTree(dir, m);
  if (!v.ok) throw new Error('release files fail the manifest: ' + v.missing.concat(v.mismatch).slice(0, 5).join(', '));
  return { dir, manifest: m };
}

module.exports = { buildRelease, pickRelease, checkReleases, downloadRelease, extractRelease, verifyReleaseDir, parseShaFile, assetName, SUMS };
