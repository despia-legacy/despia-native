'use strict';

// Events: per-feature listeners, off, and broadcast.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, DESPIA_UA } = require('./helpers');

const point = { active: true, latitude: 52.52, longitude: 13.405 };

test('native emit reaches feature listeners; off stops delivery', () => {
  const env = loadSdk({ userAgent: DESPIA_UA });
  const seen = [];
  const off = env.despia.gps.on('change', (data) => seen.push(plain(data)));

  assert.equal(env.win.__despia.emit({ feature: 'gps', event: 'change', data: point }), true);
  assert.deepEqual(seen, [point]);

  off();
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.equal(seen.length, 1);
  off(); // idempotent
});

test('listeners only hear their own feature and event', () => {
  const env = loadSdk({});
  const seen = [];
  env.despia.gps.on('change', () => seen.push('gps:change'));
  env.despia.revenuecat.on('purchase', () => seen.push('revenuecat:purchase'));

  env.win.__despia.emit({ feature: 'revenuecat', event: 'purchase', data: { productId: 'monthly' } });
  env.win.__despia.emit({ feature: 'gps', event: 'other', data: null });
  env.win.__despia.emit({ feature: 'vault', event: 'change', data: null });
  assert.deepEqual(seen, ['revenuecat:purchase']);
});

test('several listeners on one event each get the data, and off removes only one', () => {
  const env = loadSdk({});
  const seen = [];
  const fn = (d) => seen.push(d.latitude);
  const offA = env.despia.gps.on('change', fn);
  env.despia.gps.on('change', fn); // same function twice: two subscriptions

  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, [52.52, 52.52]);

  offA();
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, [52.52, 52.52, 52.52]);
});

test('despia.on hears every event (broadcast), including features without typed events', () => {
  const env = loadSdk({});
  const all = [];
  const off = env.despia.on((e) => all.push(plain(e)));

  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  env.win.__despia.emit({ feature: 'camera', event: 'captured', data: { path: '/tmp/a.jpg' } });
  assert.deepEqual(all, [
    { feature: 'gps', event: 'change', data: point },
    { feature: 'camera', event: 'captured', data: { path: '/tmp/a.jpg' } }
  ]);

  off();
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.equal(all.length, 2);
});

test('feature listeners run before broadcast listeners', () => {
  const env = loadSdk({});
  const order = [];
  env.despia.on(() => order.push('broadcast'));
  env.despia.gps.on('change', () => order.push('feature'));
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(order, ['feature', 'broadcast']);
});

test('a throwing listener does not stop the others', () => {
  const env = loadSdk({});
  const seen = [];
  env.despia.gps.on('change', () => { throw new Error('bad listener'); });
  env.despia.gps.on('change', () => seen.push('second'));
  env.despia.on(() => seen.push('broadcast'));

  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, ['second', 'broadcast']);
  assert.match(env.consoleErrors[0], /Despia event listener failed/);
});

test('a listener may unsubscribe itself while being called', () => {
  const env = loadSdk({});
  const seen = [];
  const off = env.despia.gps.on('change', () => { seen.push('once'); off(); });
  env.despia.gps.on('change', () => seen.push('always'));
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  env.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, ['once', 'always', 'always']);
});

test('emit accepts a JSON string and ignores malformed payloads', () => {
  const env = loadSdk({});
  const all = [];
  env.despia.on((e) => all.push(plain(e)));

  assert.equal(env.win.__despia.emit(JSON.stringify({ feature: 'gps', event: 'change', data: point })), true);
  assert.equal(env.win.__despia.emit('{not json'), false);
  assert.equal(env.win.__despia.emit({ feature: 'gps' }), false);
  assert.equal(env.win.__despia.emit(null), false);
  assert.deepEqual(all, [{ feature: 'gps', event: 'change', data: point }]);
});

test('Android may deliver events over the despia_bridge channel', () => {
  const env = loadSdk({ android: () => {} });
  const seen = [];
  env.despia.gps.on('change', (d) => seen.push(plain(d)));
  env.androidSend({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, [point]);
});

test('two SDK copies on one page share the emit hook', () => {
  const first = loadSdk({});
  const second = loadSdk({ context: first });
  assert.notEqual(first.despia, second.despia);

  const seen = [];
  first.despia.gps.on('change', () => seen.push('first'));
  second.despia.gps.on('change', () => seen.push('second'));
  first.win.__despia.emit({ feature: 'gps', event: 'change', data: point });
  assert.deepEqual(seen, ['first', 'second']);
});

test('on() rejects bad listeners and event names synchronously', () => {
  const env = loadSdk({});
  assert.throws(() => env.despia.gps.on('change'), { name: 'TypeError' });
  assert.throws(() => env.despia.gps.on('', () => {}), { name: 'TypeError' });
  assert.throws(() => env.despia.on('not a function'), { name: 'TypeError' });
});
