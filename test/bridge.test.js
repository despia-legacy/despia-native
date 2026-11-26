'use strict';

// Request actions over window.despiaBridge: detection, replies, errors,
// timeouts, abort, the built-in actions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSdk, plain, outcome, ok, fail, HELLO, DESPIA_UA } = require('./helpers');

function app(handler, extra = {}) {
  return loadSdk(Object.assign({ fixture: true, userAgent: DESPIA_UA, bridge: handler }, extra));
}

const nativeCalls = (env) => env.calls.filter((c) => !(c.feature === 'bridge' && c.action === 'hello'));

test('request: resolves with the reply value', async () => {
  const env = app((call) => {
    if (call.feature === 'notes' && call.action === 'search') return ok(['a', 'b']);
  });
  assert.deepStrictEqual(plain(await env.despia.notes.search({ query: 'x' })), ['a', 'b']);
  assert.deepStrictEqual(nativeCalls(env).map((c) => [c.feature, c.action, c.args]),
    [['notes', 'search', { query: 'x' }]]);
});

test('request: args default to an empty object and the call takes exactly feature, action, args', async () => {
  const env = app(() => ok({ jobId: 'unused' }));
  await env.despia.bridge.status({ feature: 'media' });
  await env.despia.notes.search();
  const [status, search] = nativeCalls(env);
  assert.equal(status.argc, 3);
  assert.deepStrictEqual(search.args, {});
});

test('request: an error reply rejects with DespiaError {code, message, path}', async () => {
  const env = app(() => fail('bad_args', 'args.query: required', { path: 'args.query' }));
  await assert.rejects(env.despia.notes.search({}), (err) => {
    assert.ok(err instanceof env.despia.DespiaError);
    assert.equal(err.name, 'DespiaError');
    assert.equal(err.code, 'bad_args');
    assert.equal(err.message, 'args.query: required');
    assert.equal(err.path, 'args.query');
    return true;
  });
});

test('request: feature codes and codes without a path pass through unchanged', async () => {
  const env = app(() => fail('file_ref_unavailable', 'no resolver'));
  await assert.rejects(env.despia.media.pick({ kind: 'image' }), (err) => {
    assert.equal(err.code, 'file_ref_unavailable');
    assert.equal('path' in err, false);
    return true;
  });
});

test('request: args that are not a plain object reject with bad_args and never reach native', async () => {
  const env = app(() => ok(null));
  for (const bad of [[], 'x', 5, true]) {
    await assert.rejects(env.despia.notes.search(bad), { code: 'bad_args' });
  }
  assert.equal(nativeCalls(env).length, 0);
});

test('request: a malformed reply is an internal error', async () => {
  const env = app(() => ({ nonsense: true }));
  await assert.rejects(env.despia.notes.search({ query: 'q' }), { code: 'internal' });
});

test('request: the catalog timeoutMs goes to native as the fourth argument', async () => {
  const env = app(() => ok({ text: 't' }));
  await env.despia.notes.get({ id: '1' });         // timeoutMs 2000 in the catalog
  await env.despia.media.pick({ kind: 'image' });  // 30000
  await env.despia.notes.search({ query: 'q' });   // none declared
  const [get, pick, search] = nativeCalls(env);
  assert.deepStrictEqual(get.opts, { timeoutMs: 2000 });
  assert.equal(get.argc, 4);
  assert.deepStrictEqual(pick.opts, { timeoutMs: 30000 });
  assert.equal(search.opts, undefined);
  assert.equal(search.argc, 3);
});

test('request: the local guard waits timeoutMs + 5000, then rejects with timeout', async () => {
  const env = app((call) => (call.feature === 'notes' ? new Promise(() => {}) : undefined));
  const slow = outcome(env.despia.notes.get({ id: '1' })); // 2000 + 5000
  await env.clock.tick(6999);
  assert.equal(slow.settled, false);
  await env.clock.tick(2);
  assert.equal(slow.settled, true);
  assert.equal(slow.error.code, 'timeout');

  const dflt = outcome(env.despia.notes.search({ query: 'q' })); // default 10000 + 5000
  await env.clock.tick(14999);
  assert.equal(dflt.settled, false);
  await env.clock.tick(2);
  assert.equal(dflt.error.code, 'timeout');
});

test('request: a reply that arrives in time cancels the guard', async () => {
  const env = app(() => ok(1));
  await env.despia.notes.search({ query: 'q' });
  assert.equal(env.clock.pending(), 0);
});

