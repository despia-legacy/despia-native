'use strict';

// Job actions: start, progress, done, ordering, early events, replay,
// cancel, ack.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, outcome, ok, fail, DESPIA_UA } = require('./helpers');

const INPUT = { url: 'https://files.invalid/a', name: 'a.mov', type: 'video/quicktime', size: 10 };

// An app whose ffmpeg.run answers { jobId } and lets the test drive the events.
function app(extra = {}, handler) {
  return loadSdk(Object.assign({
    fixture: true,
    userAgent: DESPIA_UA,
    bridge: (call, env) => {
      if (handler) {
        const reply = handler(call, env);
        if (reply !== undefined) return reply;
      }
      if (call.feature === 'ffmpeg' && call.action === 'run') return ok({ jobId: 'j-1' });
      if (call.feature === 'bridge') {
        if (call.action === 'cancel') return ok({ cancelled: true, state: 'cancelled' });
        if (call.action === 'ack' || call.action === 'unsubscribe') return ok({});
        if (call.action === 'subscribe') return ok({ subscribed: true });
      }
    }
  }, extra));
}

const ev = (event, seq, data, extra) => Object.assign({
  feature: 'ffmpeg', event, jobId: 'j-1', seq, data: Object.assign({ jobId: 'j-1' }, data)
}, extra);

const sent = (env, action) => env.calls.filter((c) => c.feature === 'bridge' && c.action === action);

test('job: start answers { jobId } and events arrive on the callbacks', async () => {
  const env = app();
  const progress = [];
  const logs = [];
  const done = [];
  const job = await env.despia.ffmpeg.run({ input: INPUT }, {
    progress: (d) => progress.push(d.percent),
    log: (d) => logs.push(d.line),
    done: (d) => done.push(d.ok)
  });
  assert.equal(job.id, 'j-1');
  assert.equal(job.feature, 'ffmpeg');
  assert.equal(job.action, 'run');
  assert.deepStrictEqual(env.calls.find((c) => c.feature === 'ffmpeg').args, { input: INPUT });

  env.emit(ev('progress', 1, { percent: 10 }));
  env.emit(ev('log', 2, { level: 'info', line: 'frame=1' }));
  env.emit(ev('progress', 3, { percent: 55 }));
  env.emit(ev('done', 4, { ok: true, outputs: [] }));
  assert.deepStrictEqual(progress, [10, 55]);
  assert.deepStrictEqual(logs, ['frame=1']);
  assert.deepStrictEqual(done, [true]);
});

test('job: result() resolves with the terminal event when it succeeds', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  const result = outcome(job.result());
  env.emit(ev('done', 1, { ok: true, outputs: [{ url: 'u', name: 'o.mp4', type: 'video/mp4', size: 3 }] }));
  await result.done;
  assert.equal(result.value.ok, true);
  assert.equal(result.value.outputs[0].name, 'o.mp4');
  // Asking again after the end gives the same answer.
  assert.equal((await job.result()).jobId, 'j-1');
});

test('job: result() rejects with DespiaError when done.ok is false; error callback is sugar for it', async () => {
  const env = app();
  const errors = [];
  const dones = [];
  const job = await env.despia.ffmpeg.run({ input: INPUT }, {
    error: (e) => errors.push(e),
    done: (d) => dones.push(d.ok)
  });
  env.emit(ev('done', 1, { ok: false, error: { code: 'handler_error', message: 'ffmpeg exited 1' } }));
  await assert.rejects(job.result(), (err) => {
    assert.ok(err instanceof env.despia.DespiaError);
    assert.equal(err.code, 'handler_error');
    assert.equal(err.message, 'ffmpeg exited 1');
    return true;
  });
  assert.deepStrictEqual(plain(errors), [{ code: 'handler_error', message: 'ffmpeg exited 1', jobId: 'j-1' }]);
  assert.deepStrictEqual(dones, [false]);
});

test('job: error callback is not called for a successful done', async () => {
  const env = app();
  await env.despia.ffmpeg.run({ input: INPUT }, { error: () => assert.fail('called') });
  env.emit(ev('done', 1, { ok: true }));
});

test('job: result() is not an unhandled rejection when nobody asks for it', async () => {
  const env = app();
  await env.despia.ffmpeg.run({ input: INPUT });
  env.emit(ev('done', 1, { ok: false, error: { code: 'cancelled', message: 'cancelled' } }));
  await env.clock.tick(10);
});

test('job: a start that fails rejects like a request and creates no job', async () => {
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? fail('busy', 'too many jobs') : undefined));
  await assert.rejects(env.despia.ffmpeg.run({ input: INPUT }), { code: 'busy' });
});

