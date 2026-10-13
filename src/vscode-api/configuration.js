'use strict';

const { EventEmitter } = require('./types');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepClone(v) {
  return v === undefined ? undefined : structuredClone(v);
}

/** Store `value` in nested object `tree` under the dotted path `key`. */
function setPath(tree, key, value) {
  const parts = key.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node[part])) {
      node[part] = {};
    }
    node = node[part];
  }
  node[parts[parts.length - 1]] = value;
}

function getPath(tree, key) {
  let node = tree;
  for (const part of key ? key.split('.') : []) {
    if (!isPlainObject(node) || !(part in node)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

/** Overlay `top` onto `bottom`, merging plain objects key by key. */
function merge(bottom, top) {
  if (top === undefined) return bottom;
  if (!isPlainObject(bottom) || !isPlainObject(top)) return top;
  const out = { ...bottom };
  for (const [k, v] of Object.entries(top)) {
    out[k] = merge(bottom[k], v);
  }
  return out;
}

/**
 * Settings, as seen through vscode.workspace.getConfiguration().
 *
 * Defaults come from the `contributes.configuration` sections of extension
 * manifests. User settings come from the command line and act as the
 * "Global" (user settings.json) level; there are no workspace-level settings
 * files. Updates made by the extension are kept in memory for this run only.
 */
class ConfigurationStore {
  constructor() {
    // Both trees are nested objects keyed by the parts of dotted setting names.
    this._defaults = {};
    this._user = {};
    this._onDidChange = new EventEmitter();
    this.onDidChangeConfiguration = this._onDidChange.event;
  }

  addDefaultsFromManifest(manifest) {
    let sections = manifest?.contributes?.configuration ?? [];
    if (!Array.isArray(sections)) {
      sections = [sections];
    }
    for (const section of sections) {
      for (const [key, schema] of Object.entries(section.properties ?? {})) {
        if ('default' in schema) {
          setPath(this._defaults, key, deepClone(schema.default));
        } else {
          setPath(this._defaults, key, defaultForType(schema.type));
        }
      }
    }
  }

  setUser(key, value) {
    setPath(this._user, key, deepClone(value));
  }

  _effective(key) {
    return merge(getPath(this._defaults, key), getPath(this._user, key));
  }

  getConfiguration(section) {
    const store = this;
    const full = (key) => (section ? (key ? `${section}.${key}` : section) : key);
    const config = {
      get(key, defaultValue) {
        const v = store._effective(full(key));
        return v === undefined ? defaultValue : deepClone(v);
      },
      has(key) {
        return store._effective(full(key)) !== undefined;
      },
      inspect(key) {
        const k = full(key);
        return {
          key: k,
          defaultValue: deepClone(getPath(store._defaults, k)),
          globalValue: deepClone(getPath(store._user, k)),
          workspaceValue: undefined,
          workspaceFolderValue: undefined,
        };
      },
      update(key, value) {
        const k = full(key);
        if (value === undefined) {
          const parts = k.split('.');
          const parent = getPath(store._user, parts.slice(0, -1).join('.'));
          if (isPlainObject(parent)) delete parent[parts[parts.length - 1]];
        } else {
          setPath(store._user, k, deepClone(value));
        }
        store._onDidChange.fire({
          affectsConfiguration: (s) => s === k || k.startsWith(`${s}.`) || s.startsWith(`${k}.`),
        });
        return Promise.resolve();
      },
    };
    // A WorkspaceConfiguration also exposes the section's settings as
    // read-only properties.
    const tree = store._effective(section ?? '');
    if (isPlainObject(tree)) {
      for (const [k, v] of Object.entries(tree)) {
        if (!(k in config)) config[k] = deepClone(v);
      }
    }
    return Object.freeze(config);
  }
}

function defaultForType(type) {
  switch (Array.isArray(type) ? type[0] : type) {
    case 'boolean': return false;
    case 'string': return '';
    case 'number':
    case 'integer': return 0;
    case 'array': return [];
    case 'object': return {};
    default: return null;
  }
}

module.exports = { ConfigurationStore };
