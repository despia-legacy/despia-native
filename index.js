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
    // Typed API built from the catalog:
    //
    //   despia.<feature>.<action>(args?, opts?)              request -> Promise<Result>
    //   despia.<feature>.<action>(args?, callbacks?, opts?)  job     -> Promise<Job>
    //   despia.<feature>.on(event, fn, { since?, jobId? })   -> off
    //   despia.on(fn)                                        every packet -> off
    //   despia.jobs.list / get / cancel, despia.bridge.*, despia.ready()
    //
    // Each action goes over the JSON bridge when this document has one and the
    // app lists the action; otherwise over its legacy scheme when the catalog
    // has one; otherwise it rejects.

    const { DespiaError, ErrorCodes } = require('./errors');
    const { createJob, checkSince } = require('./jobs');
    const { legacyCall } = require('./legacycall');
    const { jsNameOK } = require('./names');

    // Words the SDK keeps for itself on `despia.<word>`.
    const SDK_WORDS = ['legacy', 'on', 'jobs', 'bridge', 'ready'];

    const BRIDGE_ACTIONS = [
      'hello', 'subscribe', 'unsubscribe', 'jobs', 'job', 'cancel', 'ack', 'status', 'assets'
    ];

    function isPlainObject(value) {
      return Object.prototype.toString.call(value) === '[object Object]';
    }

    // Rejects with `aborted` as soon as the signal fires; the legacy call itself
    // cannot be taken back, so its answer is dropped.
    function raceAbort(promise, signal, where) {
      if (!signal) return promise;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new DespiaError(ErrorCodes.ABORTED, where + ' was aborted'));
        signal.addEventListener('abort', onAbort);
        promise.then(
          (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
          (err) => { signal.removeEventListener('abort', onAbort); reject(err); }
        );
      });
    }

    // An outcome action answers { status, ...payload }. A handler that returns
    // plain data has the action's default status added.
    function toOutcome(value, fallback) {
      if (isPlainObject(value)) {
        if (typeof value.status === 'string' && value.status !== '') return value;
        const out = { status: fallback };
        Object.keys(value).forEach((key) => { if (key !== 'status') out[key] = value[key]; });
        return out;
      }
      if (value === undefined || value === null) return { status: fallback };
      return { status: fallback, value };
    }

    function sameJSON(a, b) {
      try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
    }

    // The legacy answer of an outcome action. The catalog's `cancelWhen` names the
    // answer that means "the user cancelled": an error code of the answer
    // envelope, or an exact answer value.
    function legacyOutcome(promise, spec) {
      const fallback = spec.returns.default;
      const cancelWhen = spec.legacy.cancelWhen;
      return promise.then((value) => {
        if (cancelWhen && 'equals' in cancelWhen && sameJSON(value, cancelWhen.equals)) return { status: 'cancelled' };
        return toOutcome(value, fallback);
      }, (err) => {
        if (cancelWhen && typeof cancelWhen.code === 'string' && err instanceof DespiaError && err.code === cancelWhen.code) {
          return { status: 'cancelled' };
        }
        throw err;
      });
    }

    function badArgs(where, message) {
      return Promise.reject(new DespiaError(ErrorCodes.BAD_ARGS, where + ': ' + message));
    }

    function createApi({ catalog, bridge, hub, despiaFunction, observeVariable }) {
      function listed(hello, feature, action) {
        const entry = hello && hello.features && hello.features[feature];
        return !!(entry && Array.isArray(entry.actions) && entry.actions.indexOf(action) !== -1);
      }

      function startJob(state, feature, action, spec, args, callbacks, signal) {
        hub.beginStart();
        // A start reply that comes after the caller gave up (abort or local
        // timeout) would leave a job running that nobody holds: cancel it.
        const late = (reply) => {
          const value = reply && reply.ok === true ? reply.value : null;
          if (value && typeof value.jobId === 'string') bridge.builtin('cancel', { jobId: value.jobId }).then(null, () => {});
        };
        return bridge.request(state, feature, action, args, spec.timeoutMs, signal, late).then((value) => {
          const id = value && typeof value === 'object' ? value.jobId : undefined;
          if (typeof id !== 'string' || id === '') {
            throw new DespiaError(ErrorCodes.INTERNAL, feature + '.' + action + ': reply has no jobId');
          }
          const job = createJob({ hub, bridge, feature, action, id, callbacks });
          hub.adopt(id);
          return job;
        }).then((job) => {
          hub.endStart();
          return job;
        }, (err) => {
          hub.endStart();
          throw err;
        });
      }

      function invoke(feature, action, spec, args, callbacks, signal) {
        const where = feature + '.' + action;
        if (args === undefined || args === null) args = {};
        if (!isPlainObject(args)) return badArgs(where, 'args must be a plain object');
        const isJob = spec.kind === 'job';

        return bridge.detect().then((state) => {
          if (!state.inApp) {
            throw new DespiaError(ErrorCodes.NOT_IN_APP, where + ' is only available inside the Despia app');
          }
          if (listed(state.hello, feature, action)) {
            return isJob
              ? startJob(state, feature, action, spec, args, callbacks, signal)
              : bridge.request(state, feature, action, args, spec.timeoutMs, signal).then((value) =>
                (spec.returns ? toOutcome(value, spec.returns.default) : value));
          }
          if (!isJob && spec.legacy) {
            if (signal && signal.aborted) throw new DespiaError(ErrorCodes.ABORTED, where + ' was aborted');
            const called = legacyCall(despiaFunction, feature, action, spec.legacy, args);
            return raceAbort(spec.returns ? legacyOutcome(called, spec) : called, signal, where);
          }
          throw new DespiaError(
            ErrorCodes.FEATURE_NOT_INSTALLED,
            where + ' is not available in this app build'
          );
        });
      }

      function optionsOf(value) {
        return isPlainObject(value) ? value : {};
      }

      function checkCallbacks(callbacks) {
        if (callbacks === undefined || callbacks === null) return null;
        if (!isPlainObject(callbacks)) return 'callbacks must be an object of functions';
        const bad = Object.keys(callbacks).filter((name) => typeof callbacks[name] !== 'function');
        return bad.length ? 'callback "' + bad[0] + '" is not a function' : null;
      }

      function checkListenOptions(opts) {
        if (opts.since !== undefined) {
          checkSince(opts.since);
          if (opts.since !== 'all' && typeof opts.jobId !== 'string') {
            throw new TypeError("Despia: a numeric since needs the jobId it counts for; use 'all' for every job");
          }
        }
        if (opts.jobId !== undefined && typeof opts.jobId !== 'string') {
          throw new TypeError('Despia: jobId must be a string');
        }
      }

      // Shared by despia.<feature>.on and despia.bridge.on.
      function listen(feature, event, fn, opts) {
        opts = optionsOf(opts);
        checkListenOptions(opts);
        const off = hub.on(feature, event, fn, { jobId: opts.jobId, since: opts.since });
        const release = bridge.track(feature, event);
        if (opts.since !== undefined) {
          let since;
          if (opts.since === 'all') since = opts.jobId ? { [opts.jobId]: 0 } : 'all';
          else since = { [opts.jobId]: opts.since };
          bridge.replay(feature, event, since);
        }
        return function stop() {
          off();
          release();
        };
      }

      function createFeature(feature) {
        const spec = catalog[feature];
        const ns = {};
        Object.keys(spec.actions).forEach((action) => {
          const actionSpec = spec.actions[action];
          // The wire name is `action`; `alias` is its camelCase spelling.
          const names = actionSpec.alias ? [actionSpec.alias, action] : [action];
          const method = actionSpec.kind === 'job'
            ? function (args, callbacks, opts) {
              const problem = checkCallbacks(callbacks);
              if (problem) return badArgs(feature + '.' + action, problem);
              return invoke(feature, action, actionSpec, args, callbacks, optionsOf(opts).signal);
            }
            : function (args, opts) {
              return invoke(feature, action, actionSpec, args, null, optionsOf(opts).signal);
            };
          names.forEach((name) => { ns[name] = method; });
        });
        ns.on = function (event, fn, opts) {
          return listen(feature, event, fn, opts);
        };
        return Object.freeze(ns);
      }

      const features = {};
      Object.keys(catalog).forEach((feature) => {
        if (SDK_WORDS.indexOf(feature) === -1) features[feature] = createFeature(feature);
      });

      // despia.bridge: the built-in actions, plus the bridge's own events.
      const builtins = {};
      BRIDGE_ACTIONS.forEach((action) => {
        builtins[action] = function (args) {
          if (args !== undefined && args !== null && !isPlainObject(args)) {
            return badArgs('bridge.' + action, 'args must be a plain object');
          }
          return bridge.builtin(action, args || {});
        };
      });
      builtins.on = function (event, fn, opts) {
        return listen('bridge', event, fn, opts);
      };

      const jobs = {
        list(filter) {
          return bridge.builtin('jobs', optionsOf(filter)).then((value) =>
            (value && Array.isArray(value.jobs) ? value.jobs : []));
        },
        get(jobId) {
          return bridge.builtin('job', { jobId });
        },
        cancel(jobId) {
          return bridge.builtin('cancel', { jobId });
        }
      };

      const legacy = {
        // despia.legacy.variable(name)            -> window[name] now
        // despia.legacy.variable(name, { wait })  -> resolves when it changes
        variable(name, opts) {
          if (!jsNameOK(name)) throw new TypeError('Despia: "' + String(name) + '" is not a valid window variable name');
          if (opts && opts.wait === true) {
            return new Promise((resolve) => {
              const timeout = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : undefined;
              observeVariable(name, resolve, timeout);
            });
          }
          return typeof window !== 'undefined' ? window[name] : undefined;
        },
        // Same as despia(command, watch).
        call(command, watch) {
          return despiaFunction(command, watch);
        }
      };

      function onAny(fn) {
        const off = hub.onAny(fn);
        const release = bridge.track('*', null);
        return function stop() {
          off();
          release();
        };
      }

      return {
        features,
        words: {
          legacy: Object.freeze(legacy),
          on: onAny,
          jobs: Object.freeze(jobs),
          bridge: Object.freeze(builtins),
          ready: () => bridge.ready()
        },
        jsNameOK
      };
    }

    module.exports = { createApi, SDK_WORDS };
  };

  // ---- src/bridge.js ----
  __modules['./bridge'] = function (module, exports, require) {
    // The page side of the JSON bridge. The app injects one object,
    // window.despiaBridge:
    //
    //   { v: 1, platform, call(feature, action, args?, opts?) -> Promise<Reply>, listen(fn) -> off }
    //
    // call() never rejects; it resolves with a reply envelope. listen() hands
    // over every event packet this document receives. This module is the only
    // place that touches that object.
    //
    // Detection happens once per document: the object must exist with v === 1,
    // and `bridge.hello` must answer ok. Anything else means this document uses
    // the legacy scheme calls only.

    const { DespiaError, ErrorCodes } = require('./errors');

    const DEFAULT_TIMEOUT_MS = 10000; // native's default for a request
    const GUARD_MS = 5000;            // extra wait before the SDK gives up on a lost reply

    function getWindow() {
      return typeof window !== 'undefined' ? window : undefined;
    }

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function readNative(win) {
      try {
        const native = win.despiaBridge;
        if (isObject(native) && native.v === 1 &&
            typeof native.call === 'function' && typeof native.listen === 'function') {
          return native;
        }
      } catch (e) {
        // a hostile getter: treat as absent
      }
      return null;
    }

    function isDespiaRuntime(win) {
      const ua = win.navigator && win.navigator.userAgent;
      return typeof ua === 'string' && ua.toLowerCase().indexOf('despia') !== -1;
    }

    // Turns a reply envelope into its value, or throws the DespiaError it carries.
    function unwrap(reply) {
      if (!isObject(reply) || typeof reply.ok !== 'boolean') {
        throw new DespiaError(ErrorCodes.INTERNAL, 'Malformed reply from the native bridge');
      }
      if (reply.ok) return reply.value;
      const err = isObject(reply.error) ? reply.error : {};
      throw new DespiaError(
        typeof err.code === 'string' && err.code ? err.code : ErrorCodes.INTERNAL,
        typeof err.message === 'string' ? err.message : 'Native call failed',
        typeof err.path === 'string' ? err.path : undefined
      );
    }

    function cleanHello(value) {
      if (!isObject(value) || !isObject(value.features)) return null;
      // Only the documented fields are handed on.
      const hello = {};
      ['v', 'platform', 'features', 'limits', 'contract', 'origin'].forEach((key) => {
        if (value[key] !== undefined) hello[key] = value[key];
      });
      return hello;
    }

    // One native call, guarded: gives up at timeoutMs + 5000 and honours an
    // AbortSignal by rejecting locally (native keeps running; its reply is dropped).
    // `onLate(reply)` hears a reply that arrives after the call already settled
    // (timeout or abort), so the caller can undo what that reply started.
    function guardedCall(native, feature, action, args, timeoutMs, signal, onLate) {
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) {
          reject(new DespiaError(ErrorCodes.ABORTED, feature + '.' + action + ' was aborted'));
          return;
        }
        let timer = null;
        let onAbort = null;
        let settled = false;
        function finish(fn, value) {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          fn(value);
        }
        const limit = (timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs) + GUARD_MS;
        timer = setTimeout(() => {
          timer = null;
          finish(reject, new DespiaError(ErrorCodes.TIMEOUT, feature + '.' + action + ': no reply in ' + limit + ' ms'));
        }, limit);
        if (timer && typeof timer.unref === 'function') timer.unref();
        if (signal) {
          onAbort = () => finish(reject, new DespiaError(ErrorCodes.ABORTED, feature + '.' + action + ' was aborted'));
          signal.addEventListener('abort', onAbort);
        }
        let pending;
        try {
          pending = timeoutMs === undefined
            ? native.call(feature, action, args)
            : native.call(feature, action, args, { timeoutMs });
        } catch (e) {
          finish(reject, new DespiaError(ErrorCodes.INTERNAL, 'Bridge call failed: ' + (e && e.message)));
          return;
        }
        Promise.resolve(pending).then(
          (reply) => {
            if (settled) {
              if (onLate) onLate(reply);
              return;
            }
            finish(resolve, reply);
          },
          (e) => finish(reject, new DespiaError(ErrorCodes.INTERNAL, 'Bridge call failed: ' + (e && e.message)))
        );
      });
    }

    function createBridge(hub) {
      let memo = null;
      const refs = new Map(); // subscription key -> listener count

      function probe(win) {
        const native = readNative(win);
        const inApp = !!native || isDespiaRuntime(win);
        const legacyOnly = { inApp, native, hello: null, refusal: null };
        if (!native) return Promise.resolve(legacyOnly);
        return guardedCall(native, 'bridge', 'hello', {}).then((reply) => {
          let hello = null;
          try {
            hello = cleanHello(unwrap(reply));
            if (!hello) legacyOnly.refusal = new DespiaError(ErrorCodes.INTERNAL, 'bridge.hello: malformed answer');
          } catch (e) {
            legacyOnly.refusal = e; // refused (for example forbidden_origin)
          }
          if (!hello) return legacyOnly;
          try {
            native.listen(hub.intake);
          } catch (e) {
            console.error('Despia bridge listen failed:', e);
          }
          return { inApp: true, native, hello, refusal: null };
        }, (e) => {
          legacyOnly.refusal = e;
          return legacyOnly;
        });
      }

      // Resolves with { inApp, native, hello }; hello is null for legacy-only
      // documents. Settled once per document.
      function detect() {
        const win = getWindow();
        if (!win) return Promise.resolve({ inApp: false, native: null, hello: null });
        if (!memo) memo = probe(win);
        return memo;
      }

      function ready() {
        return detect().then((state) => (state.hello ? { bridge: true, hello: state.hello } : { bridge: false }));
      }

      // One request over the bridge: resolves with the reply value.
      function request(state, feature, action, args, timeoutMs, signal, onLate) {
        return guardedCall(state.native, feature, action, args, timeoutMs, signal, onLate).then(unwrap);
      }

      // A built-in `bridge` action. After the app refused hello the document is
      // legacy-only, so the same refusal comes back without another native call.
      function builtin(action, args, signal) {
        return detect().then((state) => {
          if (state.native && !state.hello && state.refusal) {
            throw new DespiaError(state.refusal.code, state.refusal.message, state.refusal.path);
          }
          if (!state.native) {
            throw new DespiaError(
              state.inApp ? ErrorCodes.FEATURE_NOT_INSTALLED : ErrorCodes.NOT_IN_APP,
              'bridge.' + action + (state.inApp
                ? ': this app build has no JSON bridge'
                : ' is only available inside the Despia app')
            );
          }
          return request(state, 'bridge', action, args || {}, undefined, signal).then((value) => {
            if (action === 'hello') return cleanHello(value) || value;
            return value;
          });
        });
      }

      // Best effort: a failed (un)subscribe never surfaces.
      function send(action, args) {
        detect().then((state) => {
          if (state.hello) return guardedCall(state.native, 'bridge', action, args);
        }).then(null, () => {});
      }

      // Counts listeners per feature/event so native hears one subscribe when
      // the first listener arrives and one unsubscribe when the last one leaves.
      // `feature` may be '*'; `event` may be null for the whole feature.
      function track(feature, event) {
        const key = feature + '\u0000' + (event || '');
        const args = event ? { feature, events: [event] } : { feature };
        const count = (refs.get(key) || 0) + 1;
        refs.set(key, count);
        if (count === 1) send('subscribe', args);
        let released = false;
        return function release() {
          if (released) return;
          released = true;
          const left = refs.get(key) - 1;
          if (left > 0) {
            refs.set(key, left);
          } else {
            refs.delete(key);
            send('unsubscribe', args);
          }
        };
      }

      const MAX_SINCE_KEYS = 64;

      // Asks native to replay stored events: since is { <jobId>: seq }, or 'all'
      // for every job native still stores for the feature (resolved here, because
      // the app only understands a map of jobs).
      function replay(feature, event, since) {
        if (since !== 'all') {
          send('subscribe', { feature, events: [event], since });
          return;
        }
        detect().then((state) => {
          if (!state.hello) return null;
          return request(state, 'bridge', 'jobs', { feature });
        }).then((value) => {
          const ids = value && Array.isArray(value.jobs) ? value.jobs.map((j) => j && j.jobId).filter((id) => typeof id === 'string') : [];
          for (let i = 0; i < ids.length; i += MAX_SINCE_KEYS) {
            const map = {};
            ids.slice(i, i + MAX_SINCE_KEYS).forEach((id) => { map[id] = 0; });
            send('subscribe', { feature, events: [event], since: map });
          }
        }).then(null, () => {});
      }

      return { detect, ready, request, builtin, track, replay };
    }

    module.exports = { createBridge, unwrap, DEFAULT_TIMEOUT_MS, GUARD_MS };
  };

  // ---- src/errors.js ----
  __modules['./errors'] = function (module, exports, require) {
    // Error type for every rejection of the typed `despia.<feature>.<action>()`
    // API. Codes that native sends pass through unchanged; the codes below are
    // the ones the SDK itself produces.

    const ErrorCodes = Object.freeze({
      NOT_IN_APP: 'not_in_app',                       // plain browser: no Despia runtime at all
      ABORTED: 'aborted',                             // the caller's AbortSignal fired
      TIMEOUT: 'timeout',                             // no reply inside timeoutMs + 5000
      FEATURE_NOT_INSTALLED: 'feature_not_installed', // this app build has no bridge route for it
      BAD_ARGS: 'bad_args',                           // args were not a plain object
      INTERNAL: 'internal'                            // malformed reply or transport fault
    });

    class DespiaError extends Error {
      constructor(code, message, path) {
        super(message || String(code));
        this.name = 'DespiaError';
        this.code = String(code);
        if (path !== undefined) this.path = path;
      }
    }

    module.exports = { DespiaError, ErrorCodes };
  };

  // ---- src/events.js ----
  __modules['./events'] = function (module, exports, require) {
    // In-page event hub. The bridge feeds it every packet the page receives;
    // the hub puts each job's packets in `seq` order, holds early packets for
    // jobs whose start reply has not been processed yet, and fans out to
    // broadcast listeners, feature listeners and job listeners.

    const REORDER_MS = 50;      // how long a live packet waits for a missing lower seq
    const MAX_EARLY = 1000;     // packets held for jobs not yet adopted
    const MAX_JOB_STATES = 512; // jobs whose ordering state is kept
    const MAX_SEEN = 256;       // jobs one listener remembers a replay mark for; past that the oldest mark is
                                // forgotten and a later replay of that job reaches the listener again

    function isObject(value) {
      return value !== null && typeof value === 'object';
    }

    function createEventHub() {
      const byKey = new Map();   // "feature\0event" -> Set of listener records
      const broadcast = new Set();
      const states = new Map();  // jobId -> { last, held, timer }
      const early = new Map();   // jobId -> packets that arrived before adopt()
      let earlyCount = 0;
      let starting = 0;

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

      // opts: { jobId, since }. A listener that passes `since` also receives the
      // packets native replays from its durable log (replay: true).
      function on(feature, event, fn, opts) {
        assertListener(fn);
        if (typeof event !== 'string' || event === '') {
          throw new TypeError('Despia: event name must be a non-empty string');
        }
        opts = opts || {};
        const key = feature + '\u0000' + event;
        let set = byKey.get(key);
        if (!set) byKey.set(key, (set = new Set()));
        // `seen` is the highest seq this listener has been given per job, so a
        // packet that native replays more than once reaches it once.
        const record = { fn, jobId: opts.jobId, since: opts.since, seen: new Map() };
        if (typeof opts.since === 'number' && typeof opts.jobId === 'string') record.seen.set(opts.jobId, opts.since);
        return subscribe(set, record, () => {
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

      function admit(record, packet) {
        if (record.jobId !== undefined && packet.jobId !== record.jobId) return false;
        if (packet.replay) {
          if (record.since === undefined) return false;
          if (typeof record.since === 'number' && typeof packet.seq === 'number' && packet.seq <= record.since) {
            return false;
          }
        }
        if (record.since !== undefined && typeof packet.jobId === 'string' && typeof packet.seq === 'number') {
          const mark = record.seen.get(packet.jobId);
          if (mark !== undefined && packet.seq <= mark) return false;
          record.seen.delete(packet.jobId);
          record.seen.set(packet.jobId, packet.seq);
          if (record.seen.size > MAX_SEEN) record.seen.delete(record.seen.keys().next().value);
        }
        return true;
      }

      function dispatch(packet) {
        // Snapshots, so listeners may unsubscribe while being called.
        if (broadcast.size) Array.from(broadcast).forEach((record) => call(record.fn, packet));
        const set = byKey.get(packet.feature + '\u0000' + packet.event);
        if (set) {
          Array.from(set).forEach((record) => {
            if (admit(record, packet)) call(record.fn, packet.data);
          });
        }
      }

      function stateOf(jobId) {
        let state = states.get(jobId);
        if (state) {
          states.delete(jobId); // refresh recency
        } else {
          state = { last: undefined, held: new Map(), timer: null, adopted: false };
          if (states.size >= MAX_JOB_STATES) {
            const oldest = states.keys().next().value;
            const dropped = states.get(oldest);
            states.delete(oldest);
            if (dropped.timer) clearTimeout(dropped.timer);
            flushHeld(dropped); // never discard what was waiting for a gap
          }
        }
        states.set(jobId, state);
        return state;
      }

      function deliver(state, packet) {
        state.last = packet.seq;
        dispatch(packet);
      }

      function drain(state) {
        while (state.held.has(state.last + 1)) {
          const next = state.held.get(state.last + 1);
          state.held.delete(next.seq);
          deliver(state, next);
        }
        if (state.held.size === 0 && state.timer) {
          clearTimeout(state.timer);
          state.timer = null;
        }
      }

      function flushHeld(state) {
        state.timer = null;
        const packets = Array.from(state.held.values()).sort((a, b) => a.seq - b.seq);
        state.held.clear();
        packets.forEach((packet) => {
          if (packet.seq > state.last) deliver(state, packet);
        });
      }

      function sequence(jobId, packet) {
        // Replays come from the durable log already in order, and may skip
        // numbers by design (only the latest progress is kept).
        if (packet.replay || typeof packet.seq !== 'number') {
          dispatch(packet);
          return;
        }
        const state = stateOf(jobId);
        if (state.last !== undefined && packet.seq <= state.last) return; // already delivered
        if (state.last === undefined || packet.seq === state.last + 1) {
          deliver(state, packet);
          drain(state);
          return;
        }
        state.held.set(packet.seq, packet);
        if (!state.timer) {
          state.timer = setTimeout(() => flushHeld(state), REORDER_MS);
          if (state.timer && typeof state.timer.unref === 'function') state.timer.unref();
        }
      }

      function hold(jobId, packet) {
        let list = early.get(jobId);
        if (!list) early.set(jobId, (list = []));
        if (earlyCount >= MAX_EARLY && packet.event !== 'done') return; // a terminal event is never dropped
        list.push(packet);
        earlyCount++;
      }

      function release(jobId) {
        const list = early.get(jobId) || [];
        early.delete(jobId);
        earlyCount -= list.length;
        list.sort((a, b) => (a.seq || 0) - (b.seq || 0)).forEach((packet) => sequence(jobId, packet));
      }

      // Called with every packet native delivers.
      function intake(raw) {
        if (!isObject(raw) || typeof raw.feature !== 'string' || typeof raw.event !== 'string') return;
        const packet = isObject(raw.data) ? raw : Object.assign({}, raw, { data: {} });
        const jobId = typeof packet.jobId === 'string' ? packet.jobId : undefined;
        if (jobId === undefined) {
          dispatch(packet);
          return;
        }
        const state = states.get(jobId);
        if (starting > 0 && !(state && state.adopted)) {
          hold(jobId, packet);
          return;
        }
        sequence(jobId, packet);
      }

      // A job-start request is in flight: packets for jobs nobody owns yet are
      // held, because the reply that names the job may be processed after them.
      function beginStart() {
        starting++;
      }

      // The start reply named `jobId` and its listeners are attached.
      function adopt(jobId) {
        const state = stateOf(jobId);
        state.adopted = true;
        state.last = 0;
        release(jobId);
      }

      function endStart() {
        starting = Math.max(0, starting - 1);
        if (starting > 0) return;
        // Whatever nobody claimed is ordinary traffic: deliver it.
        Array.from(early.keys()).forEach(release);
      }

      // Number of registered listeners (broadcast and per event).
      function count() {
        let total = broadcast.size;
        byKey.forEach((set) => { total += set.size; });
        return total;
      }

      return { on, onAny, intake, beginStart, adopt, endStart, count };
    }

    module.exports = { createEventHub };
  };

  // ---- src/features.js ----
  __modules['./features'] = function (module, exports, require) {
    // Runtime feature table. Generated by scripts/generate-features.js from
    // bridge-catalog.json. Do not edit; see features.d.ts for the types.

    module.exports = {
      "haptics": {
        "actions": {
          "light": {
            "kind": "request",
            "legacy": {
              "scheme": "lighthaptic",
              "args": [],
              "answer": "none"
            }
          },
          "heavy": {
            "kind": "request",
            "legacy": {
              "scheme": "heavyhaptic",
              "args": [],
              "answer": "none"
            }
          },
          "success": {
            "kind": "request",
            "legacy": {
              "scheme": "successhaptic",
              "args": [],
              "answer": "none"
            }
          },
          "warning": {
            "kind": "request",
            "legacy": {
              "scheme": "warninghaptic",
              "args": [],
              "answer": "none"
            }
          },
          "error": {
            "kind": "request",
            "legacy": {
              "scheme": "errorhaptic",
              "args": [],
              "answer": "none"
            }
          }
        },
        "events": []
      },
      "vault": {
        "actions": {
          "set": {
            "kind": "request",
            "legacy": {
              "scheme": "setvault",
              "args": [
                {
                  "arg": "key",
                  "name": "key",
                  "encoding": "plain"
                },
                {
                  "arg": "value",
                  "name": "value",
                  "encoding": "plain"
                },
                {
                  "arg": "locked",
                  "name": "locked",
                  "encoding": "plain"
                }
              ],
              "answer": "none"
            }
          },
          "get": {
            "kind": "request",
            "legacy": {
              "scheme": "readvault",
              "args": [
                {
                  "arg": "key",
                  "name": "key",
                  "encoding": "plain"
                }
              ],
              "variable": "{key}",
              "answer": "variable"
            }
          }
        },
        "events": []
      },
      "device": {
        "actions": {
          "app_version": {
            "kind": "request",
            "alias": "appVersion",
            "legacy": {
              "scheme": "getappversion",
              "args": [],
              "variable": [
                "versionNumber",
                "bundleNumber"
              ],
              "answer": "variable"
            }
          },
          "uuid": {
            "kind": "request",
            "legacy": {
              "scheme": "get-uuid",
              "args": [],
              "variable": "uuid",
              "answer": "variable"
            }
          },
          "store_location": {
            "kind": "request",
            "alias": "storeLocation",
            "legacy": {
              "scheme": "getstorelocation",
              "args": [],
              "variable": "storeLocation",
              "answer": "variable"
            }
          }
        },
        "events": []
      },
      "revenuecat": {
        "actions": {
          "purchase": {
            "kind": "request",
            "legacy": {
              "scheme": "revenuecat",
              "host": "purchase",
              "args": [
                {
                  "arg": "externalId",
                  "name": "external_id",
                  "encoding": "plain"
                },
                {
                  "arg": "product",
                  "name": "product",
                  "encoding": "plain"
                }
              ],
              "answer": "none"
            }
          },
          "paywall": {
            "kind": "request",
            "legacy": {
              "scheme": "revenuecat",
              "host": "launchPaywall",
              "args": [
                {
                  "arg": "externalId",
                  "name": "external_id",
                  "encoding": "plain"
                },
                {
                  "arg": "offering",
                  "name": "offering",
                  "encoding": "plain"
                }
              ],
              "answer": "none"
            }
          },
          "history": {
            "kind": "request",
            "legacy": {
              "scheme": "getpurchasehistory",
              "args": [],
              "variable": "restoredData",
              "answer": "variable"
            }
          }
        },
        "events": [
          "purchase"
        ]
      },
      "gps": {
        "actions": {
          "start": {
            "kind": "request",
            "legacy": {
              "scheme": "location",
              "args": [
                {
                  "arg": "buffer",
                  "name": "buffer",
                  "encoding": "plain"
                },
                {
                  "arg": "movement",
                  "name": "movement",
                  "encoding": "plain"
                },
                {
                  "arg": "server",
                  "name": "server",
                  "encoding": "plain"
                }
              ],
              "answer": "none"
            }
          },
          "stop": {
            "kind": "request",
            "legacy": {
              "scheme": "stoplocation",
              "args": [],
              "variable": "locationSession",
              "answer": "variable"
            }
          }
        },
        "events": [
          "change"
        ]
      }
    };
  };

  // ---- src/jobs.js ----
  __modules['./jobs'] = function (module, exports, require) {
    // A Job is the handle for one long-running action. Native answers the start
    // request with { jobId }; everything after that arrives as events carrying
    // that jobId.

    const { DespiaError, ErrorCodes } = require('./errors');

    function checkSince(since) {
      if (since === 'all' || (Number.isInteger(since) && since >= 0)) return;
      throw new TypeError("Despia: since must be a non-negative integer or 'all'");
    }

    function errorFrom(done) {
      const err = done && done.error && typeof done.error === 'object' ? done.error : {};
      return new DespiaError(
        typeof err.code === 'string' && err.code ? err.code : ErrorCodes.INTERNAL,
        typeof err.message === 'string' ? err.message : 'Job failed',
        typeof err.path === 'string' ? err.path : undefined
      );
    }

    // The status of a terminal packet. A v1 handler sends none: ok means
    // success, a cancel or navigation error code names itself, anything else failed.
    function statusOf(done) {
      if (done && typeof done.status === 'string' && done.status !== '') return done.status;
      if (done && done.ok === true) return 'success';
      const err = done && done.error && typeof done.error === 'object' ? done.error : {};
      return err.code === 'cancelled' || err.code === 'navigated' ? err.code : 'failed';
    }

    // The terminal packet with its status filled in.
    function withStatus(done) {
      if (done && typeof done.status === 'string' && done.status !== '') return done;
      return Object.assign({}, done, { status: statusOf(done) });
    }

    // What the job resolves with: { status, ...payload }, without the packet's
    // own bookkeeping.
    function outcomeOf(done) {
      const out = { status: statusOf(done) };
      Object.keys(done || {}).forEach((key) => {
        if (key !== 'jobId' && key !== 'ok' && key !== 'error' && key !== 'status') out[key] = done[key];
      });
      return out;
    }

    function createJob({ hub, bridge, feature, action, id, callbacks }) {
      let finished = null;
      const waiters = [];
      const own = []; // the listeners this job registered itself: its tracker and start callbacks

      // Tracks the terminal event. Replayed copies count too. Once the job has
      // ended nothing more can reach its own listeners, so they are removed (the
      // dispatch in progress still completes for the ones already due).
      own.push(hub.on(feature, 'done', (done) => {
        if (finished) return;
        finished = done;
        waiters.splice(0).forEach((settle) => settle(done));
        own.splice(0).forEach((off) => off());
      }, { jobId: id, since: 'all' }));

      function on(event, fn, opts) {
        if (typeof event !== 'string' || event === '') {
          throw new TypeError('Despia: event name must be a non-empty string');
        }
        if (typeof fn !== 'function') throw new TypeError('Despia: listener must be a function');
        opts = opts || {};
        let handler = fn;
        let name = event;
        if (event === 'error') {
          // Sugar: `error` is a `done` that did not succeed.
          name = 'done';
          handler = (done) => {
            if (statusOf(done) !== 'failed') return;
            const err = done && done.error && typeof done.error === 'object' ? done.error : {};
            fn(Object.assign({ code: ErrorCodes.INTERNAL, message: 'Job failed' }, err, { jobId: id }));
          };
        }
        if (event === 'done') handler = (done) => fn(withStatus(done));
        if (opts.since !== undefined) {
          checkSince(opts.since);
          bridge.replay(feature, name, { [id]: opts.since === 'all' ? 0 : opts.since });
        }
        return hub.on(feature, name, handler, { jobId: id, since: opts.since });
      }

      // `await job.result` and `await job.result()` both work: result is a
      // function that is also a thenable, and both share one promise.
      let settled = null;
      function outcome() {
        if (!settled) {
          settled = new Promise((resolve, reject) => {
            const settle = (done) => (statusOf(done) === 'failed' ? reject(errorFrom(done)) : resolve(outcomeOf(done)));
            if (finished) settle(finished);
            else waiters.push(settle);
          });
        }
        return settled;
      }
      const result = function result() { return outcome(); };
      result.then = (onOk, onErr) => outcome().then(onOk, onErr);
      result.catch = (onErr) => outcome().catch(onErr);
      result.finally = (onDone) => outcome().finally(onDone);

      function cancel() {
        return bridge.builtin('cancel', { jobId: id });
      }

      function ack(seq) {
        if (!Number.isInteger(seq) || seq < 0) {
          return Promise.reject(new DespiaError(ErrorCodes.BAD_ARGS, 'ack: seq must be a non-negative integer'));
        }
        return bridge.builtin('ack', { jobId: id, seq }).then(() => undefined);
      }

      const job = Object.freeze({ id, feature, action, on, result, cancel, ack });
      Object.keys(callbacks || {}).forEach((event) => own.push(on(event, callbacks[event])));
      return job;
    }

    module.exports = { createJob, checkSince };
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

    module.exports = { despiaFunction, observeDespiaVariable };
  };

  // ---- src/legacycall.js ----
  __modules['./legacycall'] = function (module, exports, require) {
    // Fallback for a document without the JSON bridge: the typed call becomes
    // the scheme URL the SDK has always sent, `despia(command, watch)`.
    //
    // Catalog mapping of one action:
    //   legacy: {
    //     scheme, host?, route?,              // scheme://host/route
    //     args: [{ arg, name, encoding }],    // query parameters, in order
    //     variable?,                          // window variable(s) the app answers in
    //     answer: 'none' | 'variable' | 'envelope'
    //   }
    // `variable` may be a name, a list of names, and may hold {argName} templates.

    const { DespiaError, ErrorCodes } = require('./errors');
    const { jsNameOK } = require('./names');

    function fillTemplate(template, args) {
      return template.replace(/\{([^}]+)\}/g, (_, name) => String(args[name]));
    }

    function buildCommand(legacy, args) {
      let command = legacy.scheme + '://' + (legacy.host || '') + (legacy.route ? '/' + legacy.route : '');
      const parts = [];
      (legacy.args || []).forEach((entry) => {
        const value = args[entry.arg];
        if (value === undefined || value === null) return;
        const text = entry.encoding === 'json' ? JSON.stringify(value) : String(value);
        parts.push(entry.name + '=' + encodeURIComponent(text));
      });
      if (parts.length) command += '?' + parts.join('&');
      return command;
    }

    // Names that exist on window when the SDK loads: the browser's own, from the
    // window object and its prototype chain.
    const BUILTIN = (() => {
      const names = new Set();
      if (typeof window === 'undefined' || window === null) return names;
      try {
        for (let o = window; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
        }
      } catch (e) { /* keep what was read */ }
      return names;
    })();

    function freeToClear(name) {
      if (typeof window === 'undefined' || window === null) return true;
      try {
        if (BUILTIN.has(name)) return false;
        if (!(name in window)) return true;
        const d = Object.getOwnPropertyDescriptor(window, name);
        if (!d || !d.configurable || !d.writable || !('value' in d)) return false;
        const type = typeof d.value;
        return d.value === undefined || (d.value !== null && type !== 'object' && type !== 'function');
      } catch (e) {
        return false;
      }
    }

    // The window variables to watch, with names filled in from args. Every name
    // must be one the legacy channel may delete and wait on; an arg that would
    // turn into a browser global is refused before anything is sent.
    function watchList(feature, action, legacy, args) {
      return [].concat(legacy.variable || []).map((template) => {
        const name = fillTemplate(template, args);
        const arg = (/\{([^}]+)\}/.exec(template) || [])[1];
        const refuse = (why) => new DespiaError(
          ErrorCodes.BAD_ARGS,
          feature + '.' + action + ': "' + name + '" ' + why,
          arg ? 'args.' + arg : undefined
        );
        if (!jsNameOK(name)) throw refuse('cannot be used as a window variable name');
        // A name built from an argument is deleted before the app answers, so it
        // may only be one that is free, or one an earlier answer left as a plain
        // value. Browser properties, getters and anything holding an object or
        // function are refused.
        if (arg !== undefined && name !== template && !freeToClear(name)) throw refuse('is already in use on this page');
        return name;
      });
    }

    // The app's answer envelope: { ok: true, data } on success; on failure
    // { ok: false, error: '<message>', code: '<code>' }. An object-shaped
    // `error: { code, message }` is accepted too.
    function unwrapEnvelope(value) {
      if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') return value;
      if (value.ok) return value.data;
      const err = value.error;
      const detail = err !== null && typeof err === 'object' ? err : {};
      const code = typeof value.code === 'string' && value.code ? value.code
        : typeof detail.code === 'string' && detail.code ? detail.code : ErrorCodes.INTERNAL;
      const message = typeof err === 'string' && err ? err
        : typeof detail.message === 'string' && detail.message ? detail.message : 'Native call failed';
      throw new DespiaError(code, message);
    }

    function legacyCall(despiaFunction, feature, action, legacy, args) {
      const watch = legacy.answer === 'none' ? [] : watchList(feature, action, legacy, args);
      const command = buildCommand(legacy, args);
      if (watch.length === 0) return despiaFunction(command).then(() => undefined);

      return despiaFunction(command, watch).then((values) => {
        values = values || {};
        const missing = watch.filter((name) => values[name] === undefined);
        if (missing.length) {
          throw new DespiaError(
            ErrorCodes.TIMEOUT,
            feature + '.' + action + ': no reply in ' + missing.join(', ')
          );
        }
        const value = Array.isArray(legacy.variable) ? values : values[watch[0]];
        return legacy.answer === 'envelope' ? unwrapEnvelope(value) : value;
      });
    }

    module.exports = { legacyCall, buildCommand };
  };

  // ---- src/names.js ----
  __modules['./names'] = function (module, exports, require) {
    // Window variable names the SDK will read, wait on, or hand to the legacy
    // channel as a variable to watch. The legacy channel deletes the variable
    // before it waits for the app to write it, so a name that is a browser
    // global or one the runtime itself uses must never get that far.

    const RESERVED = [
      // the runtime's own
      'despia', '_despia', 'despiaBridge',
      // object model
      '__proto__', 'constructor', 'prototype', 'Object', 'Function', 'Array', 'String', 'Number', 'Boolean',
      'Symbol', 'BigInt', 'Promise', 'Proxy', 'Reflect', 'JSON', 'Math', 'Date', 'RegExp', 'Error', 'Map',
      'Set', 'WeakMap', 'WeakSet', 'eval', 'globalThis', 'undefined', 'NaN', 'Infinity',
      // window and its relatives
      'window', 'self', 'top', 'parent', 'frames', 'opener', 'closed', 'length', 'name', 'status', 'origin',
      'document', 'location', 'history', 'navigator', 'screen', 'external', 'event', 'visualViewport',
      // network, storage, timers, workers
      'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'Request', 'Response',
      'Headers', 'URL', 'Blob', 'File', 'FormData', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
      'cookieStore', 'crypto', 'performance', 'console', 'setTimeout', 'setInterval', 'clearTimeout',
      'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'postMessage', 'addEventListener',
      'removeEventListener', 'dispatchEvent', 'alert', 'confirm', 'prompt', 'open', 'close', 'atob', 'btoa',
      'queueMicrotask', 'structuredClone', 'WebAssembly', 'webkit', 'chrome', 'Android', 'AndroidBridge',
      // objects the apps put on the page themselves (the names they register as script interfaces)
      'virtual', 'AndroidVirtual', 'nativeext', 'blob', 'DespiaSecure', 'DespiaNavigation', 'DespiaVisionBridge',
      'DespiaWSAck', 'AndroidRefresh', 'AndroidClerk', 'NativeSpeechRecognition', '__despiaBridgeDeliver',
      'DespiaKeyboard', 'DespiaViewportTheme', 'DespiaPasskeyBridge', 'DespiaPasskeys', 'DespiaShortcuts',
      'Despia', 'AndroidKeyStore',
      // handler slots the apps' lists name (others are caught by the value check at call time)
      'onerror', 'onmessage', 'onload', 'onunload', 'onbeforeunload', 'onpopstate', 'onhashchange',
      // Object.prototype members: replacing one changes every object on the page
      'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
      'toJSON', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
    ];

    function jsNameOK(name) {
      return typeof name === 'string' &&
        /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) &&
        name.indexOf('__') !== 0 &&
        RESERVED.indexOf(name) === -1;
    }

    module.exports = { jsNameOK, RESERVED };
  };

  // ---- src/index.js ----
  __modules['./index'] = function (module, exports, require) {
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
  };

  return __require('./index');
}));