test('job: a reply without a jobId is an internal error', async () => {
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? ok({}) : undefined));
  await assert.rejects(env.despia.ffmpeg.run({ input: INPUT }), { code: 'internal' });
});

test('job: callbacks must be functions', async () => {
  const env = app();
  await assert.rejects(env.despia.ffmpeg.run({ input: INPUT }, { progress: 5 }), { code: 'bad_args' });
  await assert.rejects(env.despia.ffmpeg.run({ input: INPUT }, 'x'), { code: 'bad_args' });
  assert.equal(env.calls.filter((c) => c.feature === 'ffmpeg').length, 0);
});

test('job: events are matched by jobId; other jobs do not leak in', async () => {
  const env = app();
  const seen = [];
  const job = await env.despia.ffmpeg.run({ input: INPUT }, { progress: (d) => seen.push(d.percent) });
  env.emit(ev('progress', 1, { percent: 1 }));
  env.emit(Object.assign(ev('progress', 1, { percent: 99 }), { jobId: 'j-2', data: { jobId: 'j-2', percent: 99 } }));
  assert.deepStrictEqual(seen, [1]);
  assert.equal(job.id, 'j-1');
});

// ---- early events -------------------------------------------------------------

test('early events: packets that beat the start reply are held and delivered in seq order', async () => {
  let reply;
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? new Promise((r) => { reply = r; }) : undefined));
  const seen = [];
  const started = env.despia.ffmpeg.run({ input: INPUT }, {
    progress: (d) => seen.push('p' + d.percent),
    done: () => seen.push('done')
  });
  await env.clock.tick(0);
  // Native violated the order promise: events first, out of order, then the reply.
  env.emit(ev('done', 3, { ok: true }));
  env.emit(ev('progress', 2, { percent: 50 }));
  env.emit(ev('progress', 1, { percent: 10 }));
  assert.deepStrictEqual(seen, [], 'nothing delivered before the job is known');
  reply(ok({ jobId: 'j-1' }));
  const job = await started;
  assert.deepStrictEqual(seen, ['p10', 'p50', 'done']);
  assert.equal((await job.result()).ok, true);
});

test('early events: a job of another document is delivered once the start settles, not lost', async () => {
  let reply;
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? new Promise((r) => { reply = r; }) : undefined));
  const heard = [];
  env.despia.on((p) => heard.push(p.jobId + ':' + p.seq));
  const started = env.despia.ffmpeg.run({ input: INPUT });
  await env.clock.tick(0);
  env.emit(Object.assign(ev('progress', 7, { percent: 1 }), { jobId: 'j-other' }));
  assert.deepStrictEqual(heard, []);
  reply(ok({ jobId: 'j-1' }));
  await started;
  assert.deepStrictEqual(heard, ['j-other:7']);
});

test('early events: a failed start releases whatever was held', async () => {
  let reply;
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? new Promise((r) => { reply = r; }) : undefined));
  const heard = [];
  env.despia.on((p) => heard.push(p.event));
  const started = outcome(env.despia.ffmpeg.run({ input: INPUT }));
  await env.clock.tick(0);
  env.emit(ev('log', 1, { level: 'info', line: 'x' }, { jobId: 'j-9' }));
  reply(fail('busy', 'no'));
  await started.done;
  assert.equal(started.error.code, 'busy');
  assert.deepStrictEqual(heard, ['log']);
});

// ---- ordering ---------------------------------------------------------------

test('ordering: out-of-order live packets are delivered in seq order', async () => {
  const env = app();
  const seen = [];
  await env.despia.ffmpeg.run({ input: INPUT }, { progress: (d) => seen.push(d.percent) });
  env.emit(ev('progress', 1, { percent: 1 }));
  env.emit(ev('progress', 3, { percent: 3 }));
  assert.deepStrictEqual(seen, [1], 'seq 3 waits for seq 2');
  env.emit(ev('progress', 2, { percent: 2 }));
  assert.deepStrictEqual(seen, [1, 2, 3]);
});

test('ordering: a gap that never fills is released after a short wait', async () => {
  const env = app();
  const seen = [];
  await env.despia.ffmpeg.run({ input: INPUT }, { progress: (d) => seen.push(d.percent) });
  env.emit(ev('progress', 1, { percent: 1 }));
  env.emit(ev('progress', 4, { percent: 4 }));
  env.emit(ev('progress', 3, { percent: 3 }));
  assert.deepStrictEqual(seen, [1]);
  await env.clock.tick(60);
  assert.deepStrictEqual(seen, [1, 3, 4]);
  env.emit(ev('progress', 5, { percent: 5 }));
  assert.deepStrictEqual(seen, [1, 3, 4, 5]);
  assert.equal(env.clock.pending(), 0);
});

