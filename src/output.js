/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const path = require('node:path');

const SEVERITY_NAMES = ['error', 'warning', 'information', 'hint'];
const TAG_NAMES = { 1: 'unnecessary', 2: 'deprecated' };

function uriToFile(uri) {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

/** Convert a range to the 1-based line and column numbers the editor shows. */
function span(range) {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

/** Convert a vscode.Diagnostic in a named collection to a plain problem record. */
function toProblem({ collection, uri, diagnostic: d }) {
  const codeIsObject = d.code !== null && typeof d.code === 'object';
  const code = codeIsObject ? d.code.value : d.code;
  const problem = {
    file: uriToFile(uri),
    ...span(d.range),
    severity: SEVERITY_NAMES[d.severity] ?? String(d.severity),
    message: d.message,
    source: d.source,
    code: code === undefined ? undefined : String(code),
    codeUrl: codeIsObject ? d.code.target?.toString() : undefined,
    collection,
  };
  if (d.tags?.length) {
    problem.tags = d.tags.map((t) => TAG_NAMES[t] ?? t);
  }
  if (d.relatedInformation?.length) {
    problem.relatedInformation = d.relatedInformation.map((ri) => ({
      file: uriToFile(ri.location.uri),
      ...span(ri.location.range),
      message: ri.message,
    }));
  }
  return problem;
}

function compareProblems(a, b) {
  return a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column
    || a.message.localeCompare(b.message);
}

/** Show a path relative to the current directory when it is inside it. */
function displayPath(file) {
  const rel = path.relative(process.cwd(), file);
  return rel.startsWith('..') ? file : rel;
}

/** Format problems as compiler-style lines: `file:line:column: severity: message [source code]`. */
function formatPretty({ problems, unanalyzedFiles }) {
  const lines = [];
  for (const p of problems) {
    const tag = [p.source, p.code].filter(Boolean).join(' ');
    const suffix = tag ? ` [${tag}]` : '';
    lines.push(`${displayPath(p.file)}:${p.line}:${p.column}: ${p.severity}: ${p.message}${suffix}`);
    for (const ri of p.relatedInformation ?? []) {
      lines.push(`  ${displayPath(ri.file)}:${ri.line}:${ri.column}: note: ${ri.message}`);
    }
  }
  for (const f of unanalyzedFiles) {
    lines.push(`${displayPath(f)}: no results from the extension`);
  }
  return lines.map((line) => `${line}\n`).join('');
}

function formatJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

module.exports = { toProblem, compareProblems, formatPretty, formatJson };
