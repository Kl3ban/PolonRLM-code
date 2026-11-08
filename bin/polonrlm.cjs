#!/usr/bin/env node
'use strict';
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const target = join(__dirname, '..', 'dist', 'cli.js');
if (!existsSync(target)) {
  console.error('PolonRLM: brak kompilacji. W katalogu projektu uruchom npm install i npm run build.');
  process.exitCode = 1;
} else {
  import(require('node:url').pathToFileURL(target).href).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
