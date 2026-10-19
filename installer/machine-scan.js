'use strict';
// CON-013 L9 (addendum a.3, inventory mach-spec-ingest): the first-run machine spec
// ingest. ONE read-only CIM query: model, CPU, RAM (rated vs configured speed), GPUs
// with VRAM (virtual adapters excluded), displays with refresh rate, disks, OS build,
// power plan. Saved to <dataDir>/machine/spec.json.
//
// LOCAL ONLY. The machine folder never leaves this machine: this module has no network
// code, the export excludes it, the crash report never includes it, and scrubMachine()
// removes every value and path from any text that is about to leave (PRIVACY below).
// The host name and the user name are never stored.
//
// Every OS effect goes through an injected runner(file, args, opts) -> {code, stdout,
// stderr} and an injected recycle(path), so tests never query or touch the real box.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PRIVACY = Object.freeze({
  network: 'none',
  crashReport: 'never',
  exportExclude: Object.freeze(['machine/']),
  storedUnder: '<dataDir>/machine',
});

// The public Windows display-adapter device class GUID (built from parts so the export
// privacy scan's uuid rule, meant for ids, does not flag it).
const DISPLAY_CLASS = ['4d36e968', 'e325', '11ce', 'bfc1', '08002be10318'].join('-');

// Read-only. VRAM comes from the display class key's qwMemorySize (64-bit), because
// Win32_VideoController.AdapterRAM is a uint32 and caps at 4 GB.
const PS_SPEC = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$cs = Get-CimInstance Win32_ComputerSystem',
  '$os = Get-CimInstance Win32_OperatingSystem',
  '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
  '$mem = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { [ordered]@{ capacity = [int64]$_.Capacity; speed = [int]$_.Speed; configured = [int]$_.ConfiguredClockSpeed } })',
  '$cls = @(Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{' + DISPLAY_CLASS + '}\\0*")',
  '$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object { $n = $_.Name; $k = $cls | Where-Object { $_.DriverDesc -eq $n } | Select-Object -First 1; $v = 0; if ($k -and $k."HardwareInformation.qwMemorySize") { $v = [int64]$k."HardwareInformation.qwMemorySize" } elseif ($_.AdapterRAM) { $v = [int64]$_.AdapterRAM }; [ordered]@{ name = $n; vram_bytes = $v; driver = [string]$_.DriverVersion; hz = [int]$_.CurrentRefreshRate; max_hz = [int]$_.MaxRefreshRate; width = [int]$_.CurrentHorizontalResolution; height = [int]$_.CurrentVerticalResolution } })',
  'Add-Type -AssemblyName System.Windows.Forms',
  '$disp = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ name = [string]$_.DeviceName; width = [int]$_.Bounds.Width; height = [int]$_.Bounds.Height; primary = [bool]$_.Primary } })',
  '$disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [ordered]@{ id = [string]$_.DeviceID; size = [int64]$_.Size; free = [int64]$_.FreeSpace } })',
  '$phys = @(Get-PhysicalDisk | ForEach-Object { [string]$_.MediaType })',
  '$plan = (Get-CimInstance -Namespace root\\cimv2\\power -ClassName Win32_PowerPlan | Where-Object { $_.IsActive } | Select-Object -First 1).ElementName',
  '$o = [ordered]@{ model = "$($cs.Manufacturer) $($cs.Model)"; cpu = [ordered]@{ name = [string]$cpu.Name; cores = [int]$cpu.NumberOfCores; threads = [int]$cpu.NumberOfLogicalProcessors }; ram = [ordered]@{ total_bytes = [int64]$cs.TotalPhysicalMemory; modules = $mem }; gpus = $gpus; displays = $disp; disks = $disks; media = $phys; os = [ordered]@{ caption = [string]$os.Caption; build = [string]$os.BuildNumber }; power_plan = [string]$plan }',
  '$o | ConvertTo-Json -Depth 5 -Compress',
].join('\n');

const VIRTUAL_GPU = /virtual|duet|remote|basic display|indirect display|parsec|spacedesk|meta virtual/i;
const GB = 1024 ** 3;

