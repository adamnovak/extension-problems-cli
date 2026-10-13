#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (status) => process.exit(status),
  (err) => {
    process.stderr.write(`extension-problems-cli: ${err instanceof Error ? err.stack : JSON.stringify(err)}\n`);
    process.exit(1);
  },
);
