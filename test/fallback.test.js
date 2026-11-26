'use strict';

// Where a typed call goes when the JSON bridge cannot take it: the action's
// legacy scheme when the catalog has one (and it must be exactly what the
// 1.0.28 SDK sends for the same command), otherwise feature_not_installed;
// not_in_app outside the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, outcome, ok, RELEASE_1_0_28, DESPIA_UA, BROWSER_UA } = require('./helpers');
const shipped = require('../src/features');
const { generate, readCatalogs } = require('../scripts/generate-features');
const { FIXTURE_CATALOG } = require('./helpers');

const fixtureCatalog = generate(readCatalogs([FIXTURE_CATALOG])).runtime;

// ---- the fake app answering legacy commands --------------------------------

function answers(win, command) {
  const later = (ms, fn) => win.setTimeout(fn, ms);
  if (command === 'getappversion://') {
    later(250, () => { win.versionNumber = '2.4.1'; });
    later(1700, () => { win.bundleNumber = '381'; });
  } else if (command === 'readvault://?key=sessionToken') {
    later(40, () => { win.sessionToken = 'n/a'; });
    later(400, () => { win.sessionToken = 'abc123'; });
  } else if (command === 'get-uuid://') {
    later(90, () => { win.uuid = 'u-1'; });
  } else if (command === 'getpurchasehistory://') {
    later(500, () => { win.restoredData = [{ isActive: true, entitlementId: 'premium' }]; });
  } else if (command.indexOf('extension://notes/get?id=1') === 0) {
    later(100, () => { win.notesResult = { ok: true, data: { text: 'hi' } }; });
  } else if (command.indexOf('extension://notes/get?id=bad') === 0) {
    later(100, () => { win.notesResult = { ok: false, error: { code: 'not_found', message: 'no note' } }; });
  }
}

function legacyApp(file, opts = {}) {
  const env = loadSdk(Object.assign({
    file,
    userAgent: DESPIA_UA,
    onCommand: (command, win) => answers(win, command)
  }, opts));
  return env;
}

// Runs `typed` against the current SDK and `raw` against the 1.0.28 release
// under identical fake apps, and requires the same commands at the same
// virtual times.
async function sameAsRelease(typed, raw, { fixture = false } = {}) {
  const now = loadSdk(Object.assign({
    fixture, userAgent: DESPIA_UA, onCommand: (c, win) => answers(win, c)
  }));
  const old = legacyApp(RELEASE_1_0_28);
  const timeline = (env) => {
    const log = [];
    const origin = env.clock.now;
    const original = Object.getOwnPropertyDescriptor(env.win, 'despia');
    Object.defineProperty(env.win, 'despia', {
      configurable: true,
      get: original.get,
      set(value) { log.push([env.clock.now - origin, value]); original.set.call(this, value); }
    });
    return log;
  };
  const nowLog = timeline(now);
  const oldLog = timeline(old);
  const a = outcome(typed(now.despia));
  const b = outcome(raw(old.despia));
  await now.clock.tick(40000);
  await old.clock.tick(40000);
  await Promise.all([a.done, b.done]);
  assert.deepStrictEqual(nowLog, oldLog);
  assert.ok(nowLog.length > 0);
  return { typed: a, raw: b, commands: nowLog.map((entry) => entry[1]) };
}

// ---- byte-for-byte against 1.0.28 -----------------------------------------

test('legacy fallback: vault.get sends what despia(readvault, [key]) sends and returns the variable', async () => {
  const r = await sameAsRelease(
    (d) => d.vault.get({ key: 'sessionToken' }),
    (d) => d('readvault://?key=sessionToken', ['sessionToken']),
    { fixture: true }
  );
  assert.deepStrictEqual(r.commands, ['readvault://?key=sessionToken']);
  assert.equal(r.typed.value, 'abc123');
  assert.deepStrictEqual(plain(r.raw.value), { sessionToken: 'abc123' });
});

test('legacy fallback: vault.set encodes every character exactly as the old URL did', async () => {
  const value = 'é✓🚀"\'<>\\\n\t \u0000&=';
  const r = await sameAsRelease(
    (d) => d.vault.set({ key: 'k k', value, locked: true }),
    (d) => d('setvault://?key=' + encodeURIComponent('k k') + '&value=' + encodeURIComponent(value) + '&locked=true'),
    { fixture: true }
  );
  assert.equal(r.typed.value, undefined);
  assert.equal(r.commands.length, 1);
});

