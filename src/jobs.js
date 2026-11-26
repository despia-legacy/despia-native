'use strict';

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
  // `error` is reserved for failures, so it reads as one.
  if (done && typeof done.status === 'string' && done.status !== '') return done.status === 'error' ? 'failed' : done.status;
  if (done && done.ok === true) return 'success';
  const err = done && done.error && typeof done.error === 'object' ? done.error : {};
  return err.code === 'cancelled' || err.code === 'navigated' ? err.code : 'failed';
}

// The terminal packet with its status filled in.
function withStatus(done) {
  if (done && typeof done.status === 'string' && done.status !== '' && done.status !== 'error') return done;
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
