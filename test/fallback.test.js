'use strict';

// Without the JSON bridge: legacy schemes inside the app, not_in_app in a
// plain browser or on the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, outcome, DESPIA_UA } = require('./helpers');
const features = require('../src/features');

function legacyApp(answers = {}) {
  const env = loadSdk({
    userAgent: DESPIA_UA,
    onCommand: (command, win) => {
      const answer = answers[command];
      if (answer) win.setTimeout(() => Object.assign(win, answer), 150);
    }
  });
  return env;
}

// ---- plain browser -------------------------------------------------------

test('browser: every typed action rejects with not_in_app', async () => {
  const env = loadSdk({});
  const sample = {
    vault: { get: { key: 'k' }, set: { key: 'k', value: 'v' } },
    revenuecat: { purchase: { externalId: 'u', product: 'p' }, paywall: { externalId: 'u' } }
  };
  for (const feature of Object.keys(features)) {
    for (const action of Object.keys(features[feature].actions)) {
      const args = (sample[feature] || {})[action];
      await assert.rejects(env.despia[feature][action](args), (err) => {
        assert.ok(err instanceof env.despia.DespiaError, feature + '.' + action);
        assert.equal(err.code, 'not_in_app');
        return true;
      });
    }
  }
  assert.deepEqual(env.commands, [], 'nothing is sent over the legacy channel');
});

test('browser: the legacy despia() call still assigns window.despia, as before', async () => {
  const env = loadSdk({});
  assert.equal(await env.despia('lighthaptic://'), undefined);
  await env.clock.tick(5);
  assert.deepEqual(env.commands, ['lighthaptic://']);
});

test('browser: listeners can be registered and simply never fire', () => {
  const env = loadSdk({});
  const off = env.despia.gps.on('change', () => assert.fail('fired'));
  assert.equal(typeof off, 'function');
  off();
});

test('server-side (no window): loading works and typed calls reject with not_in_app', async () => {
  const env = loadSdk({ noWindow: true });
  assert.equal(typeof env.despia, 'function');
  await assert.rejects(env.despia.haptics.light(), { code: 'not_in_app' });
  assert.equal(env.despia.notAWindowVar, undefined);
});

test('invalid args are reported before the environment check', async () => {
  const env = loadSdk({});
  await assert.rejects(env.despia.vault.get({}), { code: 'invalid_args' });
});

// ---- inside the app without the JSON bridge: legacy schemes ----------------

test('legacy fallback: fire-and-forget actions send the documented scheme strings', async () => {
  const env = legacyApp();
  const d = env.despia;
  await Promise.all([
    d.haptics.light(), d.haptics.heavy(), d.haptics.success(), d.haptics.warning(), d.haptics.error(),
    d.vault.set({ key: 'sessionToken', value: 'abc123', locked: true }),
    d.revenuecat.paywall({ externalId: 'user_777', offering: 'default' }),
    d.revenuecat.purchase({ externalId: 'user_777', product: 'monthly_premium_ios' }),
    d.gps.start({ buffer: 60, movement: 100 }),
    d.gps.start()
  ]);
  await env.clock.tick(50);
  assert.deepEqual(env.commands, [
    'lighthaptic://',
    'heavyhaptic://',
    'successhaptic://',
    'warninghaptic://',
    'errorhaptic://',
    'setvault://?key=sessionToken&value=abc123&locked=true',
    'revenuecat://launchPaywall?external_id=user_777&offering=default',
    'revenuecat://purchase?external_id=user_777&product=monthly_premium_ios',
    'location://?buffer=60&movement=100',
    'location://'
  ]);
});

test('legacy fallback: values are URL-encoded and optional args are left out', async () => {
  const env = legacyApp();
  await env.despia.vault.set({ key: 'a b', value: 'x&y=z?#é' });
  await env.despia.gps.start({ server: 'https://api.example.com/track?u=1' });
  await env.clock.tick(5);
  assert.deepEqual(env.commands, [
    'setvault://?key=a%20b&value=x%26y%3Dz%3F%23%C3%A9',
    'location://?server=https%3A%2F%2Fapi.example.com%2Ftrack%3Fu%3D1'
  ]);
});

