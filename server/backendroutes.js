'use strict';
// G3 backend routes (CON-SCHEDULER, CON-HEALTH-SCHED, CON-WATCHDOG) in one handler so
// server.js needs only a require, the service construction and ONE dispatch line
// (docs/g3-wiring.patch). The handler runs after server.js has checked the token, Host
// and Origin; it adds the loopback check itself. It answers only /api/scheduler*,
// /api/health/schedule and /api/watchdog* and returns false for everything else.
//
//   GET    /api/scheduler[?project=id]        task list + facts (+ one repo's tasks)
//   GET    /api/scheduler/report?project=id   compact self-report rows for one repo
//   POST   /api/scheduler/tasks               add {path?, name, exe, args?, workdir?, trigger, description?, enabled?, limitMinutes?}
//   PATCH  /api/scheduler/tasks               alter {path, name, enabled?, trigger?, action?}
//   DELETE /api/scheduler/tasks?path=&name=   remove (backup kept)
//   GET    /api/health/schedule               scheduled health check state + last status line
//   PUT    /api/health/schedule               {enabled, at?, days?}
//   GET    /api/watchdog                      observe-only watchdog snapshot
//   POST   /api/watchdog/sample               take one sample now
const defaultLoopback = (req) => /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket.remoteAddress || ''));

function defaultSend(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(obj));
}

function defaultReadBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 65536)) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function createBackendRoutes(deps) {
  deps = deps || {};
  const send = deps.send || defaultSend;
  const readBody = deps.readBody || defaultReadBody;
  const isLoopback = deps.isLoopback || defaultLoopback;
  const log = deps.log || (() => {});

  async function body(req, res) {
    try { return await readBody(req, 65536); } catch (e) { send(res, 400, { error: e.message || 'bad body' }); return null; }
  }

  return async function handle(req, res, p, m, url) {
    const sched = p === '/api/scheduler' || p.startsWith('/api/scheduler/');
    const hsched = p === '/api/health/schedule';
    const wd = p === '/api/watchdog' || p.startsWith('/api/watchdog/');
    if (!sched && !hsched && !wd) return false;
    if (!isLoopback(req)) { send(res, 403, { error: 'localhost only' }); return true; }
    const q = url && url.searchParams ? url.searchParams : new URLSearchParams();

    if (sched) {
      const s = deps.scheduler;
      if (!s) { send(res, 503, { error: 'scheduler not wired' }); return true; }
      if (p === '/api/scheduler' && m === 'GET') {
        const project = q.get('project');
        send(res, 200, await s.list(project ? { project: project.slice(0, 64) } : {}));
        return true;
      }
      if (p === '/api/scheduler/report' && m === 'GET') {
        const project = String(q.get('project') || '').slice(0, 64);
        if (!project) { send(res, 400, { error: 'project required' }); return true; }
        send(res, 200, await s.report(project));
        return true;
      }
      if (p === '/api/scheduler/tasks') {
        let r;
        if (m === 'POST') {
          const b = await body(req, res);
          if (!b) return true;
          r = await s.add(b);
          log('scheduler add ' + String(b.name || '').slice(0, 80) + ' -> ' + r.status);
        } else if (m === 'PATCH') {
          const b = await body(req, res);
          if (!b) return true;
          const patch = {};
          for (const k of ['enabled', 'trigger', 'action']) if (b[k] !== undefined) patch[k] = b[k];
          r = await s.alter({ path: b.path, name: b.name }, patch);
          log('scheduler alter ' + String(b.name || '').slice(0, 80) + ' ' + Object.keys(patch).join(',') + ' -> ' + r.status);
        } else if (m === 'DELETE') {
          const ref = { path: q.get('path') === null ? undefined : q.get('path'), name: q.get('name') };
          r = await s.remove(ref);
          log('scheduler remove ' + String(ref.name || '').slice(0, 80) + ' -> ' + r.status);
        } else {
          send(res, 405, { error: 'method not allowed' });
          return true;
        }
        const out = Object.assign({}, r);
        delete out.status;
        send(res, r.status, out);
        return true;
      }
      send(res, 404, { error: 'unknown scheduler endpoint' });
      return true;
    }

    if (hsched) {
      const h = deps.healthSchedule;
      if (!h) { send(res, 503, { error: 'health schedule not wired' }); return true; }
      if (m === 'GET') { send(res, 200, await h.state()); return true; }
      if (m === 'PUT') {
        const b = await body(req, res);
        if (!b) return true;
        const r = await h.set(b);
        log('health schedule ' + (b.enabled ? 'on' : 'off') + ' -> ' + r.status);
        const out = Object.assign({}, r);
        delete out.status;
        send(res, r.status, out);
        return true;
      }
      send(res, 405, { error: 'method not allowed' });
      return true;
    }

    const w = deps.watchdog;
    if (!w) { send(res, 503, { error: 'watchdog not wired' }); return true; }
    if (p === '/api/watchdog' && m === 'GET') { send(res, 200, w.snapshot()); return true; }
    if (p === '/api/watchdog/sample' && m === 'POST') {
      const r = await w.sample();
      send(res, r ? 200 : 503, r ? w.snapshot() : { error: 'sample failed' });
      return true;
    }
    send(res, 404, { error: 'unknown watchdog endpoint' });
    return true;
  };
}

module.exports = { createBackendRoutes, defaultSend, defaultReadBody };