test('request: AbortSignal rejects locally with aborted; native keeps running', async () => {
  let release;
  const env = app((call) => (call.feature === 'notes' ? new Promise((r) => { release = r; }) : undefined));
  const controller = new AbortController();
  const pending = outcome(env.despia.notes.search({ query: 'q' }, { signal: controller.signal }));
  await env.clock.tick(10);
  assert.equal(pending.settled, false);
  controller.abort();
  await env.clock.tick(0);
  assert.equal(pending.error.code, 'aborted');
  assert.ok(pending.error instanceof env.despia.DespiaError);
  release(ok(['late'])); // dropped, no unhandled rejection
  await env.clock.tick(0);
  assert.equal(env.clock.pending(), 0);

  const already = new AbortController();
  already.abort();
  const before = nativeCalls(env).length;
  await assert.rejects(env.despia.notes.search({ query: 'q' }, { signal: already.signal }), { code: 'aborted' });
  assert.equal(nativeCalls(env).length, before);
});

test('hello: only the documented fields reach the page', async () => {
  const hello = Object.assign({ extra: 'unlisted-value', contract: '1.1', origin: 'local_app' }, HELLO);
  const env = app(
    () => ok({ text: 'hi', echo: 1 }),
    { hello: () => ok(hello) }
  );
  const value = await env.despia.notes.get({ id: '1' });
  assert.deepStrictEqual(plain(value), { text: 'hi', echo: 1 });
  const ready = await env.despia.ready();
  assert.equal('extra' in ready.hello, false);
  assert.equal(JSON.stringify(ready).indexOf('unlisted-value'), -1);
  const viaBuiltin = await env.despia.bridge.hello();
  assert.equal('extra' in viaBuiltin, false);
  assert.equal(ready.hello.contract, '1.1');
  assert.equal(ready.hello.origin, 'local_app');
});

// ---- detection --------------------------------------------------------------

test('detection: hello is sent once per document, before the first call', async () => {
  const env = app(() => ok(['r']));
  await Promise.all([env.despia.notes.search({ query: 'a' }), env.despia.notes.search({ query: 'b' })]);
  await env.despia.notes.search({ query: 'c' });
  const hellos = env.calls.filter((c) => c.feature === 'bridge' && c.action === 'hello');
  assert.equal(hellos.length, 1);
  assert.equal(env.calls[0].action, 'hello');
  assert.equal(env.listeners.length, 1, 'one listen() subscription');
});

test('detection: nothing is sent at load time', () => {
  const env = app(() => ok(1));
  assert.equal(env.calls.length, 0);
});

test('ready: bridge present and hello ok', async () => {
  const env = app(() => undefined);
  const state = await env.despia.ready();
  assert.equal(state.bridge, true);
  assert.deepStrictEqual(plain(state.hello), plain(HELLO));
});

test('ready: no bridge object', async () => {
  const env = loadSdk({ fixture: true, userAgent: DESPIA_UA });
  assert.deepStrictEqual(plain(await env.despia.ready()), { bridge: false });
  const plainBrowser = loadSdk({ fixture: true });
  assert.deepStrictEqual(plain(await plainBrowser.despia.ready()), { bridge: false });
});

test('ready: hello refused means legacy-only for the document', async () => {
  const env = app(() => ok({ text: 'x' }), { hello: null });
  const state = await env.despia.ready();
  assert.deepStrictEqual(plain(state), { bridge: false });
  assert.equal(env.listeners.length, 0, 'does not listen when refused');
  // A feature call goes to the legacy path or is not installed; never to native.
  await assert.rejects(env.despia.media.pick({ kind: 'image' }), { code: 'feature_not_installed' });
  assert.equal(env.calls.filter((c) => c.feature !== 'bridge').length, 0);
});

test('ready: an object whose v is not 1, or without call/listen, is ignored', async () => {
  for (const make of [
    () => ({ v: 2, platform: 'ios', call() {}, listen() {} }),
    () => ({ v: 1, platform: 'ios', listen() {} }),
    () => ({ v: 1, platform: 'ios', call() {} })
  ]) {
    const env = loadSdk({ fixture: true, userAgent: DESPIA_UA });
    Object.defineProperty(env.win, 'despiaBridge', { value: make() });
    assert.deepStrictEqual(plain(await env.despia.ready()), { bridge: false });
  }
});

test('ready: a hello that never answers falls back to legacy after the guard', async () => {
  const env = app(() => ok(1), { hello: () => new Promise(() => {}) });
  const state = outcome(env.despia.ready());
  await env.clock.tick(14999);
  assert.equal(state.settled, false);
  await env.clock.tick(2);
  assert.deepStrictEqual(plain(state.value), { bridge: false });
});

