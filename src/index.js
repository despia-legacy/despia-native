'use strict';

const { despiaFunction, observeDespiaVariable } = require('./legacy');
const { DespiaError } = require('./errors');
const { createEventHub } = require('./events');
const { createBridge } = require('./bridge');
const { createApi } = require('./api');
const catalog = require('./features');

const LIMITS = Object.freeze({
  maxMessageBytes: 4194304,
  maxDepth: 32,
  maxNodes: 100000,
  maxKeyLength: 128,
  maxInFlight: 64,
  maxPerSecond: 200,
  newStringMaxBytes: 262144
});

const hub = createEventHub();
const bridge = createBridge(hub);
const api = createApi({
  catalog, bridge, hub, despiaFunction, observeVariable: observeDespiaVariable
});

// New members are non-enumerable so the function object looks as it did.
function define(name, value) {
  Object.defineProperty(despiaFunction, name, {
    value, enumerable: false, writable: false, configurable: false
  });
}

// Resolution order for despia.<x>: the SDK's own words, then a catalog
// feature, then (in the proxy below) the old window pass-through.
Object.keys(api.words).forEach((name) => define(name, api.words[name]));
Object.keys(api.features).forEach((name) => define(name, api.features[name]));
define('DespiaError', DespiaError);
define('LIMITS', LIMITS);

    // Create proxy for window access
    const despia = new Proxy(despiaFunction, {
      get(target, prop) {
        if (prop in target || prop === 'then' || typeof prop === 'symbol') {
          return target[prop];
        }
        
        if (typeof window !== 'undefined' && prop in window) {
          return window[prop];
        }
        
        return undefined;
      },
      
      apply(target, thisArg, args) {
        return target(...args);
      }
    });

module.exports = despia;
