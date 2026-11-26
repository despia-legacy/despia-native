'use strict';

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
