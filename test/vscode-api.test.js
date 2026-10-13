/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 Regents of the University of California.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Uri, Position, Range } = require('../src/vscode-api/types');
const { TextDocument } = require('../src/vscode-api/text-document');
const { ConfigurationStore } = require('../src/vscode-api/configuration');
const { matchSelector } = require('../src/vscode-api');

test('TextDocument maps offsets and positions across mixed line breaks', () => {
  const doc = new TextDocument(Uri.file('/x.cpp'), 'cpp', 'ab\r\ncd\nef');
  assert.strictEqual(doc.lineCount, 3);
  assert.strictEqual(doc.lineAt(0).text, 'ab');
  assert.strictEqual(doc.lineAt(1).text, 'cd');
  assert.strictEqual(doc.offsetAt(new Position(1, 1)), 5);
  assert.deepStrictEqual(doc.positionAt(5).toJSON(), { line: 1, character: 1 });
  assert.deepStrictEqual(doc.positionAt(3).toJSON(), { line: 0, character: 2 });
  assert.strictEqual(doc.getText(new Range(0, 1, 2, 1)), 'b\r\ncd\ne');
});

test('configuration layers user settings over manifest defaults', () => {
  const store = new ConfigurationStore();
  store.addDefaultsFromManifest({
    contributes: {
      configuration: {
        properties: {
          'ext.flag': { type: 'boolean', default: false },
          'ext.rules': { type: 'object', default: { a: 1 } },
          'ext.path': { type: 'string' },
        },
      },
    },
  });
  store.setUser('ext.flag', true);
  store.setUser('ext.rules', { b: 2 });
  const config = store.getConfiguration('ext');
  assert.strictEqual(config.get('flag'), true);
  assert.deepStrictEqual(config.get('rules'), { a: 1, b: 2 });
  assert.strictEqual(config.get('path'), '');
  assert.strictEqual(config.get('missing', 7), 7);
  assert.strictEqual(store.getConfiguration().get('ext.flag'), true);
  assert.strictEqual(config.inspect('flag').defaultValue, false);
  assert.strictEqual(config.inspect('flag').globalValue, true);
});

test('document selectors match by language, scheme and pattern', () => {
  const doc = { languageId: 'cpp', uri: Uri.file('/src/a.cpp') };
  assert.ok(matchSelector('cpp', doc) > 0);
  assert.strictEqual(matchSelector('c', doc), 0);
  assert.ok(matchSelector([{ scheme: 'file', language: 'cpp' }], doc) > 0);
  assert.strictEqual(matchSelector({ scheme: 'untitled' }, doc), 0);
  assert.ok(matchSelector({ pattern: '**/*.cpp' }, doc) > 0);
  assert.strictEqual(matchSelector({ pattern: '**/*.py' }, doc), 0);
});

test('readiness rules match values at wildcard paths', () => {
  const { isNotReady } = require('../src/readiness');
  const rule = { notReadyWhen: { path: 'pluginStatuses.*.state', equals: 2 } };
  assert.ok(isNotReady(rule, { pluginStatuses: [{ state: 0 }, { state: 2 }] }));
  assert.ok(!isNotReady(rule, { pluginStatuses: [{ state: 0 }, { state: 3 }] }));
  assert.ok(!isNotReady(rule, {}));
});

test('collectFiles keeps named files and searches named directories', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { collectFiles } = require('../src/files');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-files-test-'));
  try {
    for (const rel of ['a/one.cpp', 'a/one.h', 'a/notes.bin', 'a/.hidden/two.cpp', 'a/node_modules/three.js', 'b/four.cpp']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), '');
    }
    const known = (f) => ['.cpp', '.h', '.js'].includes(path.extname(f));
    const found = collectFiles([path.join(root, 'a'), path.join(root, 'b/four.cpp')], known)
      .map((f) => path.relative(root, f)).sort();
    assert.deepStrictEqual(found, ['a/one.cpp', 'a/one.h', 'b/four.cpp']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
