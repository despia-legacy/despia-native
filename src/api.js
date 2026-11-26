'use strict';

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

// Words the SDK keeps for itself on `despia.<word>`.
const SDK_WORDS = ['legacy', 'on', 'jobs', 'bridge', 'ready'];

const BRIDGE_ACTIONS = [
  'hello', 'subscribe', 'unsubscribe', 'jobs', 'job', 'cancel', 'ack', 'status', 'assets'
];

const RESERVED_JS_NAMES = [
  'despia', '_despia', 'despiaBridge', '__despiaBridgeDeliver', '__proto__', 'constructor', 'prototype'
];

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

// A name the app may read from window: a plain identifier, not one the
// runtime reserves.
function jsNameOK(name) {
  return typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) &&
    RESERVED_JS_NAMES.indexOf(name) === -1;
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
    return bridge.request(state, feature, action, args, spec.timeoutMs, signal).then((value) => {
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
          : bridge.request(state, feature, action, args, spec.timeoutMs, signal);
      }
      if (!isJob && spec.legacy) return legacyCall(despiaFunction, feature, action, spec.legacy, args);
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
      if (actionSpec.kind === 'job') {
        ns[action] = function (args, callbacks, opts) {
          const problem = checkCallbacks(callbacks);
          if (problem) return badArgs(feature + '.' + action, problem);
          return invoke(feature, action, actionSpec, args, callbacks, optionsOf(opts).signal);
        };
      } else {
        ns[action] = function (args, opts) {
          return invoke(feature, action, actionSpec, args, null, optionsOf(opts).signal);
        };
      }
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
