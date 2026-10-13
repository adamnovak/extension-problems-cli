'use strict';

const fs = require('fs');
const path = require('path');
const jsonc = require('jsonc-parser');

// Files shipped with this tool to configure particular extensions.
const DEFAULTS_DIR = path.resolve(__dirname, '..', 'extension-defaults');

/** Read a JSON object from a file that may have comments and trailing commas, like settings.json. */
function readSettingsFile(file) {
  const errors = [];
  const value = jsonc.parse(fs.readFileSync(file, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length) {
    const { error, offset } = errors[0];
    throw new Error(`${file}: ${jsonc.printParseErrorCode(error)} at offset ${offset}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${file}: must contain a JSON object`);
  }
  return value;
}

/**
 * Find a file shipped for an extension in extension-defaults/, named
 * `<extension id><suffix>`. Extension IDs are case-insensitive.
 */
function findDefaultsFile(extensionId, suffix) {
  let names;
  try {
    names = fs.readdirSync(DEFAULTS_DIR);
  } catch {
    return undefined;
  }
  const wanted = `${extensionId}${suffix}`.toLowerCase();
  const name = names.find((n) => n.toLowerCase() === wanted);
  return name && path.join(DEFAULTS_DIR, name);
}

/** Find the shipped default settings file for an extension ID, if there is one. */
function defaultSettingsFile(extensionId) {
  return findDefaultsFile(extensionId, '.jsonc');
}

class UnresolvedVariableError extends Error {}

/**
 * Replace `${name}` and `${env:NAME}` in every string inside `value`.
 * `variables` maps names to strings; a name mapped to undefined, or an unset
 * environment variable, throws UnresolvedVariableError.
 */
function substitute(value, variables) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, name) => {
      const v = name.startsWith('env:') ? process.env[name.slice(4)] : variables[name];
      if (v === undefined) {
        throw new UnresolvedVariableError(match);
      }
      return v;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v) => substitute(v, variables));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, variables)]));
  }
  return value;
}

/**
 * Substitute variables into each top-level setting. A setting whose value
 * uses an unavailable variable is left out, so the extension falls back to
 * its own default, and `warn` is told why.
 */
function resolveSettings(settings, variables, warn) {
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    try {
      out[key] = substitute(value, variables);
    } catch (err) {
      if (!(err instanceof UnresolvedVariableError)) throw err;
      warn(`not setting ${key}: ${err.message} is not available`);
    }
  }
  return out;
}

module.exports = { readSettingsFile, findDefaultsFile, defaultSettingsFile, resolveSettings, substitute };
