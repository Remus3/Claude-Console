'use strict';
// Claude Console server: 127.0.0.1 only, per-start random token on every API and
// WebSocket call, node-pty terminals streamed to xterm.js.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const { loadConfig, readJson } = require('./config');
const toolsMod = require('./tools');
const boards = require('./boards');
const { sanitizeGroups } = require('./groups');
const uiprefs = require('./uiprefs');
const { discoverProjects } = require('./discovery');
const { StatusService } = require('./status');
const { PaneManager } = require('./panes');
const { resolveClaude } = require('./claudeenv');
const drops = require('./drops');
const { CommandCatalog } = require('./commands');
const fsbrowse = require('./fsbrowse');
const usagePrefs = require('./usage');
const { ResourceSampler } = require('./resources');
const health = require('./health');
const mainPlugin = { mainConfig: () => null, MainPlugin: null }; // no plugin ships
const { createUpdates } = require('./updates');
const scheduler = require('./scheduler');
const { createBackendRoutes } = require('./backendroutes');
const { HealthSchedule } = require('./healthsched');
const { Watchdog } = require('./watchdog');
// CON-013 L5: setup profile, crash report, stop everything / recovery, machine profile.
const { createProfileRoutes } = require('./profile-routes');
const { createAdoptRoutes } = require('./adopt-routes');
const recover = require('../installer/recover');

const VERSION = require('../package.json').version;
const PUBLIC = path.join(__dirname, '..', 'public');
const NM = path.join(__dirname, '..', 'node_modules');

const VENDOR = {
  'xterm.js': path.join(NM, '@xterm', 'xterm', 'lib', 'xterm.js'),
  'xterm.css': path.join(NM, '@xterm', 'xterm', 'css', 'xterm.css'),
  'addon-fit.js': path.join(NM, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
  'addon-search.js': path.join(NM, '@xterm', 'addon-search', 'lib', 'addon-search.js'),
  'addon-web-links.js': path.join(NM, '@xterm', 'addon-web-links', 'lib', 'addon-web-links.js'),
};
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
  // Shared design tokens (UX-1 R4).
  '/tokens.css': 'tokens.css',
  '/favicon.svg': 'favicon.svg',
  // CON-013 L5: setup profile UI (browser, wizard, adopt, machine advisor) and recovery.
  '/profile.js': 'profile.js',
  '/profile.css': 'profile.css',
  '/setup-paths.js': 'setup-paths.js',
  '/recovery.js': 'recovery.js',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const DEFAULT_SETTINGS = {
  theme: 'system',
  fontSize: 16,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  lineHeight: 1.2,
  defaultAccount: null, // "Main / orchestrator account": new claude panes start on it
  headlessAccount: null, // "Headless lane account" (v19.1 B): same as main = single, else split
  defaultShell: null,
  scrollback: 10000,
  idleBadge: true,
  desktopNotify: false,
  statusPanel: true,
  statusWidth: 380,
  // quickChips (CON-UX-KEYS: list of { text, on }) comes from uiprefs.UI_DEFAULTS below
  projectOrder: [], // drag order of the Projects list (project ids)
  cardOrder: [], // drag order of the status panel cards (project ids)
  sidebarGroups: [], // operator-made Projects sidebar groups (server/groups.js)
  ...uiprefs.UI_DEFAULTS, // S49 CON-UX-* per-machine UI prefs (server/uiprefs.js)
};

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 1048576)) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, code, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {}));
  res.end(body);
}

