'use strict';
// CON-BOARD-LINK: a project's claude.ai status-board artifact link. Read only:
// nothing here writes into a project tree. Resolution order, first valid wins:
//   1. the project's `board` in config (console.json, overridable by
//      data/console.local.json through the usual deepMerge);
//   2. the mapping file named by config `boardsFile` ({"boards": {"<CODE>": "<url>"}},
//      keyed by project code; optional, default unset);
//   3. the tree-local file <repo>/ops/loop/control/board.json ({"url": "..."}).
// Only https://claude.ai/artifact/<id> and https://claude.ai/code/artifact/<uuid>
// are accepted; anything else is ignored.
const fs = require('fs');
const path = require('path');

const BOARD_RE = /^https:\/\/claude\.ai\/(?:artifact\/[A-Za-z0-9_-]{6,64}|code\/artifact\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const TREE_BOARD_REL = path.join('ops', 'loop', 'control', 'board.json');

function validBoard(u) {
  return typeof u === 'string' && u.length <= 200 && BOARD_RE.test(u) ? u : null;
}

function readJsonSafe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 65536) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\s+/, ''));
  } catch (e) {
    return null;
  }
}

// The boardsFile mapping, read once per call site (opts.mapping lets a caller reuse it).
function readBoardsFile(cfg) {
  const f = cfg && typeof cfg.boardsFile === 'string' && cfg.boardsFile ? cfg.boardsFile : null;
  if (!f) return {};
  const j = readJsonSafe(f);
  return j && j.boards && typeof j.boards === 'object' && !Array.isArray(j.boards) ? j.boards : {};
}

// project: { name, code, dir }; cfg: the merged console config.
function resolveBoard(project, cfg, opts) {
  if (!project) return null;
  const o = (cfg && cfg.projects && cfg.projects[project.name]) || {};
  const a = validBoard(o.board);
  if (a) return a;
  const mapping = opts && opts.mapping ? opts.mapping : readBoardsFile(cfg);
  if (project.code && Object.prototype.hasOwnProperty.call(mapping, project.code)) {
    const b = validBoard(mapping[project.code]);
    if (b) return b;
  }
  if (project.dir) {
    const j = readJsonSafe(path.join(project.dir, TREE_BOARD_REL));
    const c = j && validBoard(j.url);
    if (c) return c;
  }
  return null;
}

// Open the board in the default browser (the console's Edge --app window uses its
// own profile, which is not signed in to claude.ai). The URL is re-validated here;
// explorer.exe hands it to the default handler, no shell, no console window.
function openBoard(url, spawnFn) {
  const u = validBoard(url);
  if (!u) return { ok: false, error: 'no valid board link' };
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    const child = (spawnFn || require('child_process').spawn)(exe, [u], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    if (child && child.on) child.on('error', () => {});
    if (child && child.unref) child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { validBoard, resolveBoard, readBoardsFile, openBoard, BOARD_RE, TREE_BOARD_REL };