test('ordering: a duplicate or stale seq is dropped', async () => {
  const env = app();
  const seen = [];
  await env.despia.ffmpeg.run({ input: INPUT }, { progress: (d) => seen.push(d.percent) });
  env.emit(ev('progress', 1, { percent: 1 }));
  env.emit(ev('progress', 2, { percent: 2 }));
  env.emit(ev('progress', 2, { percent: 2 }));
  env.emit(ev('progress', 1, { percent: 1 }));
  assert.deepStrictEqual(seen, [1, 2]);
});

test('ordering: each job has its own sequence', async () => {
  const env = app();
  const seen = [];
  await despiaListen(env, seen);
  env.emit(ev('progress', 1, { percent: 1 }, { jobId: 'j-a' }));
  env.emit(ev('progress', 1, { percent: 1 }, { jobId: 'j-b' }));
  env.emit(ev('progress', 2, { percent: 2 }, { jobId: 'j-a' }));
  assert.deepStrictEqual(seen, ['j-a:1', 'j-b:1', 'j-a:2']);
});

function despiaListen(env, seen) {
  env.despia.on((p) => seen.push(p.jobId + ':' + p.seq));
  return env.despia.ready(); // makes the bridge listen
}

test('ordering: events without a jobId are delivered as they come', async () => {
  const env = app();
  const seen = [];
  env.despia.on((p) => seen.push(p.event));
  await env.despia.ready();
  env.emit({ feature: 'bridge', event: 'dropped', data: { count: 3 } });
  env.emit({ feature: 'bridge', event: 'dropped', data: { count: 4 } });
  assert.deepStrictEqual(seen, ['dropped', 'dropped']);
});

// ---- replay -----------------------------------------------------------------

test('replay: a since listener gets stored events marked replay, then live ones', async () => {
  const env = app({}, (call) => {
    if (call.feature === 'bridge' && call.action === 'subscribe' && call.args.since) {
      // Native answers the subscribe by replaying what the page missed.
      return ok({ subscribed: true });
    }
  });
  const got = [];
  await env.despia.ready();
  const off = env.despia.ffmpeg.on('progress', (d) => got.push(d.percent), { jobId: 'j-1', since: 2 });
  await env.clock.tick(0);

  const sub = env.calls.filter((c) => c.action === 'subscribe');
  assert.deepStrictEqual(sub.map((c) => c.args), [
    { feature: 'ffmpeg', events: ['progress'] },
    { feature: 'ffmpeg', events: ['progress'], since: { 'j-1': 2 } }
  ]);

  env.emit(ev('progress', 3, { percent: 30 }, { replay: true }));
  env.emit(ev('progress', 4, { percent: 40 }, { replay: true }));
  env.emit(ev('progress', 5, { percent: 50 }));
  assert.deepStrictEqual(got, [30, 40, 50]);

  // A replayed packet at or below since is not for this listener.
  env.emit(ev('progress', 2, { percent: 20 }, { replay: true }));
  assert.deepStrictEqual(got, [30, 40, 50]);
  off();
});

test('replay: listeners that did not ask for it never see replayed packets; broadcast hears all', async () => {
  const env = app();
  const plainListener = [];
  const everything = [];
  env.despia.ffmpeg.on('progress', (d) => plainListener.push(d.percent));
  env.despia.on((p) => everything.push(p.replay === true ? 'replay' : 'live'));
  await env.clock.tick(0);
  env.emit(ev('progress', 1, { percent: 1 }, { replay: true }));
  env.emit(ev('progress', 2, { percent: 2 }));
  assert.deepStrictEqual(plainListener, [2]);
  assert.deepStrictEqual(everything, ['replay', 'live']);
});

test("replay: since 'all' asks for every stored job of the feature", async () => {
  const env = app();
  const got = [];
  env.despia.ffmpeg.on('done', (d) => got.push(d.jobId), { since: 'all' });
  await env.clock.tick(0);
  const subscribes = env.calls.filter((c) => c.action === 'subscribe').map((c) => c.args);
  assert.deepStrictEqual(subscribes[1], { feature: 'ffmpeg', events: ['done'], since: 'all' });
  env.emit(ev('done', 1, { ok: true }, { replay: true, jobId: 'j-a', data: { jobId: 'j-a', ok: true } }));
  env.emit(ev('done', 1, { ok: true }, { replay: true, jobId: 'j-b', data: { jobId: 'j-b', ok: true } }));
  assert.deepStrictEqual(got, ['j-a', 'j-b']);
});