async function createConsoleServer(opts) {
  opts = opts || {};
  const cfg = loadConfig(opts);
  const host = '127.0.0.1'; // never anything else
  const token = opts.token || crypto.randomBytes(24).toString('hex');
  const claudePath = resolveClaude(cfg);
  let projects = await discoverProjects(cfg);
  let tools = toolsMod.loadTools(cfg, opts.toolsFile).tools;
  const panes = new PaneManager(cfg, { claudePath });
  const status = new StatusService(cfg, () => projects);
  panes.markerFor = (pid) => status.markers[pid] || null;
  // CON-013 L5 (addendum e.3): every pane process is recorded in run/spawned/<pid>.json
  // {pid, kind, name (image), startMs} so "Stop everything" can stop console-spawned
  // trees by recorded pid only; the record goes when the process exits.
  const recordPid0 = panes.recordPid.bind(panes);
  panes.recordPid = (rec) => {
    recordPid0(rec);
    const pane = panes.get(rec.paneId);
    trackSpawn(rec.pid, 'pane', pane && pane.file, rec.startedAt, pane && pane.proc);
  };
  function trackSpawn(pid, kind, file, startMs, child) {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { recover.registerSpawn(cfg.runDir, { pid, kind, name: file ? path.basename(String(file)) : null, startMs: startMs || Date.now() }); } catch (e) { return; }
    const drop = () => recover.unregisterSpawn(cfg.runDir, pid);
    try { if (child && typeof child.onExit === 'function') child.onExit(drop); else if (child && typeof child.on === 'function') child.on('exit', drop); } catch (e) { /* the record stays; stop-all re-checks the live process first */ }
  }
  // Headless children (the optional plugin's jobs) are recorded the same way.
  const trackedSpawn = (kind) => (file, args, o) => {
    const c = spawn(file, args, o);
    trackSpawn(c.pid, kind, file, Date.now(), c);
    return c;
  };
  // CON-PUBLIC D/E/F: Settings > "Updates & repair" backend (server/updates.js).
  const updates = createUpdates({ cfg, version: VERSION, panes: () => panes.list(), deps: opts.updatesDeps });
  // CON-PANE-VANISH: pane open / exit / close lines in run/server.log (main() passes
  // opts.log; test instances log nowhere unless they ask).
  const plog = typeof opts.log === 'function' ? opts.log : () => {};
  const who = (req) => (req.headers.origin ? 'page' : 'no-origin') + ' ua=' + String(req.headers['user-agent'] || '-').split(/[\s/]/)[0].replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
  panes.on('added', (info) => {
    const p = panes.get(info.id);
    if (p) p.on('exit', (code) => plog('pane ' + p.id + ' exited "' + p.title + '" code=' + code + ' after ' + Math.round((Date.now() - p.startedAt) / 1000) + 's'));
  });
  const settingsFile = path.join(cfg.dataDir, 'settings.json');
  const layoutFile = path.join(cfg.dataDir, 'layout.json');
  let port = opts.port === undefined ? cfg.port : opts.port;
  const dropsDir = opts.dropsDir || cfg.dropsDir || path.join(cfg.root, 'drops');
  const uploadMax = opts.uploadMaxBytes || cfg.uploadMaxBytes || drops.MAX_UPLOAD_BYTES;
  const commands = new CommandCatalog();
  let broadcastRef = () => {};
  // CON-RES: top-bar resource readout (server/resources.js), pushed on /ws/events
  // as {t: 'res'}; the sampler child runs only while a page is connected.
  const resources = new ResourceSampler(cfg, { enabled: opts.resources, spawn: opts.resSpawn, statfs: opts.resStatfs, os: opts.resOs, viewers: () => eventClients.size, onSnap: (x) => broadcastRef({ t: 'res', res: x }) });
  // HEALTH (order 2026-10-18 "v19.1" A): Settings > Health & cleanup. Console steps in
  // core (server/health.js); PC / Repo / LLM steps and the headless route only through the
  // optional plugin (server/plugins/main.js), off without `plugins.main.enabled`.
  // A server on a non-default data dir (every test and the isolated e2e) never runs the
  // real plugin unless it asks with opts.mainPlugin === true.
  const pluginAllowed = opts.mainPlugin === true || (opts.mainPlugin === undefined && !opts.dataDir);
  const mainCfg = pluginAllowed ? mainPlugin.mainConfig(cfg, cfg.runDir) : null;
  const mainPl = mainCfg ? new mainPlugin.MainPlugin(mainCfg, { spawn: opts.mainPluginSpawn || trackedSpawn('headless') }) : null;
  const memSampler = new health.MemSampler({ intervalMs: opts.memSampleMs, mem: opts.memUsage });
  const healthRunner = new health.HealthRunner({
    // CON-013 L5: the machine steps (L9; report-only, off by default) mount beside the
    // Console steps; their repo list follows the discovered projects.
    core: Object.assign(health.coreRunners({ panes, dropsDir, mem: memSampler, pruneDrops: opts.healthPruneDrops, listProcesses: opts.healthListProcesses, killTree: opts.healthKillTree }),
      health.machineRunners(Object.assign({ get repos() { return projects.map((x) => x.dir); } }, opts.machineHealth || {}))),
    steps: health.CORE_STEPS.concat(health.MACHINE_STEPS),
    plugins: mainPl ? [mainPl] : [],
    busy: () => null,
    suiteHolders: opts.healthSuiteHolders,
    reportDir: mainCfg ? mainCfg.reportDir : path.join(cfg.dataDir, 'health'),
    progressFile: mainCfg ? mainCfg.progressFile : path.join(cfg.runDir, 'health-progress.json'),
    onChange: (st) => broadcastRef({ t: 'health', health: st }),
  });
  // Account config dir as the kit route needs it (null configDir = the default ~/.claude).
  const acctDir = (id) => (hasAcct(id) ? cfg.accounts[id].configDir || path.join(os.homedir(), '.claude') : null);
  // The account the second-account proxy pin bills (config `headlessProxy: true`).
  const proxyAcct = () => Object.keys(cfg.accounts || {}).find((k) => cfg.accounts[k] && cfg.accounts[k].headlessProxy === true) || null;
  // v19.1 B: the route the two SAVED picks ask for. Explicit only: no stored headless
  // pick = none; same pick = single; split only onto the proxy account.
  function routeDesired(s) {
    const main = s.defaultAccount;
    const hl = s.headlessAccount;
    if (!hasAcct(hl) || !hasAcct(main)) return { mode: null, main, headless: null, error: 'choose the headless lane account first' };
    if (hl === main) return { mode: 'single', main, headless: hl };
    if (hl === proxyAcct()) return { mode: 'split', main, headless: hl };
    return { mode: null, main, headless: hl, error: 'split sends headless runs through the proxy, which bills ' + (proxyAcct() ? (cfg.accounts[proxyAcct()].label || proxyAcct()) : 'no configured account') + '; pick that account or the main account' };
  }
  function hasAcct(id) {
    return typeof id === 'string' && !!cfg.accounts && Object.prototype.hasOwnProperty.call(cfg.accounts, id) && !!cfg.accounts[id];
  }
  const isLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ''));

  const allowedHost = (h) => {
    if (!h) return false;
    const m = /^(127\.0\.0\.1|localhost)(?::(\d+))?$/i.exec(h);
    return !!m && (!m[2] || +m[2] === port);
  };
  const allowedOrigin = (o) => !o || o === 'null' ? !o : /^http:\/\/(127\.0\.0\.1|localhost):(\d+)$/i.test(o) && +o.split(':')[2] === port;
  // G3 backend (CON-SCHEDULER): a server on a non-default data dir (every test and the
  // isolated e2e) never gets the real OS runner unless it passes opts.schedRunner.
  const sched = new scheduler.Scheduler({ runner: opts.schedRunner || (opts.dataDir ? null : scheduler.realRunner), dataDir: cfg.dataDir, runDir: cfg.runDir, projects: () => projects, consoleRoot: cfg.root });
  // CON-HEALTH-SCHED: the scheduled health check, registered through the scheduler;
  // Main-only (needs a plugin config), refused with a reason otherwise.
  const healthSchedule = new HealthSchedule({ scheduler: sched, mc: mainCfg });
  // CON-WATCHDOG: observe-only collector (thresholds from config, nothing reported out).
  const watchdog = new Watchdog({ runner: opts.watchdogRunner || (opts.dataDir ? null : scheduler.realRunner), dataDir: cfg.dataDir, cfg, projects: () => projects, consoleRoot: cfg.root });
  watchdog.start();
  const backendRoutes = createBackendRoutes({ scheduler: sched, healthSchedule, watchdog, send, readBody, isLoopback, log: plog });
  // CON-013 L5: setup profile routes. A server on a non-default data dir (every test and
  // the isolated e2e) gets no OS adapters, a sandboxed config dir and refusing browser /
  // clipboard / kill hooks unless opts.profile passes fakes; only the real console
  // (default data dir) writes the registry, the scheduler or the user's Claude settings.
  const profileReal = !opts.dataDir;
  const defAcct = cfg.accounts && cfg.accounts[cfg.defaultAccount];
  const profileOpts = Object.assign({
    real: profileReal,
    profileDir: path.join(__dirname, '..', 'profile'),
    dataDir: cfg.dataDir,
    runDir: cfg.runDir,
    configDir: profileReal ? ((defAcct && defAcct.configDir) || path.join(os.homedir(), '.claude')) : path.join(cfg.dataDir, 'claude-config'),
    deps: profileReal ? require('../installer/profile-tx').defaultAdapters({ dataDir: cfg.dataDir }) : {},
    updateDir: path.join(cfg.dataDir, 'profile', 'next'),
    projects: () => projects,
    version: VERSION,
    token,
  }, opts.profile || {});
  const profileRoutes = createProfileRoutes({ send, readBody, isLoopback, log: plog, profile: profileOpts });
  // INTEGRATE-2 (c): /api/profile/adopt on the real L3x facade (openAdopt), ahead of the
  // profile routes.
  const adoptRoutes = createAdoptRoutes({ send, readBody, isLoopback, log: plog, profile: profileOpts });

  function settings() {
    const s = Object.assign({}, DEFAULT_SETTINGS, readJson(settingsFile, {}));
    if (!hasAcct(s.defaultAccount)) s.defaultAccount = cfg.defaultAccount;
    if (!hasAcct(s.headlessAccount)) s.headlessAccount = null;
    if (!s.defaultShell || !(cfg.shells || {})[s.defaultShell]) s.defaultShell = cfg.defaultShell;
    return uiprefs.sanitizeUiPrefs(s);
  }

  function projectById(id) {
    return projects.find((p) => p.id === id) || null;
  }

  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    // Hook endpoint: authenticated by the per-pane secret instead of the master token.
    if (p === '/api/hook' && m === 'POST') {
      const b = await readBody(req, 65536);
      const ok = panes.hook(String(b.pane || ''), b.secret, String(b.event || ''), typeof b.note === 'string' ? b.note.slice(0, 200) : null, typeof b.sessionId === 'string' ? b.sessionId : null, typeof b.toolName === 'string' ? b.toolName : null, typeof b.source === 'string' ? b.source.slice(0, 16) : null);
      return send(res, ok ? 200 : 403, { ok });
    }
    if (!safeEqual(req.headers['x-console-token'], token)) return send(res, 401, { error: 'token required' });
    if (await backendRoutes(req, res, p, m, url)) return;
    if (await adoptRoutes(req, res, p, m, url)) return;
    if (await profileRoutes(req, res, p, m, url)) return;

    // Composer attachment: raw body (no JSON), loopback peers only, size-capped.
    if (p === '/api/upload' && m === 'POST') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      try {
        const r = await drops.saveUpload(req, { dropsDir, name: url.searchParams.get('name') || 'file', maxBytes: uploadMax });
        return send(res, 200, r);
      } catch (e) {
        res.setHeader('Connection', 'close');
        return send(res, e.status || 500, { error: e.message });
      }
    }

    if (p === '/api/info' && m === 'GET') {
      return send(res, 200, {
        version: VERSION, claudePath, claudeFound: !!claudePath, hooks: !!cfg.useHooks,
        accounts: Object.entries(cfg.accounts).map(([id, a]) => ({ id, label: a.label || id, headlessProxy: a.headlessProxy === true })),
        defaultAccount: cfg.defaultAccount,
        shells: Object.entries(cfg.shells || {}).filter(([, s]) => fs.existsSync(s.file)).map(([id, s]) => ({ id, label: s.label || id })),
        defaultShell: cfg.defaultShell, idleSeconds: cfg.idleSeconds, pid: process.pid,
        uploadMaxBytes: uploadMax,
      });
    }
    if (p === '/api/projects' && m === 'GET') return send(res, 200, { projects });
    // Remove a project LISTING (CON-7): the project gets `hidden: true` in
    // data/console.local.json (merged over config/console.json, so a rescan keeps it
    // out). Its folder and files are never touched. Refused while it has live panes.
    const rm = /^\/api\/projects\/([a-z0-9-]{1,80})$/.exec(p);
    if (rm && m === 'DELETE') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const proj = projectById(rm[1]);
      if (!proj) return send(res, 404, { error: 'unknown project' });
      const live = panes.list().filter((x) => x.projectId === proj.id);
      if (live.length) return send(res, 409, { error: 'Close the ' + live.length + ' open pane' + (live.length === 1 ? '' : 's') + ' of ' + proj.name + ' first.', panes: live.length });
      const localFile = path.join(cfg.dataDir, 'console.local.json');
      const local = readJson(localFile, {});
      if (!local.projects || typeof local.projects !== 'object' || Array.isArray(local.projects)) local.projects = {};
      local.projects[proj.name] = Object.assign({}, local.projects[proj.name], { hidden: true });
      writeJsonAtomic(localFile, local);
      cfg.projects = Object.assign({}, cfg.projects);
      cfg.projects[proj.name] = Object.assign({}, cfg.projects[proj.name], { hidden: true });
      // Drop the id from the operator's orders and groups so nothing dangles.
      const s = readJson(settingsFile, null);
      if (s) {
        const lid = proj.id;
        if (Array.isArray(s.projectOrder)) s.projectOrder = s.projectOrder.filter((x) => x !== lid);
        if (Array.isArray(s.cardOrder)) s.cardOrder = s.cardOrder.filter((x) => x !== lid);
        if (Array.isArray(s.sidebarGroups)) s.sidebarGroups = sanitizeGroups(s.sidebarGroups.map((g) => Object.assign({}, g, { items: Array.isArray(g.items) ? g.items.filter((it) => it !== 'p:' + lid) : g.items })));
        writeJsonAtomic(settingsFile, s);
      }
      projects = await discoverProjects(cfg);
      status.refreshFiles();
      status.refreshGit();
      return send(res, 200, { ok: true, removed: proj.id, projects });
    }
    // New-pane folder picker (CON-4): drive letters and subfolders, read-only.
    if ((p === '/api/fs/drives' || p === '/api/fs/list') && m === 'GET') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      if (p === '/api/fs/drives') return send(res, 200, { drives: fsbrowse.listDrives() });
      try {
        return send(res, 200, fsbrowse.listDir(url.searchParams.get('path')));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }
    // Slash-command drop-up (CON-5): commands + skills of the project (or the pane's
    // cwd) and of the account's config dir, plus the CLI built-ins. Read-only.
    if (p === '/api/commands' && m === 'GET') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const q = url.searchParams;
      const pane = q.get('pane') ? panes.get(q.get('pane')) : null;
      const proj = q.get('project') ? projectById(q.get('project')) : (pane && pane.projectId ? projectById(pane.projectId) : null);
      if (q.get('project') && !proj) return send(res, 404, { error: 'unknown project' });
      const acctId = q.get('account') || (pane && pane.account) || settings().defaultAccount;
      const acct = cfg.accounts[acctId];
      if (!acct) return send(res, 404, { error: 'unknown account' });
      const projectDir = proj ? proj.dir : (pane ? pane.cwd : null);
      const configDir = acct.configDir || path.join(os.homedir(), '.claude');
      return send(res, 200, { commands: commands.list(projectDir, configDir) });
    }
    if (p === '/api/tools' && m === 'GET') {
      tools = toolsMod.loadTools(cfg, opts.toolsFile).tools; // re-read: config edits show on reload
      return send(res, 200, { tools: tools.map((t) => toolsMod.publicTool(t, projects)) });
    }
    // Add a tool (CON-TOOL-ADD). POST /api/tools {label, path, args?, cwd?, project?,
    // group?} from the +Tool dialog; POST /api/tools/drop {project?, group?, items}
    // from files dropped on the Projects list. Both validate on the server (absolute
    // and existing, or an http(s) URL; a .lnk is resolved to its target) and write
    // only data/tools.local.json (+ the group's items in settings.json).
    if ((p === '/api/tools' || p === '/api/tools/drop') && m === 'POST') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const b = await readBody(req, 2 * 1048576);
      const proj = b.project ? projectById(String(b.project)) : null;
      if (b.project && !proj) return send(res, 404, { error: 'unknown project' });
      const s0 = readJson(settingsFile, {}) || {};
      const groups = Array.isArray(s0.sidebarGroups) ? sanitizeGroups(s0.sidebarGroups) : [];
      const grp = b.group ? groups.find((g) => g.id === String(b.group)) : null;
      if (b.group && !grp) return send(res, 404, { error: 'unknown group' });
      if (!proj && !grp) return send(res, 400, { error: 'Choose a project or group for the tool.' });
      const deps = { execFile: opts.toolExecFile };
      const added = [];
      const unresolved = [];
      const add = (label, built, title) => {
        tools = toolsMod.loadTools(cfg, opts.toolsFile).tools;
        const id = toolsMod.addLocalTool(cfg, { project: proj ? proj.id : null, label, title, launch: built.launch }, tools.map((x) => x.id), writeJsonAtomic);
        added.push(id);
      };
      if (p === '/api/tools') {
        const label = toolsMod.cleanText(b.label, 80);
        if (!label) return send(res, 400, { error: 'Name must be 1 to 80 characters.' });
        const built = await toolsMod.buildLaunch({ path: b.path, args: b.args, cwd: b.cwd }, deps);
        if (!built.ok) return send(res, 400, { error: built.error });
        add(label, built, built.source ? 'Shortcut ' + built.source : '');
      } else {
        const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
        if (!items.length) return send(res, 400, { error: 'nothing dropped' });
        const dirs = opts.desktopDirs || toolsMod.desktopDirs();
        for (const it of items) {
          const name = toolsMod.cleanText(it && it.name, 255) || '';
          let target = null;
          let tmp = null;
          if (it && typeof it.url === 'string' && /^https?:\/\//i.test(it.url)) target = it.url;
          else if (it && typeof it.path === 'string' && it.path) target = it.path;
          // A .lnk: the browser handed its bytes, so the dropped shortcut itself is
          // resolved from a private temp copy (removed right after), wherever it lives.
          else if (it && typeof it.lnk === 'string' && it.lnk && /\.lnk$/i.test(name) && it.lnk.length < 200000) {
            tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-lnk-'));
            target = path.join(tmp, 'drop.lnk');
            fs.writeFileSync(target, Buffer.from(it.lnk, 'base64'));
          } else if (name) target = toolsMod.findOnDesktop(name, dirs);
          let built = null;
          try {
            built = target ? await toolsMod.buildLaunch({ path: target }, deps) : { ok: false, error: 'Could not find "' + name + '" on the Desktop. Type its full path.' };
          } finally {
            if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* hygiene sweep */ } }
          }
          let label = toolsMod.cleanText(it && it.label, 80);
          if (!label && built && built.ok && built.kind === 'open' && /^https?:/i.test(target)) { try { label = new URL(target).hostname; } catch (e) { label = null; } }
          if (!label) label = toolsMod.cleanText(toolsMod.labelFromPath(name || target, !!(it && it.dir) || !!(built && built.isDir)), 80) || 'Tool';
          if (!built.ok) { unresolved.push({ name, label, error: built.error }); continue; }
          add(label, built, built.source ? 'Shortcut ' + (tmp ? name : built.source) : '');
        }
      }
      let settingsOut = null;
      if (grp && added.length) {
        const s = readJson(settingsFile, {}) || {};
        s.sidebarGroups = sanitizeGroups((Array.isArray(s.sidebarGroups) ? s.sidebarGroups : []).map((g) => (g.id === grp.id ? Object.assign({}, g, { open: true, items: (Array.isArray(g.items) ? g.items : []).concat(added.map((id) => 't:' + id)) }) : g)));
        writeJsonAtomic(settingsFile, s);
        settingsOut = settings();
      }
      tools = toolsMod.loadTools(cfg, opts.toolsFile).tools;
      return send(res, added.length || p === '/api/tools/drop' ? 200 : 400, { ok: true, added, unresolved, tools: tools.map((x) => toolsMod.publicTool(x, projects)), settings: settingsOut });
    }
    // Edit / remove a tool row (CON-PROJ-EDIT): PATCH {label?, path?} renames it or
    // points it at another target (validated: absolute and existing, or an http(s)
    // URL for a page); DELETE hides it. Both write only data/tools.local.json
    // (overrides); the target on disk is never touched.
    const te = /^\/api\/tools\/([a-z0-9-]{1,48})$/.exec(p);
    if (te && (m === 'PATCH' || m === 'DELETE')) {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      tools = toolsMod.loadTools(cfg, opts.toolsFile).tools;
      const t = tools.find((x) => x.id === te[1]);
      if (!t) return send(res, 404, { error: 'unknown tool' });
      if (m === 'DELETE') {
        toolsMod.removeTool(cfg, t.id, writeJsonAtomic);
        const s = readJson(settingsFile, null);
        if (s && Array.isArray(s.sidebarGroups)) {
          s.sidebarGroups = sanitizeGroups(s.sidebarGroups.map((g) => Object.assign({}, g, { items: Array.isArray(g.items) ? g.items.filter((it) => it !== 't:' + t.id) : g.items })));
          writeJsonAtomic(settingsFile, s);
        }
      } else {
        const b = await readBody(req, 65536);
        const patch = {};
        if (b.label !== undefined) {
          const label = typeof b.label === 'string' ? b.label.replace(/\s+/g, ' ').trim() : '';
          if (!label || label.length > 80 || /[\u0000-\u001f]/.test(label)) return send(res, 400, { error: 'Name must be 1 to 80 characters.' });
          patch.label = label;
        }
        if (b.path !== undefined) {
          const v = toolsMod.validateToolPath(t, b.path);
          if (!v.ok) return send(res, 400, { error: v.error });
          patch.path = v.path;
        }
        if (!Object.keys(patch).length) return send(res, 400, { error: 'nothing to change' });
        toolsMod.saveOverride(cfg, t.id, patch, writeJsonAtomic);
      }
      tools = toolsMod.loadTools(cfg, opts.toolsFile).tools;
      return send(res, 200, { ok: true, tools: tools.map((x) => toolsMod.publicTool(x, projects)) });
    }
    const tm = /^\/api\/tools\/([a-z0-9-]{1,48})\/launch$/.exec(p);
    if (tm && m === 'POST') {
      const t = tools.find((x) => x.id === tm[1]);
      if (!t) return send(res, 404, { error: 'unknown tool' });
      const r = await toolsMod.launchTool(t, { spawn: opts.toolSpawn, portOpen: opts.toolPortOpen, waitMs: opts.toolWaitMs });
      return send(res, r.ok ? 200 : 400, r.ok ? { ok: true } : { error: r.error });
    }
    // CON-BOARD-LINK: open a project's status board. The server resolves the URL
    // itself (no URL from the page) and boards.openBoard re-validates it.
    const bm = /^\/api\/projects\/([a-z0-9-]{1,80})\/board$/.exec(p);
    if (bm && m === 'POST') {
      const proj = projectById(bm[1]);
      if (!proj) return send(res, 404, { error: 'unknown project' });
      const r = boards.openBoard(boards.resolveBoard(proj, cfg), opts.toolSpawn);
      return send(res, r.ok ? 200 : 404, r.ok ? { ok: true } : { error: r.error });
    }
    if (p === '/api/projects/rescan' && m === 'POST') {
      projects = await discoverProjects(cfg);
      status.refreshFiles();
      status.refreshGit();
      return send(res, 200, { projects });
    }
    if (p === '/api/status' && m === 'GET') return send(res, 200, status.snapshot);
    if (p === '/api/resources' && m === 'GET') {
      resources.touch();
      resources.tick();
      return send(res, 200, Object.assign({ enabled: resources.enabled }, resources.publicSnap()));
    }
    if (p === '/api/health' && m === 'GET') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      return send(res, 200, Object.assign({ enabled: true, plugins: mainPl ? ['main'] : [], steps: await healthRunner.plan() }, healthRunner.state()));
    }
    if (p === '/api/health/run' && m === 'POST') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const b = await readBody(req, 4096);
      const r = await healthRunner.start(b && b.steps);
      plog('health run ' + (r.run ? '#' + r.run.id + ' ' + r.run.steps.map((x) => x.id).join(',') : 'refused ' + r.status + ' ' + r.error));
      return send(res, r.status, r.run ? { run: r.run } : { error: r.error });
    }
    // v19.1 B: the headless route. Desired mode comes from the saved settings only;
    // the kit CLI is the only writer of the route file (plugin).
    if (p === '/api/route' && (m === 'GET' || m === 'POST')) {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const want = routeDesired(settings());
      const why = want.error ? { error: want.error } : {};
      if (!mainPl) return send(res, 200, Object.assign({ plugin: false, desired: want.mode, kit: { supported: false, mode: null, valid: false, reason: 'no plugin: the choice is stored only' } }, why));
      if (m === 'GET') return send(res, 200, Object.assign({ plugin: true, desired: want.mode, kit: await mainPl.routeShow() }, why));
      if (!want.mode) return send(res, 400, { plugin: true, desired: null, error: want.error });
      const allowed = Object.keys(cfg.accounts).map(acctDir);
      const r = await mainPl.routeSet(want.mode, want.mode === 'single' ? acctDir(want.main) : null, allowed);
      plog('headless route set ' + want.mode + ' -> ' + r.status);
      return send(res, r.status, Object.assign({ plugin: true, desired: want.mode, kit: r.route || null }, r.error ? { error: r.error } : {}));
    }
    if (p === '/api/settings' && m === 'GET') return send(res, 200, settings());
    if (p === '/api/settings' && m === 'PUT') {
      const b = await readBody(req);
      const cur = settings();
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (b[k] !== undefined) cur[k] = b[k];
      cur.sidebarGroups = sanitizeGroups(cur.sidebarGroups);
      uiprefs.sanitizeUiPrefs(cur);
      writeJsonAtomic(settingsFile, cur);
      return send(res, 200, settings());
    }
    // CON-PUBLIC D/E/F: Settings > "Updates & repair" (server/updates.js). apply only stages
    // the new version; the restart stays the operator's (or the auto-updater's when idle).
    // MERGE-CON: the writes are loopback-only like every other console write.
    if (p === '/api/updates' && m === 'GET') return send(res, 200, updates.state());
    if (p === '/api/updates/preflight' && m === 'GET') return send(res, 200, updates.preflight());
    if (p.startsWith('/api/updates/') && m === 'POST' && !isLoopback(req)) return send(res, 403, { error: 'localhost only' });
    if (p === '/api/updates/check' && m === 'POST') return send(res, 200, await updates.check().catch((e) => ({ error: e.message })));
    if (p === '/api/updates/apply' && m === 'POST') return send(res, 200, await updates.apply().catch((e) => ({ error: e.message })));
    if (p === '/api/updates/settings' && m === 'POST') return send(res, 200, updates.saveSettings(await readBody(req, 65536)));
    if (p === '/api/updates/reinstall' && m === 'POST') return send(res, 200, await updates.reinstall(await readBody(req, 65536)).catch((e) => ({ error: e.message })));
    if (p === '/api/updates/contribute' && m === 'POST') {
      try { return send(res, 200, updates.makePatch()); } catch (e) { return send(res, 200, { error: e.message }); }
    }
    // CON-USAGE: top-bar usage strip slot toggles (data/usage.local.json).
    if (p === '/api/usage-prefs' && m === 'GET') return send(res, 200, { slots: usagePrefs.readUsagePrefs(cfg.dataDir) });
    if (p === '/api/usage-prefs' && m === 'PUT') {
      if (!isLoopback(req)) return send(res, 403, { error: 'localhost only' });
      const b = await readBody(req, 4096);
      return send(res, 200, { slots: usagePrefs.writeUsagePrefs(cfg.dataDir, b && b.slots, writeJsonAtomic) });
    }
    if (p === '/api/layout' && m === 'GET') return send(res, 200, readJson(layoutFile, { panes: [] }));
    if (p === '/api/layout' && m === 'PUT') {
      const b = await readBody(req);
      writeJsonAtomic(layoutFile, { savedAt: Date.now(), panes: Array.isArray(b.panes) ? b.panes.slice(0, 64) : [], maximized: b.maximized || null });
      return send(res, 200, { ok: true });
    }
    if (p === '/api/panes' && m === 'GET') return send(res, 200, { panes: panes.list() });
    if (p === '/api/panes' && m === 'POST') {
      const b = await readBody(req);
      let cwd = b.cwd;
      let title = b.title;
      const proj = b.projectId ? projectById(b.projectId) : null;
      if (b.projectId && !proj) return send(res, 404, { error: 'unknown project' });
      if (proj) {
        cwd = proj.dir;
        if (!title) title = proj.name;
      }
      if (!cwd) cwd = cfg.root;
      const s = settings();
      try {
        const pane = panes.create({
          kind: b.kind, projectId: proj ? proj.id : null, cwd, title,
          account: b.account || s.defaultAccount, shell: b.shell || s.defaultShell,
          args: b.args, resume: typeof b.resume === 'string' ? b.resume : null, name: b.kind === 'claude' ? (proj ? proj.name : title) : null,
          cols: b.cols, rows: b.rows, client: b.client,
        });
        plog('pane ' + pane.id + ' open ' + pane.kind + ' "' + pane.title + '" by ' + (pane.openedBy ? 'page ' + pane.openedBy : 'api ' + who(req)));
        return send(res, 201, pane.info());
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    const pm = /^\/api\/panes\/([0-9a-f]{8})(?:\/(restart|seen|input|resize))?$/.exec(p);
    if (pm) {
      const pane = panes.get(pm[1]);
      if (!pane) return send(res, 404, { error: 'no such pane' });
      if (!pm[2] && m === 'DELETE') {
        // CON-PANE-VANISH: every close says who asked, so a pane that "vanished" is traceable.
        plog('pane ' + pane.id + ' closed "' + pane.title + '" state=' + pane.state + ' after ' + Math.round((Date.now() - pane.startedAt) / 1000) + 's by ' + who(req));
        panes.close(pane.id);
        return send(res, 200, { ok: true });
      }
      if (!pm[2] && m === 'GET') return send(res, 200, pane.info());
      if (pm[2] === 'restart' && m === 'POST') {
        const b = await readBody(req);
        try {
          return send(res, 200, panes.restart(pane.id, { args: b.args, resume: !!b.resume }).info());
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (pm[2] === 'seen' && m === 'POST') {
        pane.seen();
        return send(res, 200, { ok: true });
      }
      if (pm[2] === 'input' && m === 'POST') {
        const b = await readBody(req);
        return send(res, 200, { ok: pane.write(String(b.data || '')) });
      }
      if (pm[2] === 'resize' && m === 'POST') {
        const b = await readBody(req);
        pane.resize(b.cols, b.rows);
        return send(res, 200, pane.info());
      }
    }
    if (p === '/api/shutdown' && m === 'POST') {
      send(res, 200, { ok: true });
      // CON-0.1.1: exit even when close() cannot finish (a leaked handle, a peer that
      // never lets go); a server that only stops listening keeps its app dir in use.
      if (opts.exitOnShutdown) setTimeout(() => process.exit(0), shutdownGraceMs).unref();
      setTimeout(() => close().then(() => { if (opts.exitOnShutdown) process.exit(0); }), 100);
      return undefined;
    }
    return send(res, 404, { error: 'not found' });
  }

  function serveFile(res, file, type) {
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'not found' });
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      if (type.startsWith('text/html')) {
        headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'";
        headers['X-Frame-Options'] = 'DENY';
        headers['Referrer-Policy'] = 'no-referrer';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    if (!allowedHost(req.headers.host)) return send(res, 403, { error: 'bad host' });
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      return send(res, 400, { error: 'bad url' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && !allowedOrigin(req.headers.origin)) return send(res, 403, { error: 'bad origin' });
      api(req, res, url).catch((e) => send(res, 500, { error: e.message }));
      return undefined;
    }
    if (STATIC[url.pathname]) {
      const f = path.join(PUBLIC, STATIC[url.pathname]);
      return serveFile(res, f, MIME[path.extname(f)] || 'application/octet-stream');
    }
    const vm = /^\/vendor\/([a-z-]+\.(?:js|css))$/.exec(url.pathname);
    if (vm && VENDOR[vm[1]]) return serveFile(res, VENDOR[vm[1]], MIME[path.extname(vm[1])]);
    return send(res, 404, { error: 'not found' });
  });

  // ---- WebSockets: /ws/pane/<id>?t=TOKEN and /ws/events?t=TOKEN ----
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const eventClients = new Set();
  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      socket.destroy();
      return;
    }
    const reject = (code) => {
      socket.write('HTTP/1.1 ' + code + ' Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    };
    if (!allowedHost(req.headers.host) || !allowedOrigin(req.headers.origin)) return reject(403);
    if (!safeEqual(url.searchParams.get('t'), token)) return reject(401);
    const pm = /^\/ws\/pane\/([0-9a-f]{8})$/.exec(url.pathname);
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        eventClients.add(ws);
        ws.send(JSON.stringify({ t: 'panes', panes: panes.list() }));
        if (resources.enabled) { resources.touch(); ws.send(JSON.stringify({ t: 'res', res: resources.publicSnap() })); resources.tick(); }
        ws.on('close', () => eventClients.delete(ws));
        ws.on('error', () => eventClients.delete(ws));
      });
      return undefined;
    }
    if (pm && panes.get(pm[1])) {
      const pane = panes.get(pm[1]);
      wss.handleUpgrade(req, socket, head, (ws) => attachPane(ws, pane));
      return undefined;
    }
    return reject(404);
  });

  function attachPane(ws, pane) {
    const out = (d) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'out', d })); };
    const onExit = (code) => { if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'exit', code })); };
    const onClosed = () => { try { ws.close(4000, 'pane closed'); } catch (e) { /* gone */ } };
    ws.send(JSON.stringify({ t: 'replay', d: pane.replay(), info: pane.info() }));
    pane.on('data', out);
    pane.on('exit', onExit);
    pane.on('closed', onClosed);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch (e) {
        return;
      }
      if (msg.t === 'in' && typeof msg.d === 'string') pane.write(msg.d);
      else if (msg.t === 'resize') pane.resize(msg.cols, msg.rows);
      else if (msg.t === 'seen') pane.seen();
    });
    const detach = () => {
      pane.off('data', out);
      pane.off('exit', onExit);
      pane.off('closed', onClosed);
    };
    ws.on('close', detach);
    ws.on('error', detach);
  }

  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const c of eventClients) if (c.readyState === 1) c.send(s);
  };
  broadcastRef = broadcast;
  panes.on('state', (info) => broadcast({ t: 'state', pane: info }));
  panes.on('added', (info) => broadcast({ t: 'added', pane: info }));
  panes.on('removed', (x) => broadcast({ t: 'removed', id: x.id }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      port = server.address().port;
      resolve();
    });
  });
  panes.hookUrl = 'http://127.0.0.1:' + port + '/';
  status.start();
  resources.start();
  if (opts.memSample !== false) memSampler.start();
  // Addendum e.1: every outbound attempt (host + kind only, never a path or query) is
  // logged to run/egress.log, so "nothing leaves the machine" can be read back.
  require('../installer/egress').setLog(path.join(cfg.runDir, 'egress.log'));
  // CON-0.1.3: re-align the Apps & features version after an update made by an older CLI
  // (launcher.refreshArpForInstall: installed copies only; never a test instance).
  if (!opts.dataDir && opts.arpRefresh !== false) {
    const t = setTimeout(() => { require('../installer/launcher').refreshArpForInstall(path.join(__dirname, '..'), VERSION).catch(() => {}); }, 3000);
    t.unref();
  }
  // Old composer attachments (day folders > 14 days) go to the Recycle Bin: a minute
  // after start, then daily. Off for test instances unless asked.
  const pruneTimers = [];
  if (opts.pruneDrops !== false && !opts.dropsDir) {
    const prune = () => { drops.pruneDrops(dropsDir).catch(() => {}); };
    pruneTimers.push(setTimeout(prune, 60 * 1000), setInterval(prune, 24 * 3600 * 1000));
    for (const t of pruneTimers) t.unref();
  }

  const shutdownGraceMs = opts.shutdownGraceMs || 3000;
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    status.stop();
    resources.stop();
    memSampler.stop();
    watchdog.stop();
    healthRunner.abort('server closed during the run');
    for (const t of pruneTimers) { clearTimeout(t); clearInterval(t); }
    await panes.closeAll();
    // CON-0.1.1: server.close() waits for every open connection, so end them all: every
    // WebSocket (events AND panes; a pane's ws.close() waits for the peer's close
    // frame), then every HTTP connection, idle or mid-request. Bounded either way.
    for (const c of new Set([...eventClients, ...wss.clients])) {
      try { c.terminate(); } catch (e) { /* gone */ }
    }
    const done = new Promise((r) => server.close(() => r()));
    try { server.closeAllConnections(); } catch (e) { /* Node < 18.2 */ }
    await Promise.race([done, new Promise((r) => setTimeout(r, shutdownGraceMs).unref())]);
    if (opts.writeRunFiles) {
      try { fs.unlinkSync(path.join(cfg.runDir, 'server.json')); } catch (e) { /* none */ }
    }
  }

  if (opts.writeRunFiles) {
    fs.mkdirSync(cfg.runDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.runDir, 'token'), token + '\n');
    writeJsonAtomic(path.join(cfg.runDir, 'server.json'), { pid: process.pid, port, startedAt: new Date().toISOString(), version: VERSION });
  }

  return { server, port, token, cfg, panes, status, resources, healthRunner, memSampler, mainPlugin: mainPl, scheduler: sched, healthSchedule, watchdog, close, dropsDir, get projects() { return projects; } };
}