test('legacy fallback: undefined and null args are left out of the URL', async () => {
  const r = await sameAsRelease(
    (d) => d.vault.set({ key: 'k', value: 'v', locked: undefined }),
    (d) => d('setvault://?key=k&value=v'),
    { fixture: true }
  );
  assert.deepStrictEqual(r.commands, ['setvault://?key=k&value=v']);
});

test('legacy fallback: shipped actions equal their old scheme commands', async () => {
  const cases = [
    [(d) => d.haptics.light(), (d) => d('lighthaptic://')],
    [(d) => d.haptics.error(), (d) => d('errorhaptic://')],
    [(d) => d.revenuecat.purchase({ externalId: 'user 1', product: 'monthly' }),
      (d) => d('revenuecat://purchase?external_id=user%201&product=monthly')],
    [(d) => d.revenuecat.paywall({ externalId: 'u' }), (d) => d('revenuecat://launchPaywall?external_id=u')],
    [(d) => d.gps.start({ buffer: 60, movement: 100, server: 'https://x.invalid/p?a=1&b=2' }),
      (d) => d('location://?buffer=60&movement=100&server=' + encodeURIComponent('https://x.invalid/p?a=1&b=2'))],
    [(d) => d.gps.start({ movement: 0 }), (d) => d('location://?movement=0')]
  ];
  for (const [typed, raw] of cases) {
    const r = await sameAsRelease(typed, raw);
    assert.equal(r.typed.error, undefined);
  }
});

test('legacy fallback: shipped actions that read variables resolve as the old watch did', async () => {
  let r = await sameAsRelease((d) => d.device.uuid(), (d) => d('get-uuid://', ['uuid']));
  assert.equal(r.typed.value, 'u-1');

  r = await sameAsRelease((d) => d.device.app_version(), (d) => d('getappversion://', ['versionNumber', 'bundleNumber']));
  assert.deepStrictEqual(plain(r.typed.value), { versionNumber: '2.4.1', bundleNumber: '381' });
  assert.deepStrictEqual(plain(r.raw.value), plain(r.typed.value));

  r = await sameAsRelease((d) => d.revenuecat.history(), (d) => d('getpurchasehistory://', ['restoredData']));
  assert.deepStrictEqual(plain(r.typed.value), [{ isActive: true, entitlementId: 'premium' }]);
});

test('legacy fallback: an envelope answer is unwrapped; an error envelope rejects', async () => {
  const raw = (id) => (d) => d('extension://notes/get?id=' + id, ['notesResult']);
  let r = await sameAsRelease((d) => d.notes.get({ id: '1' }), raw('1'), { fixture: true });
  assert.deepStrictEqual(plain(r.typed.value), { text: 'hi' });
  assert.deepStrictEqual(plain(r.raw.value), { notesResult: { ok: true, data: { text: 'hi' } } });

  r = await sameAsRelease((d) => d.notes.get({ id: 'bad' }), raw('bad'), { fixture: true });
  assert.equal(r.typed.error.code, 'not_found');
  assert.equal(r.typed.error.message, 'no note');
});

test('legacy fallback: array and object args travel as one percent-encoded JSON parameter', async () => {
  const r = await sameAsRelease(
    (d) => d.notes.get({ id: '1', tags: ['a', 'b&c'] }),
    (d) => d('extension://notes/get?id=1&tags=' + encodeURIComponent('["a","b&c"]'), ['notesResult']),
    { fixture: true }
  );
  assert.equal(r.commands[0], 'extension://notes/get?id=1&tags=%5B%22a%22%2C%22b%26c%22%5D');
});

test('legacy fallback: a missing answer rejects with timeout, as before', async () => {
  const env = loadSdk({ userAgent: DESPIA_UA });
  const result = outcome(env.despia.device.uuid());
  await env.clock.tick(31000);
  assert.equal(result.error.code, 'timeout');
  assert.ok(result.error instanceof env.despia.DespiaError);
});

// ---- the decision ------------------------------------------------------------

test('decision: app has the bridge and lists the action -> bridge, no legacy command', async () => {
  const env = loadSdk({
    fixture: true, userAgent: DESPIA_UA,
    hello: { v: 1, platform: 'android', features: { vault: { version: '1', actions: ['get'], events: [] } }, limits: {} },
    bridge: (call) => (call.feature === 'vault' ? ok('from-bridge') : undefined)
  });
  assert.equal(await env.despia.vault.get({ key: 'k' }), 'from-bridge');
  assert.deepStrictEqual(env.commands, []);
});