test('ready: no window (server side) is not in the app', async () => {
  const env = loadSdk({ fixture: true, noWindow: true });
  assert.deepStrictEqual(plain(await env.despia.ready()), { bridge: false });
});

test('the SDK never uses the old transports', async () => {
  const env = app(() => ok(1));
  env.win.webkit = { messageHandlers: { despia: { postMessage: () => assert.fail('iOS message handler used') } } };
  env.win.despia_bridge = { postMessage: () => assert.fail('Android interface used') };
  await env.despia.notes.search({ query: 'q' });
});

// ---- built-in actions -----------------------------------------------------

test('despia.bridge.* reaches the built-in actions', async () => {
  const env = app((call) => {
    if (call.feature === 'bridge') {
      switch (call.action) {
        case 'status': return ok({ installed: true, active: true, permissions: { camera: 'granted' }, dependencies: { media: 'installed' } });
        case 'assets': return ok({ baseUrl: 'https://files.invalid/ffmpeg/' });
        case 'jobs': return ok({ jobs: [] });
        case 'job': return ok({ jobId: call.args.jobId, state: 'running' });
        case 'subscribe': return ok({ subscribed: true });
        case 'unsubscribe': return ok({});
        case 'cancel': return ok({ cancelled: true, state: 'cancelled' });
        case 'ack': return ok({});
      }
    }
  });
  const b = env.despia.bridge;
  assert.deepStrictEqual(plain(await b.status({ feature: 'media' })).dependencies, { media: 'installed' });
  assert.equal((await b.assets({ feature: 'ffmpeg' })).baseUrl, 'https://files.invalid/ffmpeg/');
  assert.deepStrictEqual(plain(await b.jobs({ feature: 'ffmpeg' })), { jobs: [] });
  assert.equal((await b.job({ jobId: 'j-1' })).state, 'running');
  assert.deepStrictEqual(plain(await b.subscribe({ feature: '*' })), { subscribed: true });
  assert.deepStrictEqual(plain(await b.unsubscribe({ feature: '*' })), {});
  assert.equal((await b.cancel({ jobId: 'j-1' })).cancelled, true);
  assert.deepStrictEqual(plain(await b.ack({ jobId: 'j-1', seq: 3 })), {});
  const sent = nativeCalls(env).map((c) => c.action);
  assert.deepStrictEqual(sent, ['status', 'assets', 'jobs', 'job', 'subscribe', 'unsubscribe', 'cancel', 'ack']);
  assert.deepStrictEqual(nativeCalls(env)[7].args, { jobId: 'j-1', seq: 3 });
  assert.deepStrictEqual(plain(await b.hello()).features.ffmpeg.actions, ['run']);
});

test('despia.bridge.*: native refusals surface unchanged; no bridge rejects', async () => {
  const refused = app(() => fail('forbidden_origin', 'no'), { hello: null });
  await assert.rejects(refused.despia.bridge.status({ feature: 'x' }), { code: 'forbidden_origin' });

  assert.equal(refused.calls.length, 1, 'only the hello reached native; the refusal is remembered');
  await assert.rejects(refused.despia.jobs.list(), { code: 'forbidden_origin' });
  assert.equal(refused.calls.length, 1);

  const old = loadSdk({ fixture: true, userAgent: DESPIA_UA });
  await assert.rejects(old.despia.bridge.hello(), { code: 'feature_not_installed' });
  const browser = loadSdk({ fixture: true });
  await assert.rejects(browser.despia.bridge.hello(), { code: 'not_in_app' });
});

test('despia.jobs: list, get and cancel go through the built-ins', async () => {
  const info = { jobId: 'j-1', feature: 'ffmpeg', action: 'run', state: 'running', scope: 'document', durable: true, createdAt: 1, updatedAt: 2, lastSeq: 4 };
  const env = app((call) => {
    if (call.action === 'jobs') return ok({ jobs: [info] });
    if (call.action === 'job') return call.args.jobId === 'j-1' ? ok(info) : fail('not_found', 'no job');
    if (call.action === 'cancel') return ok({ cancelled: false, state: 'done' });
  });
  assert.deepStrictEqual(plain(await env.despia.jobs.list({ feature: 'ffmpeg', states: ['running'] })), [info]);
  assert.deepStrictEqual(nativeCalls(env)[0].args, { feature: 'ffmpeg', states: ['running'] });
  assert.equal((await env.despia.jobs.get('j-1')).lastSeq, 4);
  await assert.rejects(env.despia.jobs.get('nope'), { code: 'not_found' });
  assert.deepStrictEqual(plain(await env.despia.jobs.cancel('j-1')), { cancelled: false, state: 'done' });
});
