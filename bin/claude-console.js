#!/usr/bin/env node
'use strict';
// claude-console CLI entry (CON-PUBLIC B). `node bin/claude-console.js install` (or install.ps1)
// installs to %LOCALAPPDATA%\Programs\claude-console; the installed launchers call this file.
require('../installer/cli').run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (e) => {
  process.stderr.write('claude-console: ' + (e && e.message || e) + '\n');
  process.exitCode = 1;
});
