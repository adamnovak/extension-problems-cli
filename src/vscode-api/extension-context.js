/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const types = require('./types');
const { FileMemento } = require('./memento');
const { makeStub, NEVER_FIRES } = require('./stubs');

const { Uri } = types;

/** vscode.SecretStorage, kept in memory for one run. */
function createSecretStorage() {
  const secrets = new Map();
  return {
    get: (key) => Promise.resolve(secrets.get(key)),
    store: (key, value) => {
      secrets.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      secrets.delete(key);
      return Promise.resolve();
    },
    onDidChange: NEVER_FIRES,
  };
}

/**
 * Make the storage directories for an extension under the Workbench's state
 * directory. Workspace storage is per set of workspace folders, as in the
 * editor.
 */
function makeStorageDirs(wb, id) {
  const root = path.join(wb.stateDir, 'extensions', id);
  const workspaceKey = crypto.createHash('sha256')
    .update(wb.workspaceFolders.map((f) => f.uri.fsPath).join('\0'))
    .digest('hex')
    .slice(0, 16);
  const dirs = {
    root,
    global: path.join(root, 'globalStorage'),
    workspace: path.join(root, 'workspaceStorage', workspaceKey),
    logs: path.join(root, 'logs'),
  };
  for (const dir of [dirs.global, dirs.workspace, dirs.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dirs;
}

/**
 * Make the vscode.Extension and vscode.ExtensionContext objects for an
 * extension unpacked at `extensionPath` with the given package.json.
 */
function createExtensionContext(wb, extensionPath, manifest) {
  const id = `${manifest.publisher}.${manifest.name}`;
  const dirs = makeStorageDirs(wb, id);
  const extension = {
    id,
    extensionUri: Uri.file(extensionPath),
    extensionPath,
    packageJSON: manifest,
    extensionKind: types.ExtensionKind.Workspace,
    isActive: false,
    exports: undefined,
    activate: () => Promise.resolve(extension.exports),
  };
  const report = (what) => wb.reportMissing(what);
  const context = wb.permissive({
    subscriptions: [],
    extension,
    extensionPath,
    extensionUri: extension.extensionUri,
    extensionMode: types.ExtensionMode.Production,
    asAbsolutePath: (rel) => path.join(extensionPath, rel),
    globalState: new FileMemento(path.join(dirs.root, 'globalState.json')),
    workspaceState: new FileMemento(path.join(dirs.workspace, 'workspaceState.json')),
    secrets: createSecretStorage(),
    globalStorageUri: Uri.file(dirs.global),
    globalStoragePath: dirs.global,
    storageUri: Uri.file(dirs.workspace),
    storagePath: dirs.workspace,
    logUri: Uri.file(dirs.logs),
    logPath: dirs.logs,
    environmentVariableCollection: makeStub('ExtensionContext.environmentVariableCollection', report),
    languageModelAccessInformation: makeStub('ExtensionContext.languageModelAccessInformation', report),
  }, 'ExtensionContext');
  return { extension, context };
}

/** Make the vscode.extensions namespace for a Workbench. */
function createExtensions(wb) {
  return {
    getExtension: (id) => wb.extensions.find((x) => x.id.toLowerCase() === String(id).toLowerCase()),
    get all() { return wb.extensions; },
    onDidChange: NEVER_FIRES,
  };
}

module.exports = { createExtensionContext, createExtensions };
