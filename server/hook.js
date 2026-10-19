'use strict';
// Claude Code hook -> Claude Console. Loaded only through the --settings file the
// console passes to the claude panes it starts. Prints nothing (UserPromptSubmit
// stdout would enter the model context) and always exits 0 quickly.
const http = require('http');

const event = process.argv[2] || '';
const url = process.env.CONSOLE_HOOK_URL;
const pane = process.env.CONSOLE_PANE;
const secret = process.env.CONSOLE_HOOK_SECRET;

function done() {
  process.exit(0);
}

if (!url || !pane || !secret) done();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  if (input.length < 65536) input += d;
});
process.stdin.on('error', () => send());
process.stdin.on('end', () => send());
setTimeout(() => send(), 1500).unref();

let sent = false;
function send() {
  if (sent) return;
  sent = true;
  let note = null;
  let sessionId = null;
  let toolName = null;
  let source = null; // SessionStart: startup | resume | clear | compact (CON-UX-CLEAR)
  try {
    const j = JSON.parse(input);
    if (j && typeof j.message === 'string') note = j.message.slice(0, 200);
    if (j && typeof j.session_id === 'string') sessionId = j.session_id;
    if (j && typeof j.tool_name === 'string') toolName = j.tool_name.slice(0, 120);
    if (j && typeof j.source === 'string') source = j.source.replace(/[^a-z]/gi, '').slice(0, 16) || null;
  } catch (e) { /* no payload */ }
  const body = JSON.stringify({ pane, secret, event, note, sessionId, toolName, source });
  try {
    const u = new URL('/api/hook', url);
    if (u.hostname !== '127.0.0.1') return done();
    const req = http.request({
      hostname: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', timeout: 2000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: u.host },
    }, (res) => { res.resume(); res.on('end', done); });
    req.on('error', done);
    req.on('timeout', () => { req.destroy(); done(); });
    req.end(body);
  } catch (e) {
    done();
  }
}
