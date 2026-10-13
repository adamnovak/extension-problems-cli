'use strict';

/**
 * A readiness rule says how to ask an extension's language server whether
 * it can analyze files yet. It is the `readiness` section of an extension
 * config (see extension-config.js):
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
  return valuesAt(response, p.split('.')).includes(equals);
}

module.exports = { isNotReady, valuesAt };
