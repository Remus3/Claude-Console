'use strict';
// CON-BOARD-LOCAL (kit v23, ruled 2026-10-25: the status board is local
// only): a project's Status board is the static page the kit's fleet_board.py
// renders at <repo>/ops/loop/control/board/board.html (no script, no network).
// Read only: nothing here writes into a project tree. The page never sends a path;
// the server resolves it from the project's own dir and re-checks it before opening.
// No artifact web link is read or opened any more (the CON-BOARD-LINK config `board`,
// `boardsFile` and <repo>/ops/loop/control/board.json are ignored).
const fs = require('fs');
const path = require('path');

const BOARD_HTML_REL = path.join('ops', 'loop', 'control', 'board', 'board.html');
const BOARD_HTML_MAX = 4 * 1024 * 1024;

function boardFile(project) {
  if (!project || typeof project.dir !== 'string' || !project.dir) return null;
  return path.join(project.dir, BOARD_HTML_REL);
}

// The board page's absolute path when the tree has one (a regular file, not huge),
// else null. A tree before kit v23 has none: no Status board row.
function resolveBoard(project) {
  const f = boardFile(project);
  if (!f) return null;
  try {
    const st = fs.lstatSync(f);
    return st.isFile() && st.size > 0 && st.size <= BOARD_HTML_MAX ? f : null;
  } catch (e) {
    return null;
  }
}

// Open the project's local board.html in the default browser (explorer.exe hands the
// file to the .html handler; no shell, no console window). The path is re-resolved
// from the project here, never taken from a caller.
function openBoard(project, spawnFn) {
  const f = resolveBoard(project);
  if (!f) return { ok: false, error: 'no local status board (board.html not rendered yet)' };
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    const child = (spawnFn || require('child_process').spawn)(exe, [f], { detached: true, stdio: 'ignore', windowsHide: false, shell: false });
    if (child && child.on) child.on('error', () => {});
    if (child && child.unref) child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { resolveBoard, openBoard, boardFile, BOARD_HTML_REL };
