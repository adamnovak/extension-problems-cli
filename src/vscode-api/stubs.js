/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) The VSCodium contributors.
 *  Licensed under the MIT License. See LICENSE.txt in this directory for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { Disposable } = require('./types');

const NEVER_FIRES = () => new Disposable(() => {});

/**
 * Make a value that can stand in for any unimplemented API member: it can be
 * called, constructed, and have arbitrary properties read, each producing
 * another stub. `report` is called with a description of each use.
 *
 * Stubs have no `then`, so awaiting one yields the stub itself instead of
 * hanging.
 */
function makeStub(name, report) {
  const target = function stub() {};
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') return () => `[stub ${name}]`;
      if (prop === 'prototype') return t.prototype;
      if (prop === 'dispose') return () => {};
      return makeStub(`${name}.${prop}`, report);
    },
    set() {
      return true;
    },
    apply() {
      report(`${name}()`);
      return makeStub(`${name}()`, report);
    },
    construct() {
      report(`new ${name}()`);
      return makeStub(`${name} instance`, report);
    },
  });
}

/**
 * Wrap an API object so that reading a member it lacks gives a usable
 * stand-in instead of `undefined`, and reports the access.
 *
 * Members named like events (`onDid...`, `onWill...`) become events that
 * never fire. Members named like registration functions (`register...`)
 * accept anything and return a Disposable, because nothing here ever calls
 * back into what was registered. Other missing members become stubs from
 * makeStub().
 */
function permissive(obj, name, report) {
  return new Proxy(obj, {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol' || prop in t) {
        return Reflect.get(t, prop, receiver);
      }
      // Module loaders probe for these; an answer other than undefined
      // changes how they treat the object.
      if (prop === 'then' || prop === 'toJSON' || prop === '__esModule' || prop === 'default') return undefined;
      const full = `${name}.${prop}`;
      report(full);
      if (/^on(Did|Will)[A-Z]/.test(prop)) {
        return NEVER_FIRES;
      }
      if (/^register[A-Z]/.test(prop)) {
        return NEVER_FIRES;
      }
      return makeStub(full, report);
    },
  });
}

module.exports = { makeStub, permissive, NEVER_FIRES };
