'use strict';

// Window variable names the SDK refuses: every name the apps' own lists
// refuse, the objects the apps put on the page, and the page's handler slots.

const test = require('node:test');
const assert = require('node:assert/strict');
const { jsNameOK } = require('../src/names');
const { loadSdk, outcome, DESPIA_UA } = require('./helpers');
const lists = require('./fixtures/reserved-names.json');

test('names: every reserved name of both apps is refused', () => {
  const all = [].concat(lists.ios, lists.android, lists.objects).filter((n) => typeof n === 'string');
  all.forEach((name) => assert.equal(jsNameOK(name), false, name + ' must be refused'));
});

test('names: Object.prototype members are refused; ordinary keys are not', () => {
  ['onerror', 'onload', 'toString', 'valueOf', 'toJSON', '__lookupGetter__'].forEach((name) => {
    assert.equal(jsNameOK(name), false, name);
  });
  ['sessionToken', 'total', 'on', 'one', 'onboardingDone', 'online', 'locationSession', 'uuid'].forEach((name) => {
    assert.equal(jsNameOK(name), true, name);
  });
});

function legacyApp(setup, onCommand) {
  const env = loadSdk({ file: undefined, fixture: true, userAgent: DESPIA_UA, onCommand });
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

test('names: keys that merely start with "on" read like any other key', async () => {
  for (const key of ['onboardingDone', 'online', 'once', 'one']) {
    const env = legacyApp(() => {}, (command, win) => {
      win.setTimeout(() => { win[key] = 'yes'; }, 50);
    });
    const result = outcome(env.despia.vault.get({ key }));
    await env.clock.tick(2000);
    assert.equal(result.value, 'yes', key);
    assert.deepStrictEqual(env.commands, ['readvault://?key=' + key], key);
  }
});

test('names: real handler slots are still refused at run time', async () => {
  const env = legacyApp((win) => { win.onclick = null; win.onload = function load() {}; });
  await assert.rejects(env.despia.vault.get({ key: 'onclick' }), { code: 'bad_args', path: 'args.key' });
  await assert.rejects(env.despia.vault.get({ key: 'onload' }), { code: 'bad_args', path: 'args.key' });
  assert.deepStrictEqual(env.commands, []);
  assert.equal(typeof env.win.onload, 'function');
  assert.equal('onclick' in env.win, true);
});

test('names: getters and browser properties are not deleted', async () => {
  const env = legacyApp((win) => {
    Object.defineProperty(win, 'innerWidth', { get() { return 390; }, configurable: true });
    Object.defineProperty(win, 'pageGetter', { get() { return 'g'; }, configurable: true });
    Object.defineProperty(win, 'fixedValue', { value: 'v', configurable: false, writable: true });
  });
  for (const key of ['innerWidth', 'pageGetter', 'fixedValue']) {
    await assert.rejects(env.despia.vault.get({ key }), { code: 'bad_args', path: 'args.key' }, key);
  }
  assert.deepStrictEqual(env.commands, []);
  assert.equal(env.win.innerWidth, 390);
  assert.equal(env.win.pageGetter, 'g');
});

test('names: a value the app wrote earlier is cleared and read again', async () => {
  let answers = 0;
  const env = legacyApp(() => {}, (command, win) => {
    answers += 1;
    const value = 'fresh-' + answers;
    win.setTimeout(() => { win.sessionToken = value; }, 50);
  });
  const first = outcome(env.despia.vault.get({ key: 'sessionToken' }));
  await env.clock.tick(2000);
  assert.equal(first.value, 'fresh-1');
  assert.equal(env.win.sessionToken, 'fresh-1');
  const second = outcome(env.despia.vault.get({ key: 'sessionToken' }));
  await env.clock.tick(2000);
  assert.equal(second.value, 'fresh-2');
});
