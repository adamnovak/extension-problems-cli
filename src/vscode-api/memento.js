/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Persistent key-value storage for vscode.Memento. Values are written
 * through to a JSON file so that they survive between runs, as they do in
 * the editor.
 */
class FileMemento {
  constructor(file) {
    this._file = file;
    try {
      this._data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // A missing or unreadable file means nothing has been stored yet.
      this._data = {};
    }
  }

  keys() {
    return Object.keys(this._data);
  }

  get(key, defaultValue) {
    return key in this._data ? structuredClone(this._data[key]) : defaultValue;
  }

  update(key, value) {
    if (value === undefined) {
      delete this._data[key];
    } else {
      this._data[key] = structuredClone(value);
    }
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.writeFileSync(this._file, JSON.stringify(this._data, null, 2));
    return Promise.resolve();
  }

  setKeysForSync() {
    // Settings Sync does not exist here, so there is nothing to sync with.
  }
}

module.exports = { FileMemento };
