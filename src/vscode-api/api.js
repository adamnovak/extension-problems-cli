/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const types = require('./types');
const { createWorkspace } = require('./workspace');
const { createWindow } = require('./window');
const { createLanguages } = require('./languages');
const { createCommands } = require('./commands');
const { createEnv } = require('./env');
const { createExtensions } = require('./extension-context');
const { l10n } = require('./l10n');

// Version of the editor API this module pretends to provide. Extensions
// check it against their `engines.vscode` range.
const API_VERSION = '1.105.0';

/** Make the `vscode` module object for a Workbench. */
function buildApi(wb) {
  return wb.permissive({
    ...types,
    version: API_VERSION,
    workspace: wb.permissive(createWorkspace(wb), 'workspace'),
    window: wb.permissive(createWindow(wb), 'window'),
    languages: wb.permissive(createLanguages(wb), 'languages'),
    commands: wb.permissive(createCommands(wb), 'commands'),
    env: wb.permissive(createEnv(wb), 'env'),
    extensions: wb.permissive(createExtensions(wb), 'extensions'),
    l10n,
  }, 'vscode');
}

module.exports = { buildApi, API_VERSION };
