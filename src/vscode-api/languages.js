/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const path = require('node:path');
const { minimatch } = require('minimatch');

// Language IDs for file name extensions, as VS Code's built-in language
// support assigns them. Extensions can add more in their manifests.
const BUILTIN_LANGUAGES = {
  c: ['.c', '.i'],
  cpp: ['.cpp', '.cc', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++', '.h', '.ii', '.ino', '.inl', '.ipp', '.ixx', '.tpp', '.txx'],
  'objective-c': ['.m'],
  'objective-cpp': ['.mm'],
  csharp: ['.cs', '.csx', '.cake'],
  css: ['.css'],
  scss: ['.scss'],
  less: ['.less'],
  dockerfile: ['.dockerfile', '.containerfile'],
  go: ['.go'],
  html: ['.html', '.htm', '.shtml', '.xhtml'],
  java: ['.java', '.jav'],
  javascript: ['.js', '.es6', '.mjs', '.cjs', '.pac'],
  javascriptreact: ['.jsx'],
  json: ['.json', '.code-workspace'],
  jsonc: ['.jsonc'],
  kotlin: ['.kt', '.kts'],
  markdown: ['.md', '.markdown', '.mdown', '.mkd'],
  php: ['.php', '.php4', '.php5', '.phtml', '.ctp'],
  plaintext: ['.txt'],
  python: ['.py', '.rpy', '.pyw', '.cpy', '.gyp', '.gypi', '.pyi', '.ipy', '.pyt'],
  ruby: ['.rb', '.rbx', '.rjs', '.gemspec', '.rake', '.ru', '.erb', '.podspec', '.rbi'],
  rust: ['.rs'],
  scala: ['.scala', '.sc'],
  shellscript: ['.sh', '.bash', '.bashrc', '.zsh', '.ksh', '.ebuild', '.eclass'],
  sql: ['.sql', '.dsql'],
  swift: ['.swift'],
  terraform: ['.tf'],
  typescript: ['.ts', '.cts', '.mts'],
  typescriptreact: ['.tsx'],
  xml: ['.xml', '.xsd', '.ascx', '.atom', '.axml', '.bpmn', '.csproj', '.dtd', '.svg', '.xaml', '.xsl', '.xslt'],
  yaml: ['.yaml', '.yml', '.eyaml', '.eyml', '.cff'],
};

// Scores for a selector field: an exact match beats a `*` wildcard.
const EXACT = 10;
const WILDCARD = 5;

/** Score one selector field against a document value; undefined means no match. */
function scoreField(wanted, actual) {
  if (wanted === actual) return EXACT;
  if (wanted === '*') return WILDCARD;
  return undefined;
}

function patternMatches(pattern, document) {
  const glob = typeof pattern === 'string' ? pattern : path.join(pattern.base, pattern.pattern);
  return minimatch(document.uri.fsPath, glob, { dot: true, matchBase: !glob.includes('/') });
}

/** Score a vscode.DocumentFilter; 0 for no match. */
function scoreFilter(filter, document) {
  if (filter.notebookType) return 0;
  const scores = [0];
  if (filter.language) scores.push(scoreField(filter.language, document.languageId));
  if (filter.scheme) scores.push(scoreField(filter.scheme, document.uri.scheme));
  if (filter.pattern) scores.push(patternMatches(filter.pattern, document) ? EXACT : undefined);
  return scores.includes(undefined) ? 0 : Math.max(...scores);
}

/**
 * Score how well a vscode.DocumentSelector matches a document, as
 * vscode.languages.match() does: 0 for no match, higher for better matches.
 */
function matchSelector(selector, document) {
  if (Array.isArray(selector)) {
    return Math.max(0, ...selector.map((s) => matchSelector(s, document)));
  }
  if (typeof selector === 'string') {
    return scoreField(selector, document.languageId) ?? 0;
  }
  return selector ? scoreFilter(selector, document) : 0;
}

class DiagnosticCollection {
  /**
   * @param {string} name
   * @param {(collection: DiagnosticCollection, uri: object) => void} onChange
   *   Called after the diagnostics for a URI change.
   */
  constructor(name, onChange) {
    this.name = name;
    // Entries of {uri, diagnostics}, keyed by URI string.
    this._entries = new Map();
    this._onChange = onChange;
  }

  set(uriOrEntries, diagnostics) {
    if (Array.isArray(uriOrEntries)) {
      for (const [uri, diags] of uriOrEntries) {
        this.set(uri, diags);
      }
      return;
    }
    const key = uriOrEntries.toString();
    if (diagnostics === undefined || diagnostics === null) {
      this._entries.delete(key);
    } else {
      this._entries.set(key, { uri: uriOrEntries, diagnostics: [...diagnostics] });
    }
    this._onChange(this, uriOrEntries);
  }

  delete(uri) {
    this._entries.delete(uri.toString());
    this._onChange(this, uri);
  }

  clear() {
    const uris = Array.from(this._entries.values(), (e) => e.uri);
    this._entries.clear();
    for (const uri of uris) this._onChange(this, uri);
  }

  get(uri) {
    return this._entries.get(uri.toString())?.diagnostics;
  }

  has(uri) {
    return this._entries.has(uri.toString());
  }

  forEach(callback, thisArg) {
    for (const { uri, diagnostics } of this._entries.values()) {
      callback.call(thisArg, uri, diagnostics, this);
    }
  }

  *[Symbol.iterator]() {
    for (const { uri, diagnostics } of this._entries.values()) {
      yield [uri, diagnostics];
    }
  }

  dispose() {
    this.clear();
  }
}

/** Make the vscode.languages namespace for a Workbench. */
function createLanguages(wb) {
  return {
    createDiagnosticCollection(name) {
      const collection = new DiagnosticCollection(name ?? `collection${wb.diagnosticCollections.size}`,
        (c, uri) => wb.onDiagnosticsChanged(c, uri));
      const dispose = collection.dispose.bind(collection);
      collection.dispose = () => {
        dispose();
        wb.diagnosticCollections.delete(collection);
      };
      wb.diagnosticCollections.add(collection);
      return collection;
    },
    getDiagnostics: (uri) => wb.getDiagnostics(uri),
    onDidChangeDiagnostics: wb.emitters.changeDiagnostics.event,
    match: matchSelector,
    getLanguages: () => Promise.resolve([...new Set(wb.languageByExtension.values())]),
    setTextDocumentLanguage: (doc) => Promise.resolve(doc),
  };
}

module.exports = { BUILTIN_LANGUAGES, matchSelector, DiagnosticCollection, createLanguages };
