#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).then(
  (status) => process.exit(status),
  (err) => {
    process.stderr.write(`extension-problems-cli: ${err instanceof Error ? err.stack : JSON.stringify(err)}\n`);
    process.exit(1);
  },
);
