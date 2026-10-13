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
const { NEVER_FIRES, ignore } = require('./stubs');

/**
 * Read the machine ID from the state directory, creating a random one on
 * first use, so it stays the same between runs as it does in the editor.
 */
function machineId(stateDir) {
  const file = path.join(stateDir, 'machine-id');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    // No ID has been made yet.
    const id = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, id);
    return id;
  }
}

/** Make the vscode.env namespace for a Workbench. */
function createEnv(wb) {
  return {
    appName: 'Visual Studio Code',
    appRoot: path.resolve(__dirname, '..', '..'),
    appHost: 'desktop',
    uriScheme: 'vscode',
    language: 'en',
    machineId: machineId(wb.stateDir),
    sessionId: crypto.randomUUID(),
    isNewAppInstall: false,
    // The editor-wide telemetry switch is off.
    isTelemetryEnabled: false,
    onDidChangeTelemetryEnabled: NEVER_FIRES,
    logLevel: types.LogLevel.Info,
    onDidChangeLogLevel: NEVER_FIRES,
    remoteName: undefined,
    shell: process.env.SHELL ?? '/bin/sh',
    uiKind: types.UIKind.Desktop,
    clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
    openExternal(uri) {
      wb.log('env.openExternal', uri.toString());
      return Promise.resolve(false);
    },
    asExternalUri: (uri) => Promise.resolve(uri),
    createTelemetryLogger: () => wb.permissive({
      isUsageEnabled: false,
      isErrorsEnabled: false,
      onDidChangeEnableStates: NEVER_FIRES,
      logUsage: ignore,
      logError: ignore,
      dispose: ignore,
    }, 'TelemetryLogger'),
  };
}

module.exports = { createEnv };
