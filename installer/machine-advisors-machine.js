'use strict';
// CON-013 L9 (inventory mach-adv-machine): findings from the measured spec. Findings
// are rules (derive them, never edit their text to make one go away); each carries what
// to do, and none of them writes anything.
const DISK_FREE_WARN_PCT = 20; // machine_insights.DISK_FREE_WARN_PCT

function advise(ctx) {
  const spec = (ctx && ctx.spec) || {};
  const out = [];
  const ram = spec.ram || {};
  if (ram.rated_mts && ram.configured_mts && ram.configured_mts < ram.rated_mts) {
    out.push({
      id: 'machine.ram-speed', advisor: 'machine', level: 'info',
      title: 'Memory runs below its rated speed',
      body: 'Modules rated ' + ram.rated_mts + ' MT/s are running at ' + ram.configured_mts + ' MT/s.',
      do: 'Check the firmware for a memory profile (XMP / EXPO); leave it if the firmware offers none.',
    });
  }
  for (const d of spec.disks || []) {
    if (d.free_pct && d.free_pct < DISK_FREE_WARN_PCT) {
      out.push({
        id: 'machine.disk-free:' + d.id, advisor: 'machine', level: 'warning',
        title: 'Disk ' + d.id + ' is down to ' + d.free_pct + '% free',
        body: d.free_gb + ' GB free of ' + d.size_gb + ' GB.',
        do: 'Review the cleanup suggestions in Health; every one goes to the Recycle Bin, and only the ones you pick.',
      });
    }
  }
  if (spec.gpu && spec.gpu.vram_gb && spec.gpu.vram_gb < 4) {
    out.push({
      id: 'machine.gpu-vram', advisor: 'machine', level: 'info',
      title: 'Video memory is under 4 GB',
      body: spec.gpu.vram_gb + ' GB of video memory: game advice keeps the low-cost settings.',
      do: 'Nothing to change; the game advisor already sizes its proposals to this.',
    });
  }
  return out;
}

module.exports = { advise, DISK_FREE_WARN_PCT };
