'use strict';
// A fake Task Scheduler for CON-SCHEDULER / CON-HEALTH-SCHED tests. It understands
// exactly the calls server/scheduler.js makes and never touches the real one.
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../server/scheduler');


// A fake Task Scheduler. It understands exactly the calls scheduler.js makes:
// powershell list / export, schtasks /Create /XML, /Change /ENABLE|/DISABLE, /Delete.
class FakeOS {
  constructor(rows) {
    this.tasks = new Map();
    for (const r of rows || []) this.tasks.set(r.path + r.name, Object.assign({ state: 'Ready', lastResult: 0, lastRun: null, nextRun: null, author: '', description: '', triggers: [], actions: [] }, r));
    this.calls = [];
    this.failCreate = false;
    this.corruptCreate = false; // registers something other than what was asked
    this.failList = false;
  }
  runner() {
    return async (file, args, opts) => {
      const env = (opts && opts.env) || {};
      this.calls.push([path.basename(file).toLowerCase(), args.slice()]);
      const exe = path.basename(file).toLowerCase();
      if (exe === 'powershell.exe') {
        const script = args[args.indexOf('-Command') + 1];
        if (script === S.PS_LIST) {
          if (this.failList) return { code: 1, stdout: '', stderr: 'boom' };
          return { code: 0, stdout: JSON.stringify([...this.tasks.values()]), stderr: '' };
        }
        if (script === S.PS_EXPORT) {
          // arguments travel in the environment, never on the -Command line
          const name = env.CC_SCHED_NAME;
          const tpath = env.CC_SCHED_PATH;
          const out = env.CC_SCHED_OUT;
          const t = this.tasks.get(tpath + name);
          if (!t) return { code: 1, stdout: '', stderr: 'not found' };
          fs.writeFileSync(out, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t.xml || FakeOS.xmlOf(t), 'utf16le')]));
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 9, stdout: '', stderr: 'unknown script' };
      }
      if (exe === 'schtasks.exe') {
        const tn = args[args.indexOf('/TN') + 1];
        const split = tn.lastIndexOf('\\');
        const tpath = tn.slice(0, split + 1);
        const name = tn.slice(split + 1);
        if (args[0] === '/Create') {
          if (this.failCreate) return { code: 1, stdout: '', stderr: 'ERROR: access denied' };
          if (this.tasks.has(tn) && !args.includes('/F')) return { code: 1, stdout: '', stderr: 'exists' };
          const buf = fs.readFileSync(args[args.indexOf('/XML') + 1]);
          assert.ok(buf[0] === 0xff && buf[1] === 0xfe, 'task XML is written as UTF-16LE with a BOM');
          const xml = buf.slice(2).toString('utf16le');
          const row = FakeOS.rowOf(xml, tpath, name);
          if (this.corruptCreate) row.actions = [{ exe: 'C:\\evil.exe', args: '', workdir: '' }];
          this.tasks.set(tn, row);
          return { code: 0, stdout: 'SUCCESS', stderr: '' };
        }
        if (args[0] === '/Change') {
          const t = this.tasks.get(tn);
          if (!t) return { code: 1, stdout: '', stderr: 'not found' };
          t.state = args.includes('/DISABLE') ? 'Disabled' : 'Ready';
          return { code: 0, stdout: 'SUCCESS', stderr: '' };
        }
        if (args[0] === '/Delete') {
          if (!this.tasks.delete(tn)) return { code: 1, stdout: '', stderr: 'not found' };
          return { code: 0, stdout: 'SUCCESS', stderr: '' };
        }
      }
      return { code: 9, stdout: '', stderr: 'unexpected call' };
    };
  }
  writes() {
    return this.calls.filter((c) => c[0] === 'schtasks.exe');
  }
  static rowOf(xml, tpath, name) {
    const g = (re) => { const m = re.exec(xml); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") : ''; };
    const kinds = { TimeTrigger: 'MSFT_TaskTimeTrigger', CalendarTrigger: /ScheduleByWeek/.test(xml) ? 'MSFT_TaskWeeklyTrigger' : 'MSFT_TaskDailyTrigger', LogonTrigger: 'MSFT_TaskLogonTrigger', BootTrigger: 'MSFT_TaskBootTrigger' };
    const triggers = [];
    for (const k of Object.keys(kinds)) {
      const re = new RegExp('<' + k + '>([\\s\\S]*?)</' + k + '>', 'g');
      let m;
      while ((m = re.exec(xml))) {
        const sb = /<StartBoundary>([^<]*)</.exec(m[1]);
        const iv = /<Interval>([^<]*)</.exec(m[1]);
        const dl = /<Delay>([^<]*)</.exec(m[1]);
        triggers.push({ kind: kinds[k], start: sb ? sb[1] : null, interval: iv ? iv[1] : null, delay: dl ? dl[1] : null, enabled: true });
      }
    }
    const enabled = !/<Settings>[\s\S]*<Enabled>false<\/Enabled>[\s\S]*<\/Settings>/.test(xml);
    return { name, path: tpath, state: enabled ? 'Ready' : 'Disabled', author: g(/<Author>([^<]*)</), description: g(/<Description>([^<]*)</), lastRun: null, nextRun: null, lastResult: 267011, triggers, actions: [{ exe: g(/<Command>([^<]*)</), args: g(/<Arguments>([^<]*)</), workdir: g(/<WorkingDirectory>([^<]*)</) }], xml };
  }
  static xmlOf(t) {
    return '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">\n  <RegistrationInfo><Author>someone</Author></RegistrationInfo>\n  <Triggers>\n    <BootTrigger><Enabled>true</Enabled></BootTrigger>\n  </Triggers>\n  <Settings><Enabled>true</Enabled></Settings>\n  <Actions Context="Author">\n    <Exec><Command>' + t.actions[0].exe + '</Command></Exec>\n  </Actions>\n</Task>\n';
  }
}

module.exports = { FakeOS };
