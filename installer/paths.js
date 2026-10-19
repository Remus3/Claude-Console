'use strict';
// Install layout (CON-PUBLIC B/D). Everything lives under one
// home, %LOCALAPPDATA%\Programs\claude-console by default, overridable by opts.home or the
// CLAUDE_CONSOLE_HOME variable (tests always pass a scratch dir):
//   install.json            the install marker {version, path, channel, installedAt, previous}
//   app/<version>/          the code of one release (node_modules installed in place)
//   .base/<version>/        a pristine copy of that release: the base of every 3-way merge
//   data/  run/  drops/     user data, OUTSIDE the code dir; an update never touches it
//   backups/                timestamped zips taken before any change
//   reports/                update / repair / contribute reports
//   cache/                  release-check ETag cache, downloads
const os = require('os');
const path = require('path');

function defaultHome(env) {
  env = env || process.env;
  if (env.CLAUDE_CONSOLE_HOME) return path.resolve(env.CLAUDE_CONSOLE_HOME);
  const local = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', 'claude-console');
}

function layout(home) {
  home = path.resolve(home || defaultHome());
  return {
    home,
    marker: path.join(home, 'install.json'),
    appRoot: path.join(home, 'app'),
    app: (v) => path.join(home, 'app', safeVersion(v)),
    baseRoot: path.join(home, '.base'),
    base: (v) => path.join(home, '.base', safeVersion(v)),
    data: path.join(home, 'data'),
    run: path.join(home, 'run'),
    drops: path.join(home, 'drops'),
    backups: path.join(home, 'backups'),
    reports: path.join(home, 'reports'),
    cache: path.join(home, 'cache'),
    downloads: path.join(home, 'cache', 'downloads'),
    launcherVbs: path.join(home, 'launch.vbs'),
  };
}

// A version string becomes a directory name: semver-ish only, never a path.
function safeVersion(v) {
  const s = String(v || '');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]{1,40})?$/.test(s)) throw new Error('bad version: ' + s.slice(0, 40));
  return s;
}

function stamp(d) {
  return (d || new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

module.exports = { defaultHome, layout, safeVersion, stamp };
