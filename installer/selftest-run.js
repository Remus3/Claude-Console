'use strict';
// Post-update self-test, run as `node installer/selftest-run.js <expectedVersion>` with
// cwd = the new app dir (CON-PUBLIC D). It loads THAT version's server on an ephemeral
// port with scratch data/run dirs (the user's data is never opened), checks
// /api/info answers with the expected version, then closes. Pollers that reach outside
// (optional integrations, resources, plugins) are off. Exit 0 = pass. One JSON line out.
const fs = require('fs');
const os = require('os');
const path = require('path');

async function main() {
  const want = process.argv[2] || null;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-selftest-'));
  const out = { ok: false, version: null, want };
  let srv;
  try {
    const { createConsoleServer } = require(path.join(__dirname, '..', 'server', 'server.js'));
    const scan = path.join(tmp, 'scan');
    fs.mkdirSync(scan);
    srv = await createConsoleServer({
      port: 0, dataDir: path.join(tmp, 'data'), runDir: path.join(tmp, 'run'), dropsDir: path.join(tmp, 'drops'), mainPlugin: false,
      overrides: { scanRoots: [scan], extraProjects: [], projects: {}, resources: { enabled: false }, plugins: { main: { enabled: false } }, boardsFile: null },
    });
    const r = await fetch('http://127.0.0.1:' + srv.port + '/api/info', { headers: { 'X-Console-Token': srv.token } });
    const j = await r.json();
    out.version = j.version;
    out.ok = r.status === 200 && (!want || j.version === want);
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 300);
  } finally {
    if (srv) await srv.close().catch(() => {});
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (e) { /* hygiene sweep */ }
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(out.ok ? 0 : 1);
}

main();
