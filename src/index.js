'use strict';

const { despiaFunction } = require('./legacy');
const { DespiaError } = require('./errors');
const { createEventHub } = require('./events');
const { createTransport } = require('./transport');
const { createApi } = require('./api');
const features = require('./features');

const hub = createEventHub();
const transport = createTransport();
transport.install(hub.dispatch);

const api = createApi({ features, transport, hub, despiaFunction });

const legacy = Object.freeze({
  // Reads a variable the app injected the old way (window[name]).
  variable(name) {
    return typeof window !== 'undefined' ? window[name] : undefined;
  }
});

// New members are non-enumerable so the function object looks as it did.
function define(name, value) {
  Object.defineProperty(despiaFunction, name, {
    value, enumerable: false, writable: false, configurable: false
  });
}

Object.keys(api.namespaces).forEach((name) => define(name, api.namespaces[name]));
define('on', function on(listener) {
  return hub.onAny(listener);
});
define('legacy', legacy);
define('DespiaError', DespiaError);

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
