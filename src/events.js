'use strict';

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
