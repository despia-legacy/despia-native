'use strict';

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