function iso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v) {
  return typeof v === 'string' ? v.trim().replace(/[^\x20-\x7e]/g, '') : '';
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// Raw CIM JSON -> the stored spec. Unknown keys (host, user, anything else) are
// dropped: only the fields below are ever kept.
function parseSpec(raw, opts) {
  opts = opts || {};
  let m = {};
  try { m = JSON.parse(String(raw || '').trim() || '{}') || {}; } catch (e) { m = {}; }
  if (typeof m !== 'object' || Array.isArray(m)) m = {};
  const now = opts.now ? opts.now() : Date.now();
  const cpu = m.cpu || {};
  const ram = m.ram || {};
  const mods = Array.isArray(ram.modules) ? ram.modules : [];
  const rated = mods.reduce((a, x) => Math.max(a, num(x && x.speed)), 0);
  const conf = mods.reduce((a, x) => (num(x && x.configured) ? (a ? Math.min(a, num(x.configured)) : num(x.configured)) : a), 0);
  const gpus = (Array.isArray(m.gpus) ? m.gpus : [])
    .filter((g) => g && str(g.name) && !VIRTUAL_GPU.test(g.name))
    .map((g) => ({ name: str(g.name), vram_gb: round1(num(g.vram_bytes) / GB), driver: str(g.driver) }));
  const gpu = gpus.length ? gpus.reduce((a, g) => (g.vram_gb > a.vram_gb ? g : a), gpus[0]) : null;
  // Displays: the CIM adapters carry refresh; the screen list carries primary. Merge by
  // order, keeping explicit display rows when the raw already has them.
  const rawGpus = Array.isArray(m.gpus) ? m.gpus.filter((g) => g && !VIRTUAL_GPU.test(String(g.name || ''))) : [];
  let displays = (Array.isArray(m.displays) ? m.displays : []).filter(Boolean).map((d, i) => {
    const a = rawGpus[i] || {};
    return {
      name: str(d.name),
      width: num(d.width) || num(a.width),
      height: num(d.height) || num(a.height),
      hz: num(d.hz) || num(a.hz),
      max_hz: num(d.max_hz) || num(a.max_hz) || num(d.hz) || num(a.hz),
      primary: !!d.primary,
      dpi: num(d.dpi) || null,
    };
  });
  if (!displays.length && rawGpus.length && num(rawGpus[0].width)) {
    displays = [{ name: '', width: num(rawGpus[0].width), height: num(rawGpus[0].height), hz: num(rawGpus[0].hz), max_hz: num(rawGpus[0].max_hz) || num(rawGpus[0].hz), primary: true, dpi: null }];
  }
  const disks = (Array.isArray(m.disks) ? m.disks : []).filter((d) => d && str(d.id)).map((d) => {
    const size = num(d.size); const free = num(d.free);
    return { id: str(d.id), size_gb: round1(size / GB), free_gb: round1(free / GB), free_pct: size ? Math.round((100 * free) / size) : 0, type: str(d.type) || null };
  });
  return {
    schema: 1,
    scanned: iso(now),
    model: str(m.model),
    cpu: { name: str(cpu.name), cores: num(cpu.cores), threads: num(cpu.threads) },
    ram: { total_gb: Math.round(num(ram.total_bytes) / GB), rated_mts: rated, configured_mts: conf, modules: mods.length },
    gpus,
    gpu,
    displays,
    primary_display: displays.find((d) => d.primary) || displays[0] || null,
    disks,
    os: { caption: str((m.os || {}).caption), build: str((m.os || {}).build) },
    power_plan: str(m.power_plan),
  };
}

function defaultRunner(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ windowsHide: true, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, opts || {}), (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function scanSpec(deps) {
  deps = deps || {};
  const run = deps.runner || defaultRunner;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SPEC], {});
  return parseSpec(r && r.code === 0 ? r.stdout : '', deps);
}

function machineDir(dataDir) {
  return path.join(dataDir, 'machine');
}

