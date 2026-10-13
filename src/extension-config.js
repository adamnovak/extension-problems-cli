'use strict';

const fs = require('fs');
const path = require('path');
const { readJsoncObject } = require('./settings');

// Files shipped with this tool to configure particular extensions, named
// `<extension id>.jsonc`.
const CONFIGS_DIR = path.resolve(__dirname, '..', 'extension-configs');

/**
 * Load the shipped configuration for an extension:
 *
 *   {
 *     "settings": { <settings.json-style defaults; see resolveSettings()> },
 *     "readiness": { <rule for asking the server if it is ready; see readiness.js> }
 *   }
 *
 * Both sections are optional. An extension with no file gets `{}`.
 *
 * @returns {{config: object, file?: string}}
 */
function loadExtensionConfig(extensionId) {
  let names;
  try {
    names = fs.readdirSync(CONFIGS_DIR);
  } catch {
    return { config: {} };
  }
  // Extension IDs are case-insensitive.
  const name = names.find((n) => n.toLowerCase() === `${extensionId.toLowerCase()}.jsonc`);
  if (!name) {
    return { config: {} };
  }
  const file = path.join(CONFIGS_DIR, name);
  return { config: readJsoncObject(file), file };
}

module.exports = { loadExtensionConfig };
