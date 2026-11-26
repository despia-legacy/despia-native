'use strict';

// Promise resolve and reject over the JSON bridge (iOS and Android).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, outcome, DESPIA_UA } = require('./helpers');

const okReply = (msg, value) => ({ id: msg.id, ok: true, value });
const errReply = (msg, code, message) => ({ id: msg.id, ok: false, error: { code, message } });

test('iOS: sends { v, id, feature, action, args } and resolves with reply.value', async () => {
  const env = loadSdk({
    userAgent: DESPIA_UA,
    ios: (msg) => Promise.resolve(okReply(msg, msg.action === 'get' ? 'abc123' : undefined))
  });

  const token = await env.despia.vault.get({ key: 'sessionToken' });
  assert.equal(token, 'abc123');

  const [msg] = env.posted;
  assert.equal(msg.v, 1);
  assert.equal(typeof msg.id, 'string');
  assert.deepEqual(plain(msg), { v: 1, id: msg.id, feature: 'vault', action: 'get', args: { key: 'sessionToken' } });

  assert.equal(await env.despia.haptics.light(), undefined);
  assert.deepEqual(plain(env.posted[1].args), {}, 'no-arg actions send args: {}');
  assert.notEqual(env.posted[0].id, env.posted[1].id, 'ids are unique');
  assert.deepEqual(env.commands, [], 'the legacy channel is not used');
});

test('iOS: structured JSON args arrive intact, with no encoding or length limit', async () => {
  const big = 'x'.repeat(200000);
  const value = JSON.stringify({ nested: { list: [1, 2, 3], unicode: 'é ✓ 🚀', quote: '"&?=#' }, big });
  const env = loadSdk({ ios: (msg) => okReply(msg, null) });

  await env.despia.vault.set({ key: 'blob', value, locked: true });
  assert.deepEqual(plain(env.posted[0].args), { key: 'blob', value, locked: true });
});

test('iOS: a JSON string reply is accepted', async () => {
  const env = loadSdk({ ios: (msg) => JSON.stringify(okReply(msg, { versionNumber: '2.1', bundleNumber: '42' })) });
  assert.deepEqual(plain(await env.despia.device.appVersion()), { versionNumber: '2.1', bundleNumber: '42' });
});

test('iOS: { ok: false } rejects with a typed DespiaError carrying the native code', async () => {
  const env = loadSdk({ ios: (msg) => errReply(msg, 'not_found', 'No value for key') });

  await assert.rejects(env.despia.vault.get({ key: 'missing' }), (err) => {
    assert.ok(err instanceof env.despia.DespiaError);
    assert.ok(err instanceof env.win.Error);
    assert.equal(err.name, 'DespiaError');
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'No value for key');
    return true;
  });
});

test('iOS: a native rejection (replyHandler error) becomes native_error', async () => {
  const env = loadSdk({ ios: () => Promise.reject(new Error('handler failed')) });
  await assert.rejects(env.despia.haptics.heavy(), { name: 'DespiaError', code: 'native_error', message: 'handler failed' });
});

test('iOS: malformed or mismatched replies reject with bridge_error', async () => {
  for (const reply of [undefined, 'not json', { ok: true }, (msg) => ({ id: msg.id + 'x', ok: true })]) {
    const env = loadSdk({ ios: (msg) => (typeof reply === 'function' ? reply(msg) : reply) });
    await assert.rejects(env.despia.haptics.light(), { code: 'bridge_error' });
  }
});

test('iOS: postMessage throwing rejects with bridge_error instead of throwing', async () => {
  const env = loadSdk({ ios: () => { throw new Error('boom'); } });
  const p = env.despia.haptics.light();
  assert.ok(p instanceof env.win.Promise || typeof p.then === 'function');
  await assert.rejects(p, { code: 'bridge_error' });
});