test('legacy fallback: results come from the watched window variables', async () => {
  const env = legacyApp({
    'readvault://?key=sessionToken': { sessionToken: 'abc123' },
    'get-uuid://': { uuid: 'uuid-42' },
    'getstorelocation://': { storeLocation: 'DE' },
    'getpurchasehistory://': { restoredData: [{ isActive: true, entitlementId: 'premium' }] },
    'stoplocation://': { locationSession: { points: 3 } },
    'getappversion://': { versionNumber: '2.4.1', bundleNumber: '381' }
  });
  const d = env.despia;
  const calls = {
    token: outcome(d.vault.get({ key: 'sessionToken' })),
    uuid: outcome(d.device.uuid()),
    store: outcome(d.device.storeLocation()),
    history: outcome(d.revenuecat.history()),
    session: outcome(d.gps.stop()),
    version: outcome(d.device.appVersion())
  };
  await env.clock.tick(3000);
  await Promise.all(Object.values(calls).map((c) => c.done));

  assert.equal(calls.token.value, 'abc123');
  assert.equal(calls.uuid.value, 'uuid-42');
  assert.equal(calls.store.value, 'DE');
  assert.deepEqual(plain(calls.history.value), [{ isActive: true, entitlementId: 'premium' }]);
  assert.deepEqual(plain(calls.session.value), { points: 3 });
  assert.deepEqual(plain(calls.version.value), { versionNumber: '2.4.1', bundleNumber: '381' });
  assert.deepEqual(env.commands, [
    'readvault://?key=sessionToken',
    'get-uuid://',
    'getstorelocation://',
    'getpurchasehistory://',
    'stoplocation://',
    'getappversion://'
  ]);
});

test('legacy fallback: shares the legacy queue, so call order is preserved', async () => {
  const env = legacyApp();
  env.despia('spinneron://');
  env.despia.haptics.success();
  env.despia('spinneroff://');
  await env.clock.tick(10);
  assert.deepEqual(env.commands, ['spinneron://', 'successhaptic://', 'spinneroff://']);
});

test('legacy fallback: a missing reply rejects with timeout after the legacy 30 s window', async () => {
  const env = legacyApp();
  const call = outcome(env.despia.vault.get({ key: 'neverSet' }));
  await env.clock.tick(29000);
  assert.equal(call.settled, false);
  await env.clock.tick(2000);
  await call.done;
  assert.ok(call.error instanceof env.despia.DespiaError);
  assert.equal(call.error.code, 'timeout');
  assert.match(call.error.message, /neverSet/);
});

test('legacy fallback: multi-variable results time out after the legacy 5 min window', async () => {
  const env = legacyApp({ 'getappversion://': { versionNumber: '2.4.1' } });
  const call = outcome(env.despia.device.appVersion());
  await env.clock.tick(299000);
  assert.equal(call.settled, false);
  await env.clock.tick(2000);
  await call.done;
  assert.equal(call.error.code, 'timeout');
});

test('legacy fallback is used only when no JSON bridge is present', async () => {
  const env = loadSdk({ userAgent: DESPIA_UA, ios: (msg) => ({ id: msg.id, ok: true, value: 'from-json' }) });
  assert.equal(await env.despia.device.uuid(), 'from-json');
  await env.clock.tick(5);
  assert.deepEqual(env.commands, []);
});

test('the bridge is detected per call, so a bridge injected after load is used', async () => {
  const env = loadSdk({ userAgent: DESPIA_UA });
  env.win.webkit = { messageHandlers: { despia: { postMessage: (msg) => ({ id: msg.id, ok: true, value: 'late' }) } } };
  assert.equal(await env.despia.device.uuid(), 'late');
});
