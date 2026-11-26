'use strict';

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
  // objects the apps put on the page themselves
  'virtual', 'AndroidVirtual', 'nativeext', 'blob', 'DespiaSecure', 'DespiaNavigation', 'DespiaVisionBridge',
  'DespiaWSAck', 'AndroidRefresh', 'AndroidClerk', 'NativeSpeechRecognition', '__despiaBridgeDeliver',
  // Object.prototype members: replacing one changes every object on the page
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  'toJSON', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'
];

function jsNameOK(name) {
  return typeof name === 'string' &&
    /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) &&
    name.indexOf('__') !== 0 &&
    // on<event> names are the page's own handler slots
    !/^on[a-z]/.test(name) &&
    RESERVED.indexOf(name) === -1;
}

module.exports = { jsNameOK, RESERVED };
