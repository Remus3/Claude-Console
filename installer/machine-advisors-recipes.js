'use strict';
// CON-013 L9: the per-app recipe registry for the app-config advisor (inventory
// mach-app-config-edit, mach-adv-games). A recipe names the app, the processes that
// must be closed, its config files (with a parser format), and a list of changes. Each
// change is OFF until the user accepts it: it is previewed, backed up, written only
// when the key already exists with the same type, read back, and revertable.
//
// A change: {id, file, key, title, why, to: value | (spec) => value, when?: (spec) =>
// bool, requires?: [change ids]}. Keys are "Section.Key" for ini, a dotted path for
// json, a tag name or "Tag@attr" for xml, a slash path for vdf.
//
// Pattern source: the recorded app tuning of 2026-10-11 (detect the hardware, back up
// every file, edit existing keys, read back, then confirm the effect in the app - one
// hand-edited key was ignored by its client, which only a live check showed).

const FORMATS = ['ini', 'json', 'xml', 'vdf'];

const vram = (spec) => (spec && spec.gpu ? Number(spec.gpu.vram_gb) || 0 : 0);
const hz = (spec) => {
  const d = spec && (spec.primary_display || (spec.displays || [])[0]);
  return d ? Number(d.max_hz || d.hz) || 0 : 0;
};

const CIV6_DIR = "%LOCALAPPDATA%\\Firaxis Games\\Sid Meier's Civilization VI";

const REGISTRY = [
  {
    id: 'civ6',
    title: "Sid Meier's Civilization VI",
    steam_appid: '289070',
    processes: ['CivilizationVI.exe', 'CivilizationVI_DX12.exe', 'LaunchPad.exe'],
    files: {
      graphics: { path: CIV6_DIR + '\\GraphicsOptions.txt', format: 'ini' },
      user: { path: CIV6_DIR + '\\UserOptions.txt', format: 'ini' },
    },
    confirm: 'Start the game once and check Options > Graphics shows the new values; the game rewrites a file it does not accept.',
    changes: [
      {
        id: 'perf-override', file: 'graphics', key: 'Video.PerformanceImpact', to: '-1',
        title: 'Let the file settings apply (performance preset to custom)',
        why: 'The game applies GraphicsOptions.txt only while PerformanceImpact is -1; any other value overrides every graphics change below.',
      },
      {
        id: 'msaa', file: 'graphics', key: 'Video.MSAA', to: (s) => (vram(s) >= 8 ? '4' : '2'), when: (s) => vram(s) >= 4, requires: ['perf-override'],
        title: 'Anti-aliasing (MSAA) 4x on 8 GB+ VRAM, 2x below',
        why: 'MSAA smooths unit and terrain edges; 4 samples fit easily in 8 GB of video memory at 1440p, 2 samples below that.',
      },
      {
        id: 'terrain-shader', file: 'graphics', key: 'Terrain.LowQualityTerrainShader', to: '0', when: (s) => vram(s) >= 4, requires: ['perf-override'],
        title: 'Full-quality terrain shader',
        why: 'The low-quality shader cuts texture filtering and specular light on the map; a 4 GB+ GPU runs the full shader with no visible cost.',
      },
      {
        id: 'water-shader', file: 'graphics', key: 'General.UseLowQualityWaterShader', to: '0', when: (s) => vram(s) >= 4, requires: ['perf-override'],
        title: 'High-quality water (refraction and reflection)',
        why: 'The low-quality water shader drops refraction and reflection; a 4 GB+ GPU renders them at full frame rate.',
      },
      {
        id: 'screen-overlay', file: 'graphics', key: 'General.ScreenSpaceOverlay', to: '0', requires: ['perf-override'],
        title: 'Screen-space overlay effect off',
        why: 'A full-screen post effect over the map; off gives a cleaner image and was part of the recorded tuning.',
      },
      {
        id: 'ao', file: 'graphics', key: 'AO.EnableAO', to: '1', when: (s) => vram(s) >= 6, requires: ['perf-override'],
        title: 'Ambient occlusion on',
        why: 'Ambient occlusion adds contact shadows to units and buildings; it needs about 6 GB of video memory to stay smooth.',
      },
      {
        id: 'refresh-rate', file: 'graphics', key: 'Video.RefreshRateInHz', to: (s) => String(hz(s)), when: (s) => hz(s) >= 60, requires: ['perf-override'],
        title: 'Full-screen refresh rate = the primary display\'s maximum',
        why: 'The game defaults to a lower full-screen refresh rate than the display supports; matching the display maximum gives smoother panning.',
      },
      {
        id: 'quick-movement', file: 'user', key: 'Gameplay.QuickMovement', to: '1',
        title: 'Quick movement (skip unit move animations)',
        why: 'Late-game turns spend most of their time on move animations; skipping them shortens every turn and changes no rule.',
      },
      {
        id: 'quick-combat', file: 'user', key: 'Gameplay.QuickCombat', to: '1',
        title: 'Quick combat (skip combat animations)',
        why: 'Combat animations repeat for every attack; skipping them shortens turns and changes no outcome.',
      },
    ],
  },
];

function list() {
  return REGISTRY.slice();
}

function get(id) {
  return REGISTRY.find((r) => r.id === id) || null;
}

// Structural check; [] = valid.
function validate(r) {
  const errs = [];
  if (!r || typeof r !== 'object') return ['not an object'];
  if (!/^[a-z0-9-]+$/.test(String(r.id || ''))) errs.push('bad id');
  if (!r.title) errs.push('no title');
  if (!Array.isArray(r.processes)) errs.push('processes must be a list');
  const files = r.files && typeof r.files === 'object' ? r.files : {};
  if (!Object.keys(files).length) errs.push('no files');
  for (const k of Object.keys(files)) {
    if (!files[k] || typeof files[k].path !== 'string') errs.push('file ' + k + ' has no path');
    if (!FORMATS.includes(files[k] && files[k].format)) errs.push('file ' + k + ' has no known format');
  }
  const ids = new Set();
  for (const c of Array.isArray(r.changes) ? r.changes : []) {
    if (!c || !/^[a-z0-9-]+$/.test(String(c.id || ''))) { errs.push('bad change id'); continue; }
    if (ids.has(c.id)) errs.push('duplicate change ' + c.id);
    ids.add(c.id);
    if (!files[c.file]) errs.push(c.id + ': unknown file ' + c.file);
    if (!c.key) errs.push(c.id + ': no key');
    if (c.to === undefined) errs.push(c.id + ': no target value');
    if (!c.title) errs.push(c.id + ': no title');
    if (!c.why) errs.push(c.id + ': no why');
  }
  for (const c of Array.isArray(r.changes) ? r.changes : []) for (const q of (c && c.requires) || []) if (!ids.has(q)) errs.push(c.id + ': requires unknown ' + q);
  if (!Array.isArray(r.changes) || !r.changes.length) errs.push('no changes');
  return errs;
}

module.exports = { REGISTRY, FORMATS, list, get, validate };
