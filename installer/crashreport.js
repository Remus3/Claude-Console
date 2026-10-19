'use strict';
// Crash report (CON-013 L3, addendum e.2). buildReport() collects ONLY: console version,
// channel, OS build, Node version, git present, the failing step (id, exit code, one-line
// reason, stack without paths), the last 200 lines of the console's own run/*.log, the
// profile state line and the last transaction's id + status. Never pane output, prompts,
// transcripts, hand-offs, memory, machine-profile data, env values or settings values.
// The whole text goes through contribute.scrub(), then a needles pass refuses the report
// if the user name, host name or home path (or a line of the local needles file) is
// still in it. Nothing is sent: the user sees the exact text and its size, then picks one
// of three actions, each of which needs confirm === true:
//   issue  - open a pre-filled GitHub issue in the browser (body cut to fit 8 KB of URL,
//            with a note to attach the saved file instead);
//   claude - the report with a fixed preamble, for a new local Claude pane (L5 opens it;
//            the CLI copies it to the clipboard);
//   save   - <Documents>/claude-console-report-<stamp>.txt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { scrub, needleHits } = require('./contribute');
const { stamp } = require('./paths');

const ISSUE_REPO = 'Remus3/Claude-Console'; // public slug since GH-RENAME 2026-10-18; npm/CLI name stays claude-console
const URL_MAX = 8192;
const LOG_LINES = 200;
const PREAMBLE = 'This is a Claude Console crash report. Find the cause, propose a fix, change nothing until I agree.';

// Last n lines over every run/*.log, oldest file first.
function lastLogLines(runDir, n) {
  let files = [];
  try { files = fs.readdirSync(runDir).filter((f) => /\.log$/i.test(f)).map((f) => path.join(runDir, f)); } catch (e) { return []; }
  files.sort((a, b) => { try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; } catch (e) { return 0; } });
  const lines = [];
  for (const f of files) {
    let t = '';
    try {
      const st = fs.statSync(f);
      const fd = fs.openSync(f, 'r');
      const len = Math.min(st.size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      t = buf.toString('utf8');
    } catch (e) { continue; }
    for (const l of t.split(/\r?\n/)) if (l.length) lines.push(path.basename(f) + ': ' + l.slice(0, 400));
  }
  return lines.slice(-(n || LOG_LINES));
}

// A stack without paths: "at fn (file.js:12:3)" keeps the base name only.
function stripStack(stack) {
  if (!stack) return [];
  return String(stack).split(/\r?\n/).slice(0, 12).map((l) => l.replace(/\(?((?:[A-Za-z]:)?[\\/][^():\s]+[\\/])([^\\/():\s]+:\d+(?::\d+)?)\)?/g, (m, dir, file) => (m.startsWith('(') ? '(' + file + ')' : file)).replace(/file:\/\/\/?\S*?([^\\/\s]+:\d+:\d+)/g, '$1').trim());
}

function gitPresent() {
  try { return require('child_process').spawnSync('git', ['--version'], { windowsHide: true, timeout: 5000 }).status === 0; } catch (e) { return false; }
}

// o: {version, channel, step: {id, exit, reason, stack}, runDir, dataDir, home, logLines,
//     profileState, lastTx: {id, status}, os, node, git, username, hostname, token,
//     needles, needlesFile}
function buildReport(o) {
  o = o || {};
  const step = o.step || {};
  const lines = [];
  lines.push('Claude Console crash report');
  lines.push('version: ' + (o.version || '?') + '  channel: ' + (o.channel || 'stable'));
  lines.push('os: ' + (o.os || (os.platform() + ' ' + os.release() + ' ' + os.arch())));
  lines.push('node: ' + (o.node || process.version));
  lines.push('git: ' + ((o.git !== undefined ? o.git : gitPresent()) ? 'yes' : 'no'));
  lines.push('failing step: ' + (step.id || 'none given') + (step.exit !== undefined && step.exit !== null ? ' (exit ' + step.exit + ')' : '') + (step.reason ? ': ' + String(step.reason).split(/\r?\n/)[0].slice(0, 300) : ''));
  const st = stripStack(step.stack);
  if (st.length) { lines.push('stack:'); for (const l of st) lines.push('  ' + l); }
  lines.push('profile: ' + (o.profileState || 'not set up'));
  lines.push('last tx: ' + (o.lastTx ? o.lastTx.id + ' ' + o.lastTx.status : 'none'));
  const log = o.logLines || lastLogLines(o.runDir, LOG_LINES);
  lines.push('');
  lines.push('last ' + log.length + ' console log line(s):');
  for (const l of log.slice(-LOG_LINES)) lines.push(l);
  const raw = lines.join('\n') + '\n';
  const username = o.username !== undefined ? o.username : safeUser();
  const hostname = o.hostname !== undefined ? o.hostname : os.hostname();
  const text = scrub(raw, { home: o.home, extra: [o.dataDir, o.runDir].filter(Boolean), username, hostname, token: o.token,
    machineDir: o.dataDir ? path.join(o.dataDir, 'machine') : null });
  const needles = [username, hostname, os.homedir()].concat(o.needles || []).filter((x) => x && String(x).length >= 3);
  const hits = needleHits(text, needles, o.needlesFile || (o.dataDir ? path.join(o.dataDir, 'privacy-needles.txt') : null));
  if (hits.length) return { ok: false, refused: true, reason: 'the scrubbed report still holds ' + hits.length + ' private value(s); not offered', text: null, bytes: 0 };
  return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8') };
}

