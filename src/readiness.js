'use strict';

const { readSettingsFile, findDefaultsFile } = require('./settings');

/**
 * A way to ask an extension's language server whether it can analyze files
 * yet, read from `extension-defaults/<extension id>.readiness.jsonc`:
 *
 *   {
 *     "client": "<LanguageClient name; optional if there is only one>",
 *     "request": "<LSP request method>",
 *     "params": <request params>,
 *     "notReadyWhen": { "path": "<dotted path, * for every element>", "equals": <value> }
 *   }
 *
 * The server is not ready while any value at `path` in the response equals
 * `equals`.
 */
function loadReadinessRule(extensionId) {
  const file = findDefaultsFile(extensionId, '.readiness.jsonc');
  return file && readSettingsFile(file);
}

/** All values at a dotted path, where a `*` part matches every element. */
function valuesAt(value, parts) {
  if (parts.length === 0) {
    return [value];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const [first, ...rest] = parts;
  const next = first === '*' ? Object.values(value) : [value[first]];
  return next.flatMap((v) => valuesAt(v, rest));
}

function isNotReady(rule, response) {
  const { path: p, equals } = rule.notReadyWhen;
  return valuesAt(response, p.split('.')).some((v) => v === equals);
}

module.exports = { loadReadinessRule, isNotReady, valuesAt };
