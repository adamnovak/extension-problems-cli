/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE.txt in this directory for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

// An implementation of the `vscode` module that extensions run against.

const { Workbench } = require('./workbench');
const { matchSelector } = require('./languages');
const { API_VERSION } = require('./api');

module.exports = { Workbench, matchSelector, API_VERSION };
