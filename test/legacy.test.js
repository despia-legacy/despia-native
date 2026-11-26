'use strict';

// The legacy call `despia("scheme://...", ["var"])` must behave exactly as
// in 1.0.28. Each scenario runs against the 1.0.28 release file
// (test/fixtures/index-1.0.28.js) and the current build under the same
// virtual clock and fake native app, and the transcripts must be identical:
// the same strings assigned to window.despia, in the same order, at the same
// time, with the same resolved values and console output.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, CURRENT, RELEASE_1_0_28, DESPIA_UA, BROWSER_UA } = require('./helpers');

// The fake app: answers some legacy commands by writing window variables.
function nativeApp(transcript, clock) {
  return (command, win) => {
    transcript.push(['command', clock().now, command]);
    const later = (ms, fn) => win.setTimeout(fn, ms);
    if (command === 'getappversion://') {
      later(250, () => { win.versionNumber = '2.4.1'; });
      later(1700, () => { win.bundleNumber = '381'; });
    } else if (command === 'readvault://?key=sessionToken') {
      later(40, () => { win.sessionToken = 'n/a'; });
      later(400, () => { win.sessionToken = 'abc123'; });
    } else if (command === 'getpurchasehistory://') {
      later(10, () => { win.restoredData = []; });
      later(500, () => { win.restoredData = [{ isActive: true, entitlementId: 'premium' }]; });
    } else if (command === 'checkNativePushPermissions://') {
      later(30, () => { win.nativePushEnabled = null; });
    } else if (command === 'getclipboard://') {
      later(120, () => { win.clipboarddata = { text: 'hello' }; });
    }
  };
}

const TRICKY = [
  'lighthaptic://',
  'sendlocalpushmsg://push.send?s=60&msg=Hello&!#Title&!#https://myapp.com',
  'shareapp://message?=Check%20this%20out&url=https://myapp.com',
  'statusbarcolor://{255, 255, 255}',
  'setvault://?key=k&value=' + 'é✓🚀"\'<>\\\n\t\u0000 ' + '&locked=true',
  'appsflyer://log_event?event_name=af_purchase&event_values=' + encodeURIComponent(JSON.stringify({ af_revenue: 9.99 })),
  'x'.repeat(100000) + '://',
  '',
  'mycustom://'
];

async function scenario(env, transcript) {
  const { despia, win, clock } = env;
  const record = (label, value) => transcript.push([label, clock.now, value]);
  const settle = (label, promise) => promise.then((v) => record(label, plain(v)));

  // Shape of the export.
  record('typeof', typeof despia);
  record('length', despia.length);
  record('name', despia.name);
  record('keys', Object.keys(despia));
  record('then', despia.then);
  record('symbol', typeof despia[Symbol.toPrimitive]);

  // despia.<var> reads window variables.
  win.appsFlyerUID = 'af-uid-1';
  win.appsFlyerAttribution = { media_source: 'tiktok' };
  record('window var', despia.appsFlyerUID);
  record('window object var', plain(despia.appsFlyerAttribution));
  record('missing var', despia.notSetAnywhere);
  record('navigator passthrough', despia.navigator === win.navigator);

  // Fire-and-forget commands, including odd strings and non-strings.
  const fired = TRICKY.map((cmd) => despia(cmd));
  fired.push(despia(42), despia(undefined), despia('withEmptyWatch://', []), despia('withNullWatch://', null));
  fired.push(despia.apply(null, ['viaApply://']), despia.call(null, 'viaCall://'));
  record('fire-and-forget results', (await Promise.all(fired)).map((v) => v === undefined));

  // Watched variables: single, stale, "n/a", empty, null, multi.
  win.sessionToken = 'stale-token';
  const pending = [
    settle('version (single)', despia('getappversion://', ['versionNumber'])),
    settle('vault read', despia('readvault://?key=sessionToken', ['sessionToken'])),
    settle('purchase history', despia('getpurchasehistory://', ['restoredData'])),
    settle('push permission null', despia('checkNativePushPermissions://', ['nativePushEnabled'])),
    settle('clipboard', despia('getclipboard://', ['clipboarddata']))
  ];
  await clock.tick(3000);
  await Promise.all(pending);

  const multi = settle('version (multi)', despia('getappversion://', ['versionNumber', 'bundleNumber']));
  await clock.tick(5000);
  await multi;

  // Timeouts: single variable after 30 s, multiple after 5 minutes.
  win.uuid = 'stale-uuid';
  const single = settle('uuid timeout', despia('get-uuid://', ['uuid']));
  const both = settle('multi timeout', despia('never://', ['neverA', 'neverB']));
  await clock.tick(29900);
  record('uuid still pending at 29.9s', transcript.some((t) => t[0] === 'uuid timeout'));
  await clock.tick(300000);
  await Promise.all([single, both]);

  record('stale var cleared', win.uuid);
  record('console.error', env.consoleErrors.slice());
}

async function runAgainst(file, opts = {}) {
  const transcript = [];
  let env;
  env = loadSdk(Object.assign({ file, onCommand: nativeApp(transcript, () => env.clock) }, opts));
  await scenario(env, transcript);
  return { transcript, env };
}

