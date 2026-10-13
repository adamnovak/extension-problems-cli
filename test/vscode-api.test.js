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
