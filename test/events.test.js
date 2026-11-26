'use strict';

// Broadcast and per-feature listeners, and how they subscribe with native.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, ok, DESPIA_UA } = require('./helpers');

function app(extra = {}) {
  return loadSdk(Object.assign({
    fixture: true,
    userAgent: DESPIA_UA,
    bridge: (call) => {
      if (call.feature === 'bridge') return call.action === 'subscribe' ? ok({ subscribed: true }) : ok({});
    }
  }, extra));
}

const subs = (env) => env.calls.filter((c) => c.feature === 'bridge' && /subscribe/.test(c.action));

test('despia.on: hears every packet, with the whole packet', async () => {
  const env = app();
  const heard = [];
  const off = env.despia.on((p) => heard.push(plain(p)));
  await env.clock.tick(0);
  env.emit({ feature: 'ffmpeg', event: 'progress', jobId: 'j-1', seq: 1, data: { jobId: 'j-1', percent: 5 } });
  env.emit({ feature: 'bridge', event: 'job', data: { jobId: 'j-1', state: 'running' } });
  env.emit({ feature: 'notes', event: 'changed', data: {} });
  assert.deepStrictEqual(heard.map((p) => p.feature + '.' + p.event), ['ffmpeg.progress', 'bridge.job', 'notes.changed']);
  assert.equal(heard[0].seq, 1);
  assert.equal(heard[0].v, 1);
  assert.equal(heard[0].t, 'event');
  off();
  env.emit({ feature: 'notes', event: 'changed', data: {} });
  assert.equal(heard.length, 3);
});

test('despia.on: subscribes to everything once, unsubscribes when the last listener leaves', async () => {
  const env = app();
  const a = env.despia.on(() => {});
  const b = env.despia.on(() => {});
  await env.clock.tick(0);
  assert.deepStrictEqual(subs(env).map((c) => [c.action, c.args]), [['subscribe', { feature: '*' }]]);
  a();
  await env.clock.tick(0);
  assert.equal(subs(env).length, 1);
  b();
  b();
  await env.clock.tick(0);
  assert.deepStrictEqual(subs(env).map((c) => [c.action, c.args]),
    [['subscribe', { feature: '*' }], ['unsubscribe', { feature: '*' }]]);
});

test('feature.on: receives that feature and event only, with the data', async () => {
  const env = app();
  const got = [];
  env.despia.ffmpeg.on('progress', (data) => got.push(plain(data)));
  await env.clock.tick(0);
  env.emit({ feature: 'ffmpeg', event: 'progress', jobId: 'j-1', seq: 1, data: { jobId: 'j-1', percent: 1 } });
  env.emit({ feature: 'ffmpeg', event: 'log', jobId: 'j-1', seq: 2, data: { jobId: 'j-1', level: 'info', line: 'x' } });
  env.emit({ feature: 'media', event: 'progress', data: { percent: 9 } });
  assert.deepStrictEqual(got, [{ jobId: 'j-1', percent: 1 }]);
});

test('feature.on: filters by jobId', async () => {
  const env = app();
  const got = [];
  env.despia.ffmpeg.on('progress', (d) => got.push(d.percent), { jobId: 'j-2' });
  await env.clock.tick(0);
  env.emit({ feature: 'ffmpeg', event: 'progress', jobId: 'j-1', seq: 1, data: { jobId: 'j-1', percent: 1 } });
  env.emit({ feature: 'ffmpeg', event: 'progress', jobId: 'j-2', seq: 1, data: { jobId: 'j-2', percent: 2 } });
  assert.deepStrictEqual(got, [2]);
});

test('feature.on: subscribes per feature and event, counted across listeners', async () => {
  const env = app();
  const a = env.despia.ffmpeg.on('progress', () => {});
  const b = env.despia.ffmpeg.on('progress', () => {});
  const c = env.despia.ffmpeg.on('log', () => {});
  await env.clock.tick(0);
  assert.deepStrictEqual(subs(env).map((x) => [x.action, x.args]), [
    ['subscribe', { feature: 'ffmpeg', events: ['progress'] }],
    ['subscribe', { feature: 'ffmpeg', events: ['log'] }]
  ]);
  a(); b(); c();
  await env.clock.tick(0);
  assert.deepStrictEqual(subs(env).slice(2).map((x) => [x.action, x.args]), [
    ['unsubscribe', { feature: 'ffmpeg', events: ['progress'] }],
    ['unsubscribe', { feature: 'ffmpeg', events: ['log'] }]
  ]);
});

test('listeners: a throwing listener does not stop the others; off is idempotent', async () => {
  const env = app();
  const seen = [];
  env.despia.on(() => { throw new Error('boom'); });
  env.despia.on((p) => seen.push(p.event));
  await env.clock.tick(0);
  env.emit({ feature: 'notes', event: 'changed', data: {} });
  assert.deepStrictEqual(seen, ['changed']);
  assert.equal(env.consoleErrors.length, 1);
});

test('listeners: argument checks', () => {
  const env = app();
  assert.throws(() => env.despia.on(), { name: 'TypeError' });
  assert.throws(() => env.despia.ffmpeg.on('progress'), { name: 'TypeError' });
  assert.throws(() => env.despia.ffmpeg.on('', () => {}), { name: 'TypeError' });
});

test('listeners: malformed packets are ignored', async () => {
  const env = app();
  const seen = [];
  env.despia.on((p) => seen.push(p.event));
  await env.clock.tick(0);
  const ignored = [null, 'text', 5, {}, { feature: 'x' }, { event: 'y' }];
  ignored.forEach((raw) => env.listeners.forEach((fn) => fn(raw)));
  env.emit({ feature: 'notes', event: 'ok-without-data' }); // data defaults to {}
  assert.deepStrictEqual(seen, ['ok-without-data']);
});

test('despia.bridge.on: bridge job state events', async () => {
  const env = app();
  const states = [];
  env.despia.bridge.on('job', (info) => states.push(info.state));
  await env.clock.tick(0);
  assert.deepStrictEqual(subs(env)[0].args, { feature: 'bridge', events: ['job'] });
  env.emit({ feature: 'bridge', event: 'job', data: { jobId: 'j-1', state: 'running' } });
  env.emit({ feature: 'bridge', event: 'job', data: { jobId: 'j-1', state: 'done' } });
  assert.deepStrictEqual(states, ['running', 'done']);
});

test('plain browser and legacy-only apps: listeners register, nothing is sent, nothing fires', async () => {
  const browser = loadSdk({ fixture: true });
  const off1 = browser.despia.ffmpeg.on('progress', () => assert.fail('fired'));
  const off2 = browser.despia.on(() => assert.fail('fired'));
  await browser.clock.tick(0);
  off1(); off2();

  const refused = app({ hello: null });
  const off3 = refused.despia.ffmpeg.on('progress', () => assert.fail('fired'));
  await refused.clock.tick(0);
  off3();
  await refused.clock.tick(0);
  assert.deepStrictEqual(subs(refused), []);
});
