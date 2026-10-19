'use strict';
// Slash-command catalogue for the composer drop-up (CON-5): the CLI built-ins plus
// the custom commands and skills a claude pane would see. Read-only.
//
// Sources, highest precedence first (the first row of a name wins):
//   <project>/.claude/commands/**/*.md   (subdir a/b.md -> "a:b")
//   <project>/.claude/skills/*/SKILL.md
//   <configDir>/commands/**/*.md          (configDir = the pane's CLAUDE_CONFIG_DIR)
//   <configDir>/skills/*/SKILL.md
//   CLI built-ins
// Each row: { name, description, source: 'project' | 'user' | 'builtin' }.
const fs = require('fs');
const path = require('path');

const DESC_MAX = 80;
const MAX_FILES = 500; // per source tree, a runaway tree cannot stall the route
const MAX_DEPTH = 4;
const MAX_READ = 16384; // bytes read per file: frontmatter + first body line

const BUILTINS = [
  ['clear', 'Clear conversation history and free up context'],
  ['compact', 'Clear history but keep a summary in context'],
  ['model', 'Set the AI model for Claude Code'],
  ['config', 'Open the config panel'],
  ['context', 'Visualize current context usage'],
  ['cost', 'Show the total cost and duration of this session'],
  ['help', 'Show help and available commands'],
  ['init', 'Initialize a new CLAUDE.md file with codebase documentation'],
  ['memory', 'Edit Claude memory files'],
  ['resume', 'Resume a conversation'],
  ['status', 'Show version, model, account and connectivity status'],
  ['agents', 'Manage agent configurations'],
  ['hooks', 'Manage hook configurations for tool events'],
  ['mcp', 'Manage MCP servers'],
  ['permissions', 'Manage allow and deny tool permission rules'],
  ['review', 'Review a pull request'],
  ['exit', 'Exit the REPL'],
].map(([name, description]) => ({ name, description, source: 'builtin' }));

function clip(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > DESC_MAX ? s.slice(0, DESC_MAX - 3).trimEnd() + '...' : s;
}

function unquote(v) {
  v = v.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
  return v;
}

// Minimal frontmatter reader: top-level `key: value` lines, plus folded/literal
// (`>` / `|`) and indented continuation values. Enough for name / description.
function parseFrontmatter(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1); // BOM
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(t);
  if (!m) return { fm: {}, body: t };
  const fm = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const km = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!km) continue;
    let val = km[2];
    if (/^[>|][-+]?\s*$/.test(val) || val === '') {
      const parts = [];
      while (i + 1 < lines.length && (/^[ \t]+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        if (lines[i].trim()) parts.push(lines[i].trim());
      }
      val = parts.join(' ');
    }
    fm[km[1].toLowerCase()] = unquote(val);
  }
  return { fm, body: t.slice(m[0].length) };
}

function describe(text) {
  const { fm, body } = parseFrontmatter(text);
  if (fm.description) return { fm, description: clip(fm.description) };
  for (const line of body.split('\n')) {
    const s = line.replace(/^\s*#+\s*/, '').trim();
    if (s) return { fm, description: clip(s) };
  }
  return { fm, description: '' };
}

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_READ);
    const n = fs.readSync(fd, buf, 0, MAX_READ, 0);
    return buf.slice(0, n).toString('utf8');
  } catch (e) {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ }
  }
}

function readdir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

const validName = (n) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(n);

// Files a source tree contributes: [{ file, name, kind: 'command' | 'skill' }].
function listCommandFiles(dir) {
  const out = [];
  const walk = (d, ns, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const e of readdir(d)) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, ns.concat(e.name), depth + 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        const name = ns.concat(e.name.replace(/\.md$/i, '')).join(':');
        if (validName(name)) out.push({ file: p, name, kind: 'command' });
      }
    }
  };
  walk(dir, [], 0);
  return out;
}

function listSkillFiles(dir) {
  const out = [];
  for (const e of readdir(dir)) {
    if (out.length >= MAX_FILES) break;
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const f = path.join(dir, e.name, 'SKILL.md');
    if (fs.existsSync(f)) out.push({ file: f, name: e.name, kind: 'skill' });
  }
  return out;
}

function sourceFiles(projectDir, configDir) {
  const list = [];
  const add = (files, source) => { for (const f of files) list.push(Object.assign(f, { source })); };
  if (projectDir) {
    add(listCommandFiles(path.join(projectDir, '.claude', 'commands')), 'project');
    add(listSkillFiles(path.join(projectDir, '.claude', 'skills')), 'project');
  }
  if (configDir) {
    add(listCommandFiles(path.join(configDir, 'commands')), 'user');
    add(listSkillFiles(path.join(configDir, 'skills')), 'user');
  }
  return list;
}

// Signature of a source set: every file's path, mtime and size. Cheap stats only;
// file contents are read again only when the signature changes.
function signature(files) {
  return files.map((f) => {
    let st = null;
    try { st = fs.statSync(f.file); } catch (e) { /* gone */ }
    return f.file + '|' + (st ? st.mtimeMs + '|' + st.size : '-');
  }).join('\n');
}

function buildRows(files) {
  const seen = new Set();
  const rows = [];
  for (const f of files) {
    const { fm, description } = describe(readHead(f.file));
    let name = f.name;
    if (f.kind === 'skill' && fm.name && validName(fm.name)) name = fm.name;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ name, description, source: f.source });
  }
  for (const b of BUILTINS) {
    if (seen.has(b.name)) continue;
    seen.add(b.name);
    rows.push(Object.assign({}, b));
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

class CommandCatalog {
  constructor() {
    this.cache = new Map();
  }

  list(projectDir, configDir) {
    const key = (projectDir || '') + '\n' + (configDir || '');
    const files = sourceFiles(projectDir, configDir);
    const sig = signature(files);
    const hit = this.cache.get(key);
    if (hit && hit.sig === sig) return hit.rows;
    const rows = buildRows(files);
    this.cache.set(key, { sig, rows });
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value);
    return rows;
  }
}

module.exports = { CommandCatalog, BUILTINS, parseFrontmatter, describe, listCommandFiles, listSkillFiles, clip };
