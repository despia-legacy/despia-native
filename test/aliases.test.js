'use strict';

// Actions are snake_case on the wire; the SDK exposes each one in camelCase
// as well as under its wire spelling.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, ok, DESPIA_UA } = require('./helpers');
const { generate, camelCase } = require('../scripts/generate-features');

const nativeCalls = (env) => env.calls.filter((c) => c.feature !== 'bridge');
const catalogWith = (actions, extra) => [{ file: 'c.json', catalog: { features: { feat: Object.assign({ actions, events: {} }, extra) } } }];
const req = (extra) => Object.assign({ kind: 'request', args: {} }, extra);

test('camelCase: the segment after each underscore is capitalised', () => {
  assert.equal(camelCase('set_expiry'), 'setExpiry');
  assert.equal(camelCase('embedded_hide'), 'embeddedHide');
  assert.equal(camelCase('a_b_c'), 'aBC');
  assert.equal(camelCase('get'), 'get');
  assert.equal(camelCase('app_version'), 'appVersion');
});

test('both spellings reach the same wire call, which carries the snake_case name', async () => {
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA, bridge: () => ok({}) });
  await env.despia.notes.setExpiry({ id: '1', seconds: 5 });
  await env.despia.notes.set_expiry({ id: '1', seconds: 5 });
  await env.despia.media.embeddedHide({ animated: true });
  await env.despia.media.embedded_hide({ animated: true });
  assert.deepStrictEqual(nativeCalls(env).map((c) => [c.feature, c.action, c.args]), [
    ['notes', 'set_expiry', { id: '1', seconds: 5 }],
    ['notes', 'set_expiry', { id: '1', seconds: 5 }],
    ['media', 'embedded_hide', { animated: true }],
    ['media', 'embedded_hide', { animated: true }]
  ]);
  assert.equal(env.despia.notes.setExpiry, env.despia.notes.set_expiry, 'one function behind both names');
});

test('both spellings use the same legacy URL when the bridge is not there', async () => {
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA });
  await env.despia.notes.setExpiry({ id: '1', seconds: 5 });
  await env.despia.notes.set_expiry({ id: '1', seconds: 5 });
  await env.clock.tick(5);
  assert.deepStrictEqual(env.commands, [
    'extension://notes/set_expiry?id=1&seconds=5',
    'extension://notes/set_expiry?id=1&seconds=5'
  ]);
});

test('a single-word action is unchanged and gets no alias', async () => {
  const { runtime } = generate(catalogWith({ get: req(), set_expiry: req() }));
  assert.equal('alias' in runtime.feat.actions.get, false);
  assert.equal(runtime.feat.actions.set_expiry.alias, 'setExpiry');
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA, bridge: () => ok({}) });
  assert.deepStrictEqual(Object.keys(env.despia.notes).sort(), ['get', 'on', 'search', 'setExpiry', 'set_expiry']);
});

test('SDK words still win: a feature namespace keeps its own on()', () => {
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA, bridge: () => ok({}) });
  assert.equal(typeof env.despia.notes.on, 'function');
  env.win.setExpiry = 'window-value';
  assert.equal(typeof env.despia.notes.setExpiry, 'function');
});

test('generator: two actions whose camelCase forms collide are refused, naming both', () => {
  assert.throws(() => generate(catalogWith({ a_1b: req(), a1b: req() })),
    (err) => /feat/.test(err.message) && /a_1b/.test(err.message) && /a1b/.test(err.message) && /camelCase/.test(err.message));
});

test('generator: names that could not be camelCased cleanly are refused', () => {
  assert.throws(() => generate(catalogWith({ set__expiry: req() })), /trailing or doubled/);
  assert.throws(() => generate(catalogWith({ set_: req() })), /trailing or doubled/);
  assert.throws(() => generate(catalogWith({ _set: req() })), /invalid action name/);
  assert.throws(() => generate(catalogWith({ '1set': req() })), /invalid action name/);
});

test('generator: an action that would take over on() is refused', () => {
  assert.throws(() => generate(catalogWith({ on: req() })), /reserved/);
  assert.throws(() => generate(catalogWith({ then: req() })), /reserved/);
});

test('types: both spellings are typed and documented once in camelCase', () => {
  const { dts } = generate(catalogWith({ set_expiry: req({ description: 'Set it.' }) }));
  assert.match(dts, /\/\*\*\n\s+\* Set it\.\n\s+\* Wire name: `set_expiry`\.\n\s+\*\/\n\s+setExpiry: \{/);
  assert.match(dts, /\/\*\* Same as `setExpiry`\. \*\/\n\s+set_expiry: \{/);
});
