/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directory entries never searched for files to analyze.
function isSkippedEntry(name) {
  return name.startsWith('.') || name === 'node_modules';
}

/**
 * Expand files and directories into absolute file paths, without
 * duplicates. Files named directly are always included. Directories are
 * searched recursively, skipping hidden entries and node_modules, for files
 * that `isAnalyzable` accepts.
 */
function collectFiles(paths, isAnalyzable) {
  const files = new Set();
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (isSkippedEntry(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && isAnalyzable(full)) {
        files.add(full);
      }
    }
  };
  for (const p of paths.map((given) => path.resolve(given))) {
    if (fs.statSync(p).isDirectory()) {
      visit(p);
    } else {
      files.add(p);
    }
  }
  return [...files];
}

module.exports = { collectFiles };