function safeUser() { try { return os.userInfo().username; } catch (e) { return process.env.USERNAME || process.env.USER || ''; } }

// GitHub issue URL that stays under 8 KB; when cut, the body says to attach the file.
function issueUrl(report, o) {
  o = o || {};
  const repo = o.repo || ISSUE_REPO;
  const title = 'Crash report: ' + ((/^failing step: (.*)$/m.exec(report.text) || [])[1] || 'console problem').slice(0, 80);
  const base = 'https://github.com/' + repo + '/issues/new?title=' + encodeURIComponent(title) + '&body=';
  let body = report.text;
  let url = base + encodeURIComponent('```\n' + body + '```\n');
  if (url.length <= URL_MAX) return { url, truncated: false };
  const note = '\n... (truncated: attach the saved report file for the rest)\n';
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const u = base + encodeURIComponent('```\n' + body.slice(0, mid) + note + '```\n');
    if (u.length <= URL_MAX) lo = mid; else hi = mid - 1;
  }
  url = base + encodeURIComponent('```\n' + body.slice(0, lo) + note + '```\n');
  return { url, truncated: true };
}

function askClaudeText(report) { return PREAMBLE + '\n\n' + report.text; }

function savePath(o) {
  const docs = (o && o.documents) || path.join(os.homedir(), 'Documents');
  return path.join(docs, 'claude-console-report-' + stamp(o && o.now) + '.txt');
}

// Default OS hooks (tests inject their own): the default browser, the clipboard.
function openUrlDefault(url) {
  if (!/^https:\/\/(github\.com|claude\.ai)\//.test(url)) throw new Error('refused: not an allowed browser host');
  const c = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  c.unref();
  return true;
}
function clipboardDefault(text) {
  return new Promise((resolve, reject) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$t=[Console]::In.ReadToEnd(); Set-Clipboard -Value $t'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    c.on('error', reject);
    c.on('exit', (code) => (code === 0 ? resolve(true) : reject(new Error('clipboard failed'))));
    c.stdin.end(text);
  });
}

// One action after the preview. o: {confirm, repo, documents, now, openUrl, clipboard, openPane}
async function runAction(report, action, o) {
  o = o || {};
  if (!report || !report.ok) return { ok: false, reason: 'no report to act on' };
  if (o.confirm !== true) return { ok: false, reason: 'preview first; then pick one action and confirm it' };
  if (action === 'issue') {
    const u = issueUrl(report, o);
    await (o.openUrl || openUrlDefault)(u.url);
    return { ok: true, action, url: u.url, truncated: u.truncated };
  }
  if (action === 'claude') {
    const text = askClaudeText(report);
    if (o.openPane) { await o.openPane(text); return { ok: true, action, via: 'pane' }; }
    await (o.clipboard || clipboardDefault)(text);
    return { ok: true, action, via: 'clipboard' };
  }
  if (action === 'save') {
    const file = savePath(o);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, report.text);
    return { ok: true, action, file };
  }
  return { ok: false, reason: 'unknown action ' + action + ' (issue, claude or save)' };
}

module.exports = { buildReport, issueUrl, askClaudeText, runAction, savePath, lastLogLines, stripStack, openUrlDefault, clipboardDefault, PREAMBLE, URL_MAX, ISSUE_REPO };