// ---------- CLI entry ----------
function openWindow(cfg, port, token) {
  const edge = cfg.edgePath;
  const url = 'http://127.0.0.1:' + port + '/#t=' + token;
  const profile = path.join(process.env.LOCALAPPDATA || cfg.runDir, 'ClaudeConsole', 'edge-profile');
  const args = ['--app=' + url, '--user-data-dir=' + profile, '--window-size=1680,1020', '--no-first-run', '--no-default-browser-check'];
  if (!edge || !fs.existsSync(edge)) {
    console.error('Edge not found; open ' + url + ' manually');
    return;
  }
  const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

function checkExisting(cfg) {
  return new Promise((resolve) => {
    let token;
    try {
      token = fs.readFileSync(path.join(cfg.runDir, 'token'), 'utf8').trim();
    } catch (e) {
      return resolve(null);
    }
    const req = http.get({ hostname: '127.0.0.1', port: cfg.port, path: '/api/info', timeout: 2000, headers: { 'X-Console-Token': token, Host: '127.0.0.1:' + cfg.port } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? token : null);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const wantOpen = argv.includes('--open');
  const cfg = loadConfig();
  fs.mkdirSync(cfg.runDir, { recursive: true });
  const existing = await checkExisting(cfg);
  if (existing) {
    if (wantOpen) openWindow(cfg, cfg.port, existing);
    console.log('Claude Console already running on port ' + cfg.port);
    return;
  }
  const logFile = path.join(cfg.runDir, 'server.log');
  const log = (s) => {
    try { fs.appendFileSync(logFile, new Date().toISOString() + ' ' + s + '\n'); } catch (e) { /* ignore */ }
  };
  let srv;
  try {
    srv = await createConsoleServer({ writeRunFiles: true, exitOnShutdown: true, log });
  } catch (e) {
    log('start failed: ' + e.message);
    console.error('start failed: ' + e.message);
    process.exit(1);
  }
  log('listening on 127.0.0.1:' + srv.port + ' pid ' + process.pid + ' claude=' + (srv.panes.claudePath || 'NOT FOUND'));
  console.log('Claude Console on http://127.0.0.1:' + srv.port + ' (token in run/token)');
  if (wantOpen) openWindow(srv.cfg, srv.port, srv.token);
  const stop = () => {
    setTimeout(() => process.exit(0), 3000).unref();
    srv.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('uncaughtException', (e) => log('uncaught: ' + (e && e.stack || e)));
}

if (require.main === module) main();

module.exports = { createConsoleServer, DEFAULT_SETTINGS };
