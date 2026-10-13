/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { minimatch } = require('minimatch');

const { Uri, FileType, FileSystemError } = require('./types');
const { TextDocument } = require('./text-document');
const { NEVER_FIRES, ignore } = require('./stubs');

function fileTypeOf(stats) {
  if (stats.isDirectory()) return FileType.Directory;
  if (stats.isFile()) return FileType.File;
  return FileType.Unknown;
}

/** Convert a Node.js file system error to the vscode.FileSystemError an extension expects. */
function toFileSystemError(err, uri) {
  switch (err?.code) {
    case 'ENOENT': return FileSystemError.FileNotFound(uri);
    case 'EEXIST': return FileSystemError.FileExists(uri);
    case 'ENOTDIR': return FileSystemError.FileNotADirectory(uri);
    case 'EISDIR': return FileSystemError.FileIsADirectory(uri);
    case 'EACCES':
    case 'EPERM': return FileSystemError.NoPermissions(uri);
    default: return err;
  }
}

/** Run a file system operation, converting its errors as toFileSystemError() does. */
async function fsCall(uri, operation) {
  try {
    return await operation();
  } catch (err) {
    throw toFileSystemError(err, uri);
  }
}

/** vscode.workspace.fs, for `file:` URIs only. */
const workspaceFs = {
  stat: (uri) => fsCall(uri, async () => {
    const stats = await fs.promises.stat(uri.fsPath);
    return { type: fileTypeOf(stats), ctime: stats.ctimeMs, mtime: stats.mtimeMs, size: stats.size };
  }),
  readFile: (uri) => fsCall(uri, async () => new Uint8Array(await fs.promises.readFile(uri.fsPath))),
  writeFile: (uri, content) => fsCall(uri, async () => {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  }),
  readDirectory: (uri) => fsCall(uri, async () => {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((entry) => [entry.name, fileTypeOf(entry)]);
  }),
  createDirectory: (uri) => fsCall(uri, () => fs.promises.mkdir(uri.fsPath, { recursive: true })),
  delete: (uri, options) => fsCall(uri, () => fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive, force: true })),
  rename: (source, target) => fsCall(source, () => fs.promises.rename(source.fsPath, target.fsPath)),
  copy: (source, target) => fsCall(source, () => fs.promises.cp(source.fsPath, target.fsPath, { recursive: true })),
  isWritableFileSystem: (scheme) => scheme === 'file',
};

/** Split a vscode.GlobPattern into a base directory (null for the workspace folders) and a glob. */
function toGlob(pattern) {
  return typeof pattern === 'string'
    ? { base: null, pattern }
    : { base: pattern.baseUri.fsPath, pattern: pattern.pattern };
}

/**
 * vscode.workspace.findFiles(): files under the workspace folders, or under
 * the include pattern's base, that match `include` and not `exclude`.
 */
async function findFiles(wb, include, exclude, maxResults) {
  const inc = toGlob(include);
  const exc = exclude ? toGlob(exclude) : null;
  const roots = inc.base ? [inc.base] : wb.workspaceFolders.map((f) => f.uri.fsPath);
  const excluded = (root, rel) => {
    if (!exc) return false;
    const relToExclude = exc.base ? path.relative(exc.base, path.join(root, rel)) : rel;
    return minimatch(relToExclude, exc.pattern, { dot: true });
  };
  const perRoot = await Promise.all(roots.map(async (root) => {
    const entries = await fs.promises.readdir(root, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
      .filter((rel) => minimatch(rel, inc.pattern, { dot: true }) && !excluded(root, rel))
      .map((rel) => Uri.file(path.join(root, rel)));
  }));
  const results = perRoot.flat();
  return maxResults === undefined ? results : results.slice(0, maxResults);
}

/** Make the vscode.workspace namespace for a Workbench. */
function createWorkspace(wb) {
  const workspace = {
    get workspaceFolders() { return wb.workspaceFolders.length ? wb.workspaceFolders : undefined; },
    get name() { return wb.workspaceFolders[0]?.name; },
    get rootPath() { return wb.workspaceFolders[0]?.uri.fsPath; },
    workspaceFile: undefined,
    isTrusted: true,
    get textDocuments() { return [...wb.documents.values()]; },
    notebookDocuments: [],
    getWorkspaceFolder(uri) {
      const p = uri.fsPath;
      return wb.workspaceFolders
        .filter((f) => p === f.uri.fsPath || p.startsWith(f.uri.fsPath + path.sep))
        .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)[0];
    },
    asRelativePath(pathOrUri, includeWorkspaceFolder) {
      const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
      const folder = workspace.getWorkspaceFolder(Uri.file(p));
      if (!folder) return p;
      const rel = path.relative(folder.uri.fsPath, p);
      return includeWorkspaceFolder && wb.workspaceFolders.length > 1 ? `${folder.name}/${rel}` : rel;
    },
    getConfiguration: (section) => wb.configuration.getConfiguration(section),
    onDidChangeConfiguration: wb.configuration.onDidChangeConfiguration,
    openTextDocument(arg) {
      if (arg && typeof arg === 'object' && !(arg instanceof Uri) && !arg.scheme) {
        const uri = Uri.from({ scheme: 'untitled', path: `Untitled-${wb.documents.size + 1}` });
        const doc = new TextDocument(uri, arg.language ?? 'plaintext', arg.content ?? '');
        wb.documents.set(uri.toString(), doc);
        wb.emitters.openTextDocument.fire(doc);
        return Promise.resolve(doc);
      }
      return wb.openDocument(arg);
    },
    onDidOpenTextDocument: wb.emitters.openTextDocument.event,
    onDidCloseTextDocument: wb.emitters.closeTextDocument.event,
    onDidChangeTextDocument: wb.emitters.changeTextDocument.event,
    onDidSaveTextDocument: wb.emitters.saveTextDocument.event,
    fs: wb.permissive(workspaceFs, 'workspace.fs'),
    findFiles: (include, exclude, maxResults) => findFiles(wb, include, exclude, maxResults),
    createFileSystemWatcher: () => ({
      ignoreCreateEvents: false,
      ignoreChangeEvents: false,
      ignoreDeleteEvents: false,
      onDidCreate: NEVER_FIRES,
      onDidChange: NEVER_FIRES,
      onDidDelete: NEVER_FIRES,
      dispose: ignore,
    }),
    applyEdit() {
      wb.reportMissing('workspace.applyEdit');
      return Promise.resolve(false);
    },
    saveAll: () => Promise.resolve(true),
  };
  return workspace;
}

module.exports = { createWorkspace };
