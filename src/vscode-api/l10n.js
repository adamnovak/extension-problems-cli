/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE.txt in this directory for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * vscode.l10n, with no translations: messages come back in the language
 * they were written in, with `{name}` placeholders filled in.
 */
const l10n = {
  t(...args) {
    const options = typeof args[0] === 'object' ? args[0] : { message: args[0], args: args.slice(1) };
    // Placeholder values: an array for `{0}`-style, an object for `{name}`-style.
    const values = options.args ?? [];
    return String(options.message).replaceAll(/\{(\w+)\}/g, (placeholder, key) => {
      const value = values[key];
      return value === undefined ? placeholder : String(value);
    });
  },
  bundle: undefined,
  uri: undefined,
};

module.exports = { l10n };