test('replay: replayed seq numbers may skip (latest-only logs) and are not held back', async () => {
  const env = app();
  const got = [];
  env.despia.ffmpeg.on('progress', (d) => got.push(d.percent), { jobId: 'j-1', since: 0 });
  await env.clock.tick(0);
  env.emit(ev('progress', 9, { percent: 90 }, { replay: true }));
  assert.deepStrictEqual(got, [90]);
});

test('replay: bad since and a numeric since without jobId are TypeErrors', () => {
  const env = app();
  assert.throws(() => env.despia.ffmpeg.on('progress', () => {}, { since: 3 }), { name: 'TypeError' });
  assert.throws(() => env.despia.ffmpeg.on('progress', () => {}, { since: -1, jobId: 'j' }), { name: 'TypeError' });
  assert.throws(() => env.despia.ffmpeg.on('progress', () => {}, { since: 'some' }), { name: 'TypeError' });
  assert.throws(() => env.despia.ffmpeg.on('progress', () => {}, { jobId: 5 }), { name: 'TypeError' });
});

test('replay: job.on(event, fn, { since }) subscribes for that job and receives the replay', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  const got = [];
  const off = job.on('progress', (d) => got.push(d.percent), { since: 5 });
  await env.clock.tick(0);
  assert.deepStrictEqual(sent(env, 'subscribe').pop().args,
    { feature: 'ffmpeg', events: ['progress'], since: { 'j-1': 5 } });
  env.emit(ev('progress', 6, { percent: 60 }, { replay: true }));
  env.emit(ev('progress', 5, { percent: 50 }, { replay: true }));
  assert.deepStrictEqual(got, [60]);
  off();

  job.on('log', () => {}, { since: 'all' });
  await env.clock.tick(0);
  assert.deepStrictEqual(sent(env, 'subscribe').pop().args,
    { feature: 'ffmpeg', events: ['log'], since: { 'j-1': 0 } });
  assert.throws(() => job.on('log', () => {}, { since: -2 }), { name: 'TypeError' });
});

test('replay: a done replayed after a reload settles result()', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  const result = outcome(job.result());
  env.emit(ev('done', 9, { ok: true }, { replay: true }));
  await result.done;
  assert.equal(result.value.ok, true);
});

// ---- cancel and ack ---------------------------------------------------------

test('cancel: sends bridge.cancel for the job and returns its answer', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  assert.deepStrictEqual(plain(await job.cancel()), { cancelled: true, state: 'cancelled' });
  assert.deepStrictEqual(sent(env, 'cancel').map((c) => c.args), [{ jobId: 'j-1' }]);
  env.emit(ev('done', 1, { ok: false, error: { code: 'cancelled', message: 'cancelled' } }));
  await assert.rejects(job.result(), { code: 'cancelled' });
});

test('cancel: an unknown job rejects with not_found', async () => {
  const env = app({}, (call) => (call.action === 'cancel' ? fail('not_found', 'gone') : undefined));
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  await assert.rejects(job.cancel(), { code: 'not_found' });
});

test('ack: sends bridge.ack with the job and seq and resolves with nothing', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  assert.equal(await job.ack(12), undefined);
  assert.deepStrictEqual(sent(env, 'ack').map((c) => c.args), [{ jobId: 'j-1', seq: 12 }]);
  await assert.rejects(job.ack(-1), { code: 'bad_args' });
  await assert.rejects(job.ack(1.5), { code: 'bad_args' });
  assert.equal(sent(env, 'ack').length, 1);
});

test('job.on: listeners can be removed; a throwing listener does not stop the others', async () => {
  const env = app();
  const job = await env.despia.ffmpeg.run({ input: INPUT });
  const seen = [];
  const off = job.on('progress', () => seen.push('removed'));
  job.on('progress', () => { throw new Error('boom'); });
  job.on('progress', (d) => seen.push(d.percent));
  off();
  off();
  env.emit(ev('progress', 1, { percent: 7 }));
  assert.deepStrictEqual(seen, [7]);
  assert.equal(env.consoleErrors.length, 1);
  assert.throws(() => job.on('', () => {}), { name: 'TypeError' });
  assert.throws(() => job.on('progress', 5), { name: 'TypeError' });
});

test('job: a job action on a legacy-only app rejects with feature_not_installed', async () => {
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA });
  await assert.rejects(env.despia.ffmpeg.run({ input: INPUT }), { code: 'feature_not_installed' });
});

test('job: start honours AbortSignal', async () => {
  const env = app({}, (call) => (call.feature === 'ffmpeg' ? new Promise(() => {}) : undefined));
  const controller = new AbortController();
  const started = outcome(env.despia.ffmpeg.run({ input: INPUT }, {}, { signal: controller.signal }));
  await env.clock.tick(0);
  controller.abort();
  await started.done;
  assert.equal(started.error.code, 'aborted');
});
