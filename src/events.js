'use strict';

// In-page event hub. The bridge feeds it every packet the page receives;
// the hub puts each job's packets in `seq` order, holds early packets for
// jobs whose start reply has not been processed yet, and fans out to
// broadcast listeners, feature listeners and job listeners.

const REORDER_MS = 50;      // how long a live packet waits for a missing lower seq
const MAX_EARLY = 1000;     // packets held for jobs not yet adopted
const MAX_JOB_STATES = 512; // jobs whose ordering state is kept
const MAX_SEEN = 256;       // jobs one listener remembers a replay mark for

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