test('decision: bridge present but the action is not listed -> its legacy mapping', async () => {
  const env = loadSdk({
    fixture: true, userAgent: DESPIA_UA,
    hello: { v: 1, platform: 'ios', features: { vault: { version: '1', actions: ['get'], events: [] } }, limits: {} },
    onCommand: (c, win) => answers(win, c),
    bridge: () => ok('from-bridge')
  });
  // vault.set is not listed: legacy.
  await env.despia.vault.set({ key: 'k', value: 'v' });
  await env.clock.tick(5);
  assert.deepStrictEqual(env.commands, ['setvault://?key=k&value=v']);
  assert.equal(env.calls.filter((c) => c.feature === 'vault').length, 0);
});

test('decision: bridge absent, in the app -> legacy mapping when there is one', async () => {
  const env = legacyApp(undefined, { fixture: true });
  await env.despia.vault.set({ key: 'k', value: 'v' });
  await env.clock.tick(5);
  assert.deepStrictEqual(env.commands, ['setvault://?key=k&value=v']);
});

test('decision: no bridge route and no legacy mapping -> feature_not_installed', async () => {
  const absent = legacyApp(undefined, { fixture: true });
  await assert.rejects(absent.despia.notes.search({ query: 'q' }), { code: 'feature_not_installed' });
  await assert.rejects(absent.despia.media.pick({ kind: 'image' }), { code: 'feature_not_installed' });
  await assert.rejects(absent.despia.ffmpeg.run({ input: { url: 'u', name: 'n', type: 't', size: 1 } }), { code: 'feature_not_installed' });
  assert.deepStrictEqual(absent.commands, [], 'nothing was sent');

  // Bridge present, feature missing from hello.
  const present = loadSdk({
    fixture: true, userAgent: DESPIA_UA,
    hello: { v: 1, platform: 'ios', features: {}, limits: {} },
    bridge: () => assert.fail('native was called')
  });
  await assert.rejects(present.despia.media.pick({ kind: 'image' }), { code: 'feature_not_installed' });
});

test('decision: the bridge object alone marks the document as in the app', async () => {
  // No despia in the user agent, but the app injected the bridge.
  const env = loadSdk({ fixture: true, bridge: () => ok(['x']) });
  assert.deepStrictEqual(plain(await env.despia.notes.search({ query: 'q' })), ['x']);
});

test('decision: a refused hello means legacy only, for every later call too', async () => {
  const env = loadSdk({
    fixture: true, userAgent: DESPIA_UA, hello: null,
    onCommand: (c, win) => answers(win, c),
    bridge: () => assert.fail('native feature call after a refused hello')
  });
  await env.despia.vault.set({ key: 'k', value: 'v' });
  await env.clock.tick(5);
  assert.deepStrictEqual(env.commands, ['setvault://?key=k&value=v']);
  await assert.rejects(env.despia.notes.search({ query: 'q' }), { code: 'feature_not_installed' });
  assert.equal(env.calls.length, 1, 'only the hello');
});

// ---- not_in_app ---------------------------------------------------------------

test('not_in_app: every typed action rejects outside the app, in the shipped and the fixture catalog', async () => {
  for (const [options, catalog] of [[{}, shipped], [{ fixture: true }, fixtureCatalog]]) {
    const env = loadSdk(Object.assign({ userAgent: BROWSER_UA }, options));
    for (const feature of Object.keys(catalog)) {
      for (const action of Object.keys(catalog[feature].actions)) {
        await assert.rejects(env.despia[feature][action]({}), (err) => {
          assert.ok(err instanceof env.despia.DespiaError, feature + '.' + action);
          assert.equal(err.code, 'not_in_app');
          return true;
        });
      }
    }
    assert.deepEqual(env.commands, [], 'nothing is sent over the legacy channel');
  }
});

test('not_in_app: server-side (no window) loads and rejects', async () => {
  const env = loadSdk({ noWindow: true });
  assert.equal(typeof env.despia, 'function');
  await assert.rejects(env.despia.haptics.light(), { code: 'not_in_app' });
  assert.deepStrictEqual(plain(await env.despia.ready()), { bridge: false });
});

test('browser: the legacy despia() call still assigns window.despia, as before', async () => {
  const env = loadSdk({});
  assert.equal(await env.despia('lighthaptic://'), undefined);
  await env.clock.tick(5);
  assert.deepEqual(env.commands, ['lighthaptic://']);
});
