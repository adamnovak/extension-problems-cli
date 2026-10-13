/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { Disposable } = require('./types');
const { ignore } = require('./stubs');

// The edit builder passed to text editor commands. Edits are not applied.
const IGNORED_EDIT_BUILDER = { replace: ignore, insert: ignore, delete: ignore, setEndOfLine: ignore };

/** Make the vscode.commands namespace for a Workbench. */
function createCommands(wb) {
  const commands = {
    registerCommand(id, callback, thisArg) {
      wb.commands.set(id, { callback, thisArg });
      return new Disposable(() => wb.commands.delete(id));
    },
    registerTextEditorCommand(id, callback, thisArg) {
      return commands.registerCommand(id, (...args) => {
        if (!wb.activeEditor) return undefined;
        return callback.call(thisArg, wb.activeEditor, IGNORED_EDIT_BUILDER, ...args);
      });
    },
    executeCommand: (id, ...args) => wb.executeCommand(id, ...args),
    getCommands: () => Promise.resolve([...wb.commands.keys()]),
  };
  return commands;
}

module.exports = { createCommands };