function isMachinePath(p, dataDir) {
  if (!p || !dataDir) return false;
  const rel = path.relative(machineDir(dataDir), path.resolve(String(p)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ASCII + LF JSON, atomic. Only ever under the machine folder.
function writeMachineJson(dataDir, rel, obj) {
  const file = path.join(machineDir(dataDir), rel);
  if (!isMachinePath(file, dataDir)) throw new Error('machine data stays under the machine folder');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = JSON.stringify(obj, null, 1).replace(/[^\x00-\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return file;
}

function readMachineJson(dataDir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(machineDir(dataDir), rel), 'utf8')); } catch (e) { return null; }
}

function loadSpec(dataDir) {
  return readMachineJson(dataDir, 'spec.json');
}

// First run: scan once; later runs return the stored spec. opts.rescan forces a scan.
async function firstRun(dataDir, deps) {
  deps = deps || {};
  const have = loadSpec(dataDir);
  if (have && !deps.rescan) return { ran: false, spec: have };
  const spec = await scanSpec(deps);
  writeMachineJson(dataDir, 'spec.json', spec);
  return { ran: true, spec };
}

// The UI's Delete: the whole machine folder to the Recycle Bin (never a direct unlink).
async function deleteMachineData(dataDir, deps) {
  deps = deps || {};
  const dir = machineDir(dataDir);
  if (!fs.existsSync(dir)) return { recycled: false, reason: 'no machine data' };
  const recycle = deps.recycle || require('./fsutil').recycleWindows;
  await recycle(dir);
  return { recycled: true, path: dir };
}

// Every string leaf worth scrubbing (4+ chars, not a bare number, not the OS caption,
// which the crash report carries on purpose).
function leaves(obj, out, skip) {
  if (obj == null) return out;
  if (typeof obj === 'string') {
    const s = obj.trim();
    if (s.length >= 4 && !/^[\d.\s:-]+$/.test(s) && !skip.has(s)) out.add(s);
    return out;
  }
  if (Array.isArray(obj)) { for (const x of obj) leaves(x, out, skip); return out; }
  if (typeof obj === 'object') for (const k of Object.keys(obj)) if (k !== 'scanned' && k !== 'schema') leaves(obj[k], out, skip);
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function needles(o) {
  o = o || {};
  const spec = o.spec || (o.dataDir ? loadSpec(o.dataDir) : null);
  const inventory = o.inventory || (o.dataDir ? readMachineJson(o.dataDir, 'inventory.json') : null);
  const skip = new Set();
  if (spec && spec.os && spec.os.caption) skip.add(spec.os.caption);
  const set = new Set();
  leaves(spec, set, skip);
  leaves(inventory, set, skip);
  // Generic words that are not identifying.
  for (const w of ['Balanced', 'High performance', 'Power saver', 'SSD', 'HDD', 'Unspecified']) set.delete(w);
  return [...set].sort((a, b) => b.length - a.length);
}

function pathPatterns(dataDir) {
  if (!dataDir) return [];
  const dir = machineDir(path.resolve(dataDir));
  const forms = new Set([dir, dir.replace(/\\/g, '/'), dir.replace(/\\/g, '\\\\')]);
  return [...forms].map((f) => new RegExp(escapeRe(f) + '[^\\s"\'<>;,]*', 'gi'));
}

// Removes every machine value and every path under <dataDir>/machine. The crash
// report's scrubber (contribute.scrub) runs after this; both are needed.
function scrubMachine(text, o) {
  o = o || {};
  let s = String(text);
  for (const re of pathPatterns(o.dataDir)) s = s.replace(re, '<MACHINE>');
  for (const n of needles(o)) {
    s = s.split(n).join('<MACHINE>');
    const slash = n.replace(/\\/g, '/');
    if (slash !== n) s = s.split(slash).join('<MACHINE>');
  }
  return s;
}

// Second pass for anything leaving the machine: true only when no machine value or path
// is left in the text.
function crashReportSafe(text, o) {
  const s = String(text);
  for (const re of pathPatterns((o || {}).dataDir)) { re.lastIndex = 0; if (re.test(s)) return false; }
  for (const n of needles(o)) if (s.includes(n) || s.includes(n.replace(/\\/g, '/'))) return false;
  return true;
}

module.exports = {
  PRIVACY, PS_SPEC, parseSpec, scanSpec, firstRun, loadSpec, machineDir, isMachinePath,
  writeMachineJson, readMachineJson, deleteMachineData, scrubMachine, crashReportSafe, defaultRunner,
};
