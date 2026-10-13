'use strict';

const fs = require('node:fs');
const jsonc = require('jsonc-parser');

/** Read a JSON object from a file that may have comments and trailing commas, like settings.json. */
function readJsoncObject(file) {
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

module.exports = { readJsoncObject, resolveSettings, substitute };
