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
