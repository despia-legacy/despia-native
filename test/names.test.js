'use strict';

// Window variable names the SDK refuses: every name the apps' own lists
// refuse, the objects the apps put on the page, and the page's handler slots.

const test = require('node:test');
const assert = require('node:assert/strict');
const { jsNameOK } = require('../src/names');
const { loadSdk, DESPIA_UA } = require('./helpers');
const lists = require('./fixtures/reserved-names.json');

test('names: every reserved name of both apps is refused', () => {
  const all = [].concat(lists.ios, lists.android, lists.objects);
  all.forEach((name) => assert.equal(jsNameOK(name), false, name + ' must be refused'));
});

test('names: handler slots and Object.prototype members are refused', () => {
  ['onerror', 'onclick', 'onanything', 'toString', 'valueOf', 'toJSON', '__lookupGetter__'].forEach((name) => {
    assert.equal(jsNameOK(name), false, name);
  });
  ['sessionToken', 'total', 'on', 'locationSession', 'uuid'].forEach((name) => assert.equal(jsNameOK(name), true, name));
});

function legacyApp(setup) {
  const env = loadSdk({ file: undefined, fixture: true, userAgent: DESPIA_UA });
  setup(env.win);
  return env;
}

test('names: the apps\' own channels survive a hostile vault key', async () => {
  const env = legacyApp((win) => {
    win.AndroidVirtual = { dispatch() {} };
    win.onerror = function handler() {};
    win.toString = function toString() { return 'w'; };
  });
  for (const key of ['AndroidVirtual', 'onerror', 'toString']) {
    await assert.rejects(env.despia.vault.get({ key }), { code: 'bad_args', path: 'args.key' });
  }
  assert.deepStrictEqual(env.commands, []);
  assert.equal(typeof env.win.AndroidVirtual.dispatch, 'function');
  assert.equal(typeof env.win.onerror, 'function');
  assert.equal(typeof env.win.toString, 'function');
});

test('names: a key that already holds a function or an object on the page is refused', async () => {
  const env = legacyApp((win) => {
    win.someHostObject = { live: true };
    win.someHelper = function helper() {};
  });
  await assert.rejects(env.despia.vault.get({ key: 'someHostObject' }), { code: 'bad_args', path: 'args.key' });
  await assert.rejects(env.despia.vault.get({ key: 'someHelper' }), { code: 'bad_args', path: 'args.key' });
  assert.deepStrictEqual(env.commands, []);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(env.win.someHostObject)), { live: true });
  assert.equal(typeof env.win.someHelper, 'function');
});
