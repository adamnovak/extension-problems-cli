'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Read a JSON Compilation Database, with each entry's `directory` made
 * absolute. A relative `directory`, or a missing one, is taken relative to
 * the database file.
 */
function readCompileCommands(compileCommands) {
  const base = path.dirname(compileCommands);
  return JSON.parse(fs.readFileSync(compileCommands, 'utf8')).map((entry) => ({
    ...entry,
    directory: path.resolve(base, entry.directory ?? '.'),
  }));
}

/** List the absolute source file paths in a compilation database, without duplicates. */
function filesFromCompileCommands(compileCommands) {
  const files = readCompileCommands(compileCommands).map((entry) => path.resolve(entry.directory, entry.file));
  return [...new Set(files)];
}

/**
 * Return the path of a compilation database whose `directory` fields are
 * all absolute, as the JSON Compilation Database format requires.
 *
 * A database with relative directories is rewritten to a new temporary
 * file, which is removed when the process exits.
 */
function absoluteCompileCommands(compileCommands) {
  const original = JSON.parse(fs.readFileSync(compileCommands, 'utf8'));
  if (original.every((entry) => entry.directory && path.isAbsolute(entry.directory))) {
    return compileCommands;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extension-problems-cli-'));
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'compile_commands.json');
  fs.writeFileSync(file, JSON.stringify(readCompileCommands(compileCommands), null, 2));
  return file;
}

module.exports = { filesFromCompileCommands, absoluteCompileCommands };
