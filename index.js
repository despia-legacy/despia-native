// index.js - despia-native 1.1.0
// Generated from src/ by scripts/build.js. Edit src/, then run `npm run build`.
(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
      define([], factory);
    } else if (typeof module === 'object' && module.exports) {
      module.exports = factory();
    } else {
      root.despia = factory();
    }
  }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var __modules = {};
  var __cache = {};
  function __require(id) {
    if (__cache[id]) return __cache[id].exports;
    var module = (__cache[id] = { exports: {} });
    __modules[id](module, module.exports, __require);
    return module.exports;
  }

  // ---- src/api.js ----
  __modules['./api'] = function (module, exports, require) {
    // Typed API: despia.<feature>.<action>(args) and despia.<feature>.on(event, fn).
    // Routes each call to the JSON bridge, else to the feature's legacy scheme,
    // else rejects with not_in_app.

    const { DespiaError, ErrorCodes } = require('./errors');

    function isPlainObject(value) {
      return Object.prototype.toString.call(value) === '[object Object]';
    }

    function typeOf(value) {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
      return typeof value;
    }

    function matchesType(expected, value) {
      const actual = typeOf(value);
      if (expected === 'number') return actual === 'number' || actual === 'integer';
      return actual === expected;
    }

    // Returns an error message, or null when args satisfy the spec.
    function validateArgs(feature, action, params, args) {
      const where = feature + '.' + action;
      for (const name of Object.keys(params || {})) {
        const spec = params[name];
        const value = args[name];
        if (value === undefined) {
          if (spec.required) return where + ': "' + name + '" is required';
          continue;
        }
        if (spec.type && !matchesType(spec.type, value)) {
          return where + ': "' + name + '" must be ' + spec.type + ', got ' + typeOf(value);
        }
        if (typeof value === 'number' && !Number.isFinite(value)) {
          return where + ': "' + name + '" must be finite';
        }
        const size = typeof value === 'number' ? value
          : (typeof value === 'string' || Array.isArray(value)) ? value.length
          : undefined;
        const unit = typeof value === 'number' ? '' : ' in length';
        if (size !== undefined && spec.min !== undefined && size < spec.min) {
          return where + ': "' + name + '" must be at least ' + spec.min + unit;
        }
        if (size !== undefined && spec.max !== undefined && size > spec.max) {
          return where + ': "' + name + '" must be at most ' + spec.max + unit;
        }
      }
      return null;
    }

    function fillTemplate(template, args) {
      return template.replace(/\{([^}]+)\}/g, (_, name) => String(args[name]));
    }

    function buildLegacyCommand(legacy, args) {
      const parts = [];
      const query = legacy.query || {};
      for (const key of Object.keys(query)) {
        const value = args[query[key]];
        if (value === undefined || value === null) continue;
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        parts.push(key + '=' + encodeURIComponent(text));
      }
      return parts.length ? legacy.scheme + '?' + parts.join('&') : legacy.scheme;
    }

    function createApi({ features, transport, hub, despiaFunction }) {
      function legacyCall(feature, action, legacy, args) {
        const command = buildLegacyCommand(legacy, args);
        const watch = (legacy.watch || []).map((name) => fillTemplate(name, args));
        if (watch.length === 0) {
          return despiaFunction(command).then(() => undefined);
        }
        return despiaFunction(command, watch).then((values) => {
          values = values || {};
          const missing = watch.filter((name) => values[name] === undefined);
          if (missing.length) {
            throw new DespiaError(
              ErrorCodes.TIMEOUT,
              feature + '.' + action + ': no reply in ' + missing.join(', ')
            );
          }
          return legacy.result ? values[fillTemplate(legacy.result, args)] : values;
        });
      }

      function call(feature, action, spec, args) {
        if (args === undefined || args === null) args = {};
        if (!isPlainObject(args)) {
          return Promise.reject(new DespiaError(
            ErrorCodes.INVALID_ARGS, feature + '.' + action + ': args must be a plain object'
          ));
        }
        const problem = validateArgs(feature, action, spec.params, args);
        if (problem) return Promise.reject(new DespiaError(ErrorCodes.INVALID_ARGS, problem));

        const mode = transport.mode();
        if (mode === 'ios' || mode === 'android') {
          return transport.request(feature, action, args);
        }
        if (mode === 'legacy') {
          if (!spec.legacy) {
            return Promise.reject(new DespiaError(
              ErrorCodes.UNSUPPORTED,
              feature + '.' + action + ' needs a newer app build (no legacy scheme)'
            ));
          }
          try {
            return legacyCall(feature, action, spec.legacy, args);
          } catch (e) {
            return Promise.reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, e && e.message));
          }
        }
        return Promise.reject(new DespiaError(
          ErrorCodes.NOT_IN_APP,
          feature + '.' + action + ' is only available inside the Despia app'
        ));
      }

      function createFeature(feature) {
        const spec = features[feature];
        const ns = {};
        Object.keys(spec.actions).forEach((action) => {
          const actionSpec = spec.actions[action];
          ns[action] = function (args) {
            return call(feature, action, actionSpec, args);
          };
        });
        ns.on = function (event, fn) {
          return hub.on(feature, event, fn);
        };
        return Object.freeze(ns);
      }

      const namespaces = {};
      Object.keys(features).forEach((feature) => {
        namespaces[feature] = createFeature(feature);
      });

      return { namespaces, validateArgs, buildLegacyCommand };
    }

    module.exports = { createApi };
  };

  // ---- src/errors.js ----
  __modules['./errors'] = function (module, exports, require) {
    // Error type for every rejection of the new `despia.<feature>.<action>()` API.
    // Native error codes pass through unchanged; the SDK adds the codes below.

    const ErrorCodes = Object.freeze({
      NOT_IN_APP: 'not_in_app',     // plain browser: no JSON bridge and no Despia runtime
      UNSUPPORTED: 'unsupported',   // no JSON bridge and the action has no legacy scheme
      INVALID_ARGS: 'invalid_args', // args failed validation or are not JSON-serialisable
      TIMEOUT: 'timeout',           // legacy fallback: the result variable never arrived
      BRIDGE_ERROR: 'bridge_error', // transport failure or malformed reply
      NATIVE_ERROR: 'native_error'  // native rejected without a structured error
    });

    class DespiaError extends Error {
      constructor(code, message, details) {
        super(message || String(code));
        this.name = 'DespiaError';
        this.code = String(code);
        if (details !== undefined) this.details = details;
      }
    }

    module.exports = { DespiaError, ErrorCodes };
  };

  // ---- src/events.js ----
  __modules['./events'] = function (module, exports, require) {
    // In-page event hub. The transport feeds it `{ feature, event, data }`;
    // pages subscribe per feature/event or to everything (broadcast).

    function createEventHub() {
      const byKey = new Map(); // "feature\u0000event" -> Set of subscription records
      const broadcast = new Set();

      function assertListener(fn) {
        if (typeof fn !== 'function') throw new TypeError('Despia: listener must be a function');
      }

      function subscribe(set, record, cleanup) {
        set.add(record);
        let active = true;
        return function off() {
          if (!active) return;
          active = false;
          set.delete(record);
          if (cleanup) cleanup();
        };
      }

      function on(feature, event, fn) {
        assertListener(fn);
        if (typeof event !== 'string' || event === '') {
          throw new TypeError('Despia: event name must be a non-empty string');
        }
        const key = feature + '\u0000' + event;
        let set = byKey.get(key);
        if (!set) byKey.set(key, (set = new Set()));
        return subscribe(set, { fn }, () => {
          if (set.size === 0 && byKey.get(key) === set) byKey.delete(key);
        });
      }

      function onAny(fn) {
        assertListener(fn);
        return subscribe(broadcast, { fn });
      }

      function call(fn, arg) {
        try {
          fn(arg);
        } catch (e) {
          console.error('Despia event listener failed:', e);
        }
      }

      function dispatch(feature, event, data) {
        const set = byKey.get(feature + '\u0000' + event);
        // Snapshot so listeners may unsubscribe while being called.
        if (set) Array.from(set).forEach((record) => call(record.fn, data));
        if (broadcast.size) {
          const payload = { feature, event, data };
          Array.from(broadcast).forEach((record) => call(record.fn, payload));
        }
      }

      return { on, onAny, dispatch };
    }

    module.exports = { createEventHub };
  };

  // ---- src/features.js ----
  __modules['./features'] = function (module, exports, require) {
    // Runtime feature map: actions, their parameters and the legacy scheme each
    // one falls back to when the JSON bridge is not present. The type-level twin
    // of this table is features.d.ts.
    //
    // Hand-written for now. scripts/generate-features.js emits this exact shape
    // from native routes.json files and will replace this file.
    //
    // action = {
    //   params: { name: { type, required?, min?, max? } },  // validated before sending
    //   legacy: {                                           // omitted = no fallback
    //     scheme: 'scheme://route',
    //     query:  { queryKey: 'paramName' },                // appended as ?queryKey=value
    //     watch:  ['windowVar' | '{paramName}'],            // variables the app writes back
    //     result: 'windowVar' | '{paramName}'               // resolve with one variable;
    //   }                                                   // omitted = object of all watched
    // }

    module.exports = {
      haptics: {
        actions: {
          light: { params: {}, legacy: { scheme: 'lighthaptic://' } },
          heavy: { params: {}, legacy: { scheme: 'heavyhaptic://' } },
          success: { params: {}, legacy: { scheme: 'successhaptic://' } },
          warning: { params: {}, legacy: { scheme: 'warninghaptic://' } },
          error: { params: {}, legacy: { scheme: 'errorhaptic://' } }
        },
        events: []
      },

      vault: {
        actions: {
          set: {
            params: {
              key: { type: 'string', required: true, min: 1 },
              value: { type: 'string', required: true },
              locked: { type: 'boolean' }
            },
            legacy: {
              scheme: 'setvault://',
              query: { key: 'key', value: 'value', locked: 'locked' }
            }
          },
          get: {
            params: {
              key: { type: 'string', required: true, min: 1 }
            },
            legacy: {
              scheme: 'readvault://',
              query: { key: 'key' },
              watch: ['{key}'],
              result: '{key}'
            }
          }
        },
        events: []
      },

      device: {
        actions: {
          appVersion: {
            params: {},
            legacy: { scheme: 'getappversion://', watch: ['versionNumber', 'bundleNumber'] }
          },
          uuid: {
            params: {},
            legacy: { scheme: 'get-uuid://', watch: ['uuid'], result: 'uuid' }
          },
          storeLocation: {
            params: {},
            legacy: { scheme: 'getstorelocation://', watch: ['storeLocation'], result: 'storeLocation' }
          }
        },
        events: []
      },

      revenuecat: {
        actions: {
          purchase: {
            params: {
              externalId: { type: 'string', required: true, min: 1 },
              product: { type: 'string', required: true, min: 1 }
            },
            legacy: {
              scheme: 'revenuecat://purchase',
              query: { external_id: 'externalId', product: 'product' }
            }
          },
          paywall: {
            params: {
              externalId: { type: 'string', required: true, min: 1 },
              offering: { type: 'string', min: 1 }
            },
            legacy: {
              scheme: 'revenuecat://launchPaywall',
              query: { external_id: 'externalId', offering: 'offering' }
            }
          },
          history: {
            params: {},
            legacy: { scheme: 'getpurchasehistory://', watch: ['restoredData'], result: 'restoredData' }
          }
        },
        events: ['purchase']
      },

      gps: {
        actions: {
          start: {
            params: {
              buffer: { type: 'integer', min: 1 },
              movement: { type: 'integer', min: 0 },
              server: { type: 'string', min: 1 }
            },
            legacy: {
              scheme: 'location://',
              query: { buffer: 'buffer', movement: 'movement', server: 'server' }
            }
          },
          stop: {
            params: {},
            legacy: { scheme: 'stoplocation://', watch: ['locationSession'], result: 'locationSession' }
          }
        },
        events: ['change']
      }
    };
  };

  // ---- src/legacy.js ----
  __modules['./legacy'] = function (module, exports, require) {
    // Legacy scheme bridge: `despia("scheme://...", ["var"])`.
    //
    // This file is the 1.0.28 implementation moved here unchanged. Do not edit
    // its behaviour: test/legacy.test.js runs it side by side with the original
    // release and requires identical output.

        // Command queue for sequential execution
        const commandQueue = [];
        let processing = false;
      
        // Process command queue with 1ms delay between commands
        function processQueue() {
          if (processing || commandQueue.length === 0) return;
          
          processing = true;
          const { command } = commandQueue.shift();
          
          try {
            // Use the setter pattern: window.despia = command
            window.despia = command;
          } catch (e) {
            console.error('Despia command failed:', e);
          }
          
          setTimeout(() => {
            processing = false;
            processQueue();
          }, 1);
        }
      
        // Add command to queue
        function queueCommand(command) {
          if (typeof window !== 'undefined') {
            commandQueue.push({ command });
            processQueue();
          }
        }

        // Generate a safe signature for change detection
        function safeSig(val) {
            if (val === undefined) return 'u';
            if (val === null) return 'n';
            const t = typeof val;
            if (t !== 'object') return `${t}:${String(val)}`;
            try { return `o:${JSON.stringify(val)}`; } catch { return 'o:[unserializable]'; }
        }
      
        // Simple variable observer with longer timeout, change detection, and guaranteed resolve
        function observeDespiaVariable(variableName, callback, timeout = 30000) {
            const startTime = Date.now();
            const initialRef = window[variableName];
            const initialSig = safeSig(initialRef);

            const ready = (val) => {
                if (val === undefined || val === "n/a") return false;
                if (Array.isArray(val) && val.length === 0) return false;
                if (val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length === 0) return false;
                return true;
            };

            const changed = (val) => {
                // Special case: if value is null, always consider it changed (immediate signal)
                if (val === null) return true;
                
                if (val !== initialRef) return true;
                return safeSig(val) !== initialSig;
            };

            function checkVariable() {
                const val = window[variableName];

                if (ready(val) && changed(val)) {
                    // Fresh, non-empty value arrived → resolve with it
                    callback(val);
                    return;
                }

                if (Date.now() - startTime < timeout) {
                    setTimeout(checkVariable, 100);
                    return;
                }

                // Timeout: still resolve so promises don't hang
                console.error(`Despia timeout: ${variableName} was not set within ${timeout} ms`);
                callback(undefined);
            }

            checkVariable();
        }

        // VariableTracker class for complex multi-variable observation
        class VariableTracker {
            constructor(variables, onReady) {
                this.variables = variables;
                this.onReady = onReady;
                this.triggered = false;
                this.processing = false;
                
                // Create tracker element
                this.tracker = document.createElement('div');
                this.tracker.style.display = 'none';
                document.body.appendChild(this.tracker);
                
                // Setup observer with debounce
                let timeout;
                this.observer = new MutationObserver(() => {
                    clearTimeout(timeout);
                    timeout = setTimeout(() => this.check(), 100);
                });
                
                // Start observing and checking
                this.observer.observe(this.tracker, { attributes: true });
                this.check();
                this.interval = setInterval(() => this.check(), 1000);
            }

            check() {
                if (this.processing || this.triggered) return;
                this.processing = true;

                try {
                    const values = {};
                    const allSet = this.variables.every(name => {
                        const val = window[name];
                        // Check for undefined, "n/a" string, or null values
                        if (val === undefined || val === "n/a" || val === null) return false;
                        values[name] = val;
                        return true;
                    });

                    if (allSet && !this.triggered) {
                        this.triggered = true;
                        this.cleanup();
                        this.onReady(values);
                    }
                } catch (err) {
                    console.error("Error during check:", err);
                }
                
                this.processing = false;
            }

            cleanup() {
                this.observer.disconnect();
                clearInterval(this.interval);
                this.tracker.remove();
            }
        }

        // Observe variables - simple for single variable, tracker for multiple
        function observeVariables(variables, timeout) {
            if (!variables || variables.length === 0) {
                return Promise.resolve({});
            }

            // Pre-clear watched vars to avoid stale immediate resolves
            variables.forEach((name) => {
                try { delete window[name]; } catch (e) { window[name] = undefined; }
            });

            if (variables.length === 1) {
                // Simple single variable observation with 30-second timeout
                return new Promise((resolve) => {
                    observeDespiaVariable(variables[0], (value) => {
                        resolve({ [variables[0]]: value });
                    }, 30000);
                });
            } else {
                // Multiple variables - use VariableTracker (no timeout, expires after 5 minutes)
                return new Promise((resolve) => {
                    const tracker = new VariableTracker(variables, resolve);
                    // Auto-cleanup after 5 minutes if not triggered
                    setTimeout(() => {
                        if (!tracker.triggered) {
                            tracker.cleanup();
                            resolve({});
                        }
                    }, 300000); // 5 minutes
                });
            }
        }
      
        // Main despia function
        function despiaFunction(command, watch = []) {
          // Queue command execution
          queueCommand(command);
          
          // No variables to watch
          if (!watch || watch.length === 0) {
            return Promise.resolve();
          }
          
          // Watch for variables (timeout handled internally)
          return observeVariables(watch);
        }

    module.exports = { despiaFunction };
  };

  // ---- src/transport.js ----
  __modules['./transport'] = function (module, exports, require) {
    // JSON bridge transport. This file is the whole wire contract; if the
    // contract changes, this is the only module that should need to.
    //
    //   page -> native   { v: 1, id, feature, action, args }
    //     iOS      await window.webkit.messageHandlers.despia.postMessage(msg)
    //              (WKScriptMessageHandlerWithReply; the promise resolves with the reply)
    //     Android  window.despia_bridge.postMessage(JSON.stringify(msg))
    //              (androidx.webkit addWebMessageListener; reply arrives as a message, matched by id)
    //
    //   native -> page reply   { id, ok: true, value } | { id, ok: false, error: { code, message } }
    //   native -> page event   window.__despia.emit({ feature, event, data })
    //                          (Android may also post the event object over despia_bridge)
    //
    // With neither bridge present, mode() reports 'legacy' inside the Despia
    // runtime (user agent contains "despia") and 'none' in a plain browser.

    const { DespiaError, ErrorCodes } = require('./errors');

    const PROTOCOL_VERSION = 1;
    const IOS_HANDLER = 'despia';
    const ANDROID_OBJECT = 'despia_bridge';
    const EMIT_HOOK = '__despia';

    function getWindow() {
      return typeof window !== 'undefined' ? window : undefined;
    }

    function iosHandler(win) {
      try {
        const handlers = win.webkit && win.webkit.messageHandlers;
        const handler = handlers && handlers[IOS_HANDLER];
        return handler && typeof handler.postMessage === 'function' ? handler : null;
      } catch (e) {
        return null;
      }
    }

    function androidBridge(win) {
      try {
        const bridge = win[ANDROID_OBJECT];
        return bridge && typeof bridge.postMessage === 'function' ? bridge : null;
      } catch (e) {
        return null;
      }
    }

    function isDespiaRuntime(win) {
      const ua = win.navigator && win.navigator.userAgent;
      return typeof ua === 'string' && ua.toLowerCase().indexOf('despia') !== -1;
    }

    function parseMaybeJson(value) {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch (e) {
        return undefined;
      }
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function isEvent(msg) {
      return isObject(msg) && typeof msg.feature === 'string' && typeof msg.event === 'string';
    }

    function isReply(msg) {
      return isObject(msg) && typeof msg.id === 'string' && typeof msg.ok === 'boolean';
    }

    function settle(reply, resolve, reject) {
      if (reply.ok) {
        resolve(reply.value);
        return;
      }
      const err = isObject(reply.error) ? reply.error : {};
      reject(new DespiaError(
        err.code || ErrorCodes.NATIVE_ERROR,
        err.message || 'Native call failed',
        err.details
      ));
    }

    function randomPrefix() {
      return Math.random().toString(36).slice(2, 8) + Date.now().toString(36);
    }

    function createTransport() {
      const prefix = randomPrefix();
      const pending = new Map(); // id -> { resolve, reject } (Android only)
      let seq = 0;
      let eventSink = null;
      let androidAttached = null;

      function mode() {
        const win = getWindow();
        if (!win) return 'none';
        if (iosHandler(win)) return 'ios';
        if (androidBridge(win)) return 'android';
        if (isDespiaRuntime(win)) return 'legacy';
        return 'none';
      }

      function deliverEvent(msg) {
        if (eventSink) eventSink(msg.feature, msg.event, msg.data);
      }

      function onAndroidMessage(evt) {
        const msg = parseMaybeJson(evt && evt.data !== undefined ? evt.data : evt);
        if (isReply(msg)) {
          const entry = pending.get(msg.id);
          if (!entry) return; // another SDK copy on the page, or a late reply
          pending.delete(msg.id);
          settle(msg, entry.resolve, entry.reject);
        } else if (isEvent(msg)) {
          deliverEvent(msg);
        }
      }

      function attachAndroid(bridge) {
        if (androidAttached === bridge) return;
        androidAttached = bridge;
        if (typeof bridge.addEventListener === 'function') {
          bridge.addEventListener('message', onAndroidMessage);
        } else {
          const previous = bridge.onmessage;
          bridge.onmessage = function (evt) {
            onAndroidMessage(evt);
            if (typeof previous === 'function') previous.call(this, evt);
          };
        }
      }

      // Native calls window.__despia.emit(payload). Several SDK copies on one page
      // share the hook, so each registers a sink instead of replacing it.
      function installEmitHook(win) {
        let hook = win[EMIT_HOOK];
        if (!isObject(hook) || typeof hook.emit !== 'function' || !Array.isArray(hook.sinks)) {
          const sinks = [];
          hook = {
            v: PROTOCOL_VERSION,
            sinks,
            emit(payload) {
              const msg = parseMaybeJson(payload);
              if (!isEvent(msg)) return false;
              sinks.slice().forEach((sink) => sink(msg));
              return true;
            }
          };
          win[EMIT_HOOK] = hook;
        }
        hook.sinks.push(deliverEvent);
      }

      function install(sink) {
        eventSink = sink;
        const win = getWindow();
        if (!win) return;
        try {
          installEmitHook(win);
          const bridge = androidBridge(win);
          if (bridge) attachAndroid(bridge);
        } catch (e) {
          console.error('Despia bridge setup failed:', e);
        }
      }

      // Sends one request over the JSON bridge. Resolves with reply.value,
      // rejects with DespiaError. Call only when mode() is 'ios' or 'android'.
      function request(feature, action, args) {
        return new Promise((resolve, reject) => {
          const win = getWindow();
          const id = prefix + '-' + (++seq);
          let json;
          try {
            json = JSON.stringify({ v: PROTOCOL_VERSION, id, feature, action, args });
          } catch (e) {
            reject(new DespiaError(ErrorCodes.INVALID_ARGS, 'Arguments are not JSON-serialisable: ' + e.message));
            return;
          }

          const ios = win && iosHandler(win);
          if (ios) {
            let result;
            try {
              // Send a plain JSON copy so both platforms see identical data.
              result = ios.postMessage(JSON.parse(json));
            } catch (e) {
              reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, 'postMessage failed: ' + (e && e.message)));
              return;
            }
            Promise.resolve(result).then((raw) => {
              const reply = parseMaybeJson(raw);
              if (!isReply(reply) || reply.id !== id) {
                reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, 'Malformed reply from native bridge', raw));
                return;
              }
              settle(reply, resolve, reject);
            }, (e) => {
              // replyHandler(nil, errorMessage) rejects with a plain Error.
              reject(new DespiaError(ErrorCodes.NATIVE_ERROR, (e && e.message) || String(e)));
            });
            return;
          }

          const android = win && androidBridge(win);
          if (android) {
            attachAndroid(android);
            pending.set(id, { resolve, reject });
            try {
              android.postMessage(json);
            } catch (e) {
              pending.delete(id);
              reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, 'postMessage failed: ' + (e && e.message)));
            }
            return;
          }

          reject(new DespiaError(ErrorCodes.BRIDGE_ERROR, 'JSON bridge is not available'));
        });
      }

      return { mode, install, request };
    }

    module.exports = { createTransport, PROTOCOL_VERSION };
  };

  // ---- src/index.js ----
  __modules['./index'] = function (module, exports, require) {
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
  };

  return __require('./index');
}));
