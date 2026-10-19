'use strict';
// A scripted stand-in for the Claude Code CLI, used only by the demo console
// (tools/demo-seed.js) so screenshots and GIFs need no account, no network and show no
// real model output. It prints a banner, plays one hand-written exchange, then answers
// every line typed into it from a short fixed script. Arguments the console passes
// (--session-id, --settings, --name) are accepted and ignored.
const path = require('path');

const cwd = process.cwd();
const project = path.basename(cwd);
const out = (s) => process.stdout.write(s.replace(/\n/g, '\r\n'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DIM = '\x1b[2m', BOLD = '\x1b[1m', ORANGE = '\x1b[38;5;173m', GREEN = '\x1b[32m', RESET = '\x1b[0m';

const SCRIPT = [
  {
    ask: 'What is next here?',
    answer: [
      'Reading the hand-off.',
      '',
      GREEN + '*' + RESET + ' Read ' + BOLD + project.replace('sample-', '').toUpperCase() + '-NEXT-SESSION.txt' + RESET,
      GREEN + '*' + RESET + ' Read ' + BOLD + 'ROADMAP.md' + RESET,
      '',
      'Next: the first roadmap item.',
      '  1. Write the failing test.',
      '  2. Make it pass.',
      '  3. Run the suite once.',
      '  4. Update the hand-off.',
    ],
  },
  { ask: null, answer: ['The test is written and fails.', 'Make it pass now?'] },
  { ask: null, answer: ['All 48 tests pass.', 'Hand-off updated; run /done.'] },
];

async function typeOut(lines, delay) {
  for (const l of lines) {
    out(l + '\n');
    await sleep(delay);
  }
}

function prompt() { out('\n' + ORANGE + '>' + RESET + ' '); }

async function main() {
  process.stdout.write('\x1b]0;claude - ' + project + '\x07');
  const bar = ORANGE + '+' + '-'.repeat(30) + '+' + RESET + '\n';
  const row = (t, style) => ORANGE + '|' + RESET + (style || '') + ' ' + t.slice(0, 29).padEnd(29) + RESET + ORANGE + '|' + RESET + '\n';
  out(bar + row('Claude Code (demo)', BOLD) + row('cwd: ' + project, DIM) + bar);
  await sleep(400);
  const first = SCRIPT[0];
  prompt();
  for (const ch of first.ask) { out(ch); await sleep(12); }
  out('\n\n');
  await typeOut(first.answer, 110);
  prompt();
  let turn = 1;
  let line = '';
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', async (buf) => {
    const s = buf.toString('utf8');
    if (s === '\x03') process.exit(0);
    for (const ch of s) {
      if (ch === '\r' || ch === '\n') {
        out('\n\n');
        const said = line.trim();
        line = '';
        if (said === '/exit' || said === '/quit') process.exit(0);
        const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
        turn++;
        await typeOut(step.answer, 90);
        prompt();
      } else if (ch === '\x7f' || ch === '\b') {
        if (line) { line = line.slice(0, -1); out('\b \b'); }
      } else if (ch >= ' ') {
        line += ch;
        out(ch);
      }
    }
  });
}

main();