test('Android: posts a JSON string and resolves when the reply with the same id arrives', async () => {
  const env = loadSdk({ android: () => {} });

  const first = outcome(env.despia.device.uuid());
  const second = outcome(env.despia.vault.get({ key: 'k' }));
  await env.clock.tick(0);
  assert.equal(env.posted.length, 2);
  assert.equal(first.settled, false, 'pending until native replies');

  // Replies may arrive out of order; each is matched by id.
  env.androidSend(okReply(env.posted[1], 'secret'));
  env.androidSend(okReply(env.posted[0], 'uuid-1'));
  await Promise.all([first.done, second.done]);
  assert.equal(first.value, 'uuid-1');
  assert.equal(second.value, 'secret');
  assert.deepEqual(plain(env.posted[1]), { v: 1, id: env.posted[1].id, feature: 'vault', action: 'get', args: { key: 'k' } });
});

test('Android: { ok: false } rejects with DespiaError', async () => {
  const env = loadSdk({ android: (msg, e) => e.androidSend(errReply(msg, 'cancelled', 'User cancelled')) });
  await assert.rejects(env.despia.revenuecat.purchase({ externalId: 'u1', product: 'monthly' }), (err) => {
    assert.ok(err instanceof env.despia.DespiaError);
    assert.equal(err.code, 'cancelled');
    assert.equal(err.message, 'User cancelled');
    return true;
  });
});

test('Android: falls back to onmessage when addEventListener is missing', async () => {
  const env = loadSdk({ android: (msg, e) => e.androidSend(okReply(msg, 'v')), androidOnMessage: true });
  assert.equal(await env.despia.device.storeLocation(), 'v');
});

test('Android: replies for unknown ids and junk messages are ignored', async () => {
  const env = loadSdk({ android: () => {} });
  const call = outcome(env.despia.device.uuid());
  await env.clock.tick(0);
  env.androidSend({ id: 'someone-else', ok: true, value: 'nope' });
  env.androidSend('not json');
  env.androidSend({ hello: 'world' });
  await env.clock.tick(0);
  assert.equal(call.settled, false);
  env.androidSend(okReply(env.posted[0], 'mine'));
  await call.done;
  assert.equal(call.value, 'mine');
});

test('iOS is preferred when both bridges are present', async () => {
  const env = loadSdk({ ios: (msg) => okReply(msg, 'ios'), android: () => assert.fail('android used') });
  assert.equal(await env.despia.device.uuid(), 'ios');
});

test('args are validated against the feature map before anything is sent', async () => {
  const env = loadSdk({ ios: (msg) => okReply(msg, null) });
  const cases = [
    [() => env.despia.vault.get(), /"key" is required/],
    [() => env.despia.vault.get({ key: '' }), /at least 1 in length/],
    [() => env.despia.vault.set({ key: 'k', value: 1 }), /"value" must be string, got integer/],
    [() => env.despia.gps.start({ buffer: 1.5 }), /"buffer" must be integer, got number/],
    [() => env.despia.gps.start({ buffer: 0 }), /"buffer" must be at least 1/],
    [() => env.despia.gps.start({ movement: Infinity }), /must be integer/],
    [() => env.despia.vault.get('sessionToken'), /args must be a plain object/],
    [() => env.despia.vault.get(['k']), /args must be a plain object/]
  ];
  for (const [run, message] of cases) {
    await assert.rejects(run(), (err) => err.code === 'invalid_args' && message.test(err.message));
  }
  assert.equal(env.posted.length, 0);

  // Extra keys are passed through for native to judge.
  await env.despia.gps.start({ buffer: 60, movement: 100, accuracy: 'high' });
  assert.deepEqual(plain(env.posted[0].args), { buffer: 60, movement: 100, accuracy: 'high' });
});

test('args that cannot be serialised reject with invalid_args', async () => {
  const env = loadSdk({ android: () => {} });
  const loop = {};
  loop.self = loop;
  await assert.rejects(env.despia.gps.start({ meta: loop }), { code: 'invalid_args' });
  assert.equal(env.posted.length, 0);
});

test('calls never throw synchronously', () => {
  const env = loadSdk({});
  const p = env.despia.vault.get(42);
  assert.equal(typeof p.then, 'function');
  p.catch(() => {});
});