test('legacy despia() is byte-for-byte identical to 1.0.28 inside the app', async () => {
  const before = await runAgainst(RELEASE_1_0_28, { userAgent: DESPIA_UA });
  const after = await runAgainst(CURRENT, { userAgent: DESPIA_UA });

  assert.deepStrictEqual(after.transcript, before.transcript);
  assert.deepStrictEqual(after.env.commands, before.env.commands);

  // Sanity: the scenario exercised what it claims to.
  const commands = before.env.commands;
  assert.deepStrictEqual(commands.slice(0, TRICKY.length), TRICKY);
  assert.ok(commands.includes(42) && commands.includes(undefined));
  const results = Object.fromEntries(before.transcript.map(([label, , value]) => [label, value]));
  assert.deepStrictEqual(results['version (single)'], { versionNumber: '2.4.1' });
  assert.deepStrictEqual(results['vault read'], { sessionToken: 'abc123' });
  assert.deepStrictEqual(results['push permission null'], { nativePushEnabled: null });
  assert.deepStrictEqual(results['version (multi)'], { versionNumber: '2.4.1', bundleNumber: '381' });
  assert.deepStrictEqual(results['uuid timeout'], {});
  assert.deepStrictEqual(results['multi timeout'], {});
  assert.equal(results['uuid still pending at 29.9s'], false);
});

test('legacy despia() is identical to 1.0.28 in a plain browser', async () => {
  const before = await runAgainst(RELEASE_1_0_28, { userAgent: BROWSER_UA });
  const after = await runAgainst(CURRENT, { userAgent: BROWSER_UA });
  assert.deepStrictEqual(after.transcript, before.transcript);
});

test('legacy despia() ignores the new JSON bridge even when it is present', async () => {
  const bridges = {
    userAgent: DESPIA_UA,
    ios: () => assert.fail('legacy call reached the iOS JSON bridge'),
    android: () => assert.fail('legacy call reached the Android JSON bridge')
  };
  const before = await runAgainst(RELEASE_1_0_28, { userAgent: DESPIA_UA });
  const after = await runAgainst(CURRENT, bridges);
  assert.deepStrictEqual(after.transcript, before.transcript);
  assert.equal(after.env.posted.length, 0);
});

test('script-tag build still assigns the SDK to window.despia as 1.0.28 did', async () => {
  for (const file of [RELEASE_1_0_28, CURRENT]) {
    const env = loadSdk({ file, mode: 'global', userAgent: DESPIA_UA });
    assert.equal(env.commands.length, 1);
    assert.equal(typeof env.commands[0], 'function');
    env.despia('lighthaptic://');
    assert.deepStrictEqual(env.commands.slice(1), ['lighthaptic://']);
  }
});

test('new members are hidden from enumeration, as the 1.0.28 export had none', () => {
  const env = loadSdk({});
  assert.deepStrictEqual(Object.keys(env.despia), []);
  assert.deepStrictEqual(Object.keys(loadSdk({ file: RELEASE_1_0_28 }).despia), []);
  for (const name of ['haptics', 'vault', 'device', 'revenuecat', 'gps', 'on', 'legacy', 'DespiaError']) {
    assert.ok(name in env.despia, name);
  }
});

test('despia.legacy.variable reads injected window variables', () => {
  const env = loadSdk({ userAgent: DESPIA_UA });
  env.win.appsFlyerReferrer = 'ref-1';
  assert.equal(env.despia.legacy.variable('appsFlyerReferrer'), 'ref-1');
  assert.equal(env.despia.legacy.variable('appsFlyerReferrer'), env.despia.appsFlyerReferrer);
  assert.equal(env.despia.legacy.variable('missing'), undefined);
  assert.equal(loadSdk({ noWindow: true }).despia.legacy.variable('x'), undefined);
});

test('new namespace names do not shadow documented window variables or browser globals', () => {
  const env = loadSdk({});
  const added = Object.getOwnPropertyNames(env.despia).filter(
    (n) => !Object.getOwnPropertyNames(loadSdk({ file: RELEASE_1_0_28 }).despia).includes(n)
  );
  const documentedVars = [
    'appsFlyerAttribution', 'appsFlyerReferrer', 'appsFlyerUID', 'versionNumber', 'bundleNumber',
    'uuid', 'contacts', 'clipboarddata', 'cdnItems', 'restoredData', 'sessionToken',
    'nativePushEnabled', 'locationSession', 'healthkitResponse', 'storeLocation', 'trackingDisabled',
    'onRevenueCatPurchase', 'onLocationChange', 'contentServerChange'
  ];
  const browserGlobals = [
    'location', 'history', 'navigator', 'screen', 'document', 'window', 'self', 'top', 'parent',
    'frames', 'name', 'status', 'origin', 'external', 'crypto', 'performance', 'caches', 'event',
    'length', 'opener', 'closed', 'localStorage', 'sessionStorage', 'indexedDB', 'visualViewport'
  ];
  for (const name of added) {
    assert.ok(!documentedVars.includes(name), name + ' collides with a documented variable');
    assert.ok(!browserGlobals.includes(name), name + ' collides with a browser global');
  }
});
