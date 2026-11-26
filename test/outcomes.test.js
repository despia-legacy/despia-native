'use strict';

// Outcome actions: a call that ends once resolves { status, ...payload },
// a user cancel is a status, only a real failure rejects. Jobs end the same
// way through job.result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { loadSdk, plain, outcome, ok, fail, DESPIA_UA, FIXTURE_CATALOG } = require('./helpers');
const { generate } = require('../scripts/generate-features');

const FILE = { url: 'https://files.invalid/a', name: 'a.jpg', type: 'image/jpeg', size: 1 };

function bridgeApp(handler) {
  return loadSdk({ fixture: true, userAgent: DESPIA_UA, bridge: (call) => {
    const reply = handler(call);
    if (reply !== undefined) return reply;
    if (call.feature === 'ffmpeg' && call.action === 'transcode') return ok({ jobId: 'j-1' });
    if (call.feature === 'bridge') return ok({});
  } });
}

// ---- request actions -------------------------------------------------------

test('outcome: a status in the reply is passed through; a cancel resolves', async () => {
  const env = bridgeApp((call) => {
    if (call.action === 'capture') return ok(call.args.camera === 'front' ? { status: 'cancelled' } : { status: 'success', file: FILE, width: 4 });
  });
  assert.deepStrictEqual(plain(await env.despia.media.capture({ camera: 'back' })), { status: 'success', file: FILE, width: 4 });
  assert.deepStrictEqual(plain(await env.despia.media.capture({ camera: 'front' })), { status: 'cancelled' });
});

test('outcome: plain data gets the default status; an empty value is just the status', async () => {
  const env = bridgeApp((call) => {
    if (call.action === 'capture') return ok({ file: FILE });
    if (call.action === 'scan') return ok(null);
  });
  assert.deepStrictEqual(plain(await env.despia.media.capture()), { status: 'success', file: FILE });
  assert.deepStrictEqual(plain(await env.despia.media.scan()), { status: 'scanned' });
});

test('outcome: a real failure still rejects with DespiaError', async () => {
  const env = bridgeApp((call) => (call.action === 'capture' ? fail('permission_denied', 'no camera access') : undefined));
  await assert.rejects(env.despia.media.capture(), (err) => {
    assert.ok(err instanceof env.despia.DespiaError);
    assert.equal(err.code, 'permission_denied');
    return true;
  });
});

test('outcome: an action without returns keeps its plain result', async () => {
  const env = bridgeApp((call) => (call.action === 'search' ? ok(['a']) : undefined));
  assert.deepStrictEqual(plain(await env.despia.notes.search({ query: 'q' })), ['a']);
});

// ---- legacy path -----------------------------------------------------------

function legacyApp(answer) {
  return loadSdk({ fixture: true, userAgent: DESPIA_UA, onCommand: (command, win) => win.setTimeout(() => answer(command, win), 40) });
}

test('outcome legacy: the answer becomes the payload under the default status', async () => {
  const env = legacyApp((command, win) => {
    if (command.indexOf('extension://media/capture') === 0) win.captureResult = { ok: true, data: { file: FILE } };
    if (command.indexOf('scan://') === 0) win.scanResult = { text: 'hello' };
  });
  const capture = outcome(env.despia.media.capture({ camera: 'back' }));
  await env.clock.tick(500);
  assert.deepStrictEqual(plain(capture.value), { status: 'success', file: FILE });
  const scan = outcome(env.despia.media.scan());
  await env.clock.tick(500);
  assert.deepStrictEqual(plain(scan.value), { status: 'scanned', text: 'hello' });
});

test('outcome legacy: cancelWhen turns the named answer into a cancelled status', async () => {
  const env = legacyApp((command, win) => {
    if (command.indexOf('extension://media/capture') === 0) win.captureResult = { ok: false, error: 'closed', code: 'cancelled' };
    if (command.indexOf('scan://') === 0) win.scanResult = 'cancelled';
  });
  const capture = outcome(env.despia.media.capture());
  await env.clock.tick(500);
  assert.deepStrictEqual(plain(capture.value), { status: 'cancelled' });
  const scan = outcome(env.despia.media.scan());
  await env.clock.tick(500);
  assert.deepStrictEqual(plain(scan.value), { status: 'cancelled' });
});

test('outcome legacy: another error code still rejects', async () => {
  const env = legacyApp((command, win) => {
    win.captureResult = { ok: false, error: 'no camera', code: 'unavailable' };
  });
  const capture = outcome(env.despia.media.capture());
  await env.clock.tick(500);
  assert.equal(capture.error.code, 'unavailable');
});

// ---- jobs ------------------------------------------------------------------

const ev = (event, seq, data) => ({ feature: 'ffmpeg', event, jobId: 'j-1', seq, data: Object.assign({ jobId: 'j-1' }, data) });
const INPUT = FILE;

test('job outcome: status and payload resolve; jobId, ok and error are not part of it', async () => {
  const env = bridgeApp(() => undefined);
  const job = await env.despia.ffmpeg.transcode({ input: INPUT });
  env.emit(ev('done', 1, { ok: true, status: 'success', output: FILE }));
  assert.deepStrictEqual(plain(await job.result()), { status: 'success', output: FILE });
});

test('job outcome: a v1 done without status derives it', async () => {
  const cases = [
    [{ ok: true, output: FILE }, { status: 'success', output: FILE }],
    [{ ok: false, error: { code: 'cancelled', message: 'x' } }, { status: 'cancelled' }],
    [{ ok: false, error: { code: 'navigated', message: 'x' } }, { status: 'navigated' }]
  ];
  for (const [data, expected] of cases) {
    const env = bridgeApp(() => undefined);
    const job = await env.despia.ffmpeg.transcode({ input: INPUT });
    env.emit(ev('done', 1, data));
    assert.deepStrictEqual(plain(await job.result()), expected);
  }
});

test('job outcome: a cancel with an explicit status resolves, only failed rejects', async () => {
  let env = bridgeApp(() => undefined);
  let job = await env.despia.ffmpeg.transcode({ input: INPUT });
  env.emit(ev('done', 1, { ok: false, status: 'cancelled', error: { code: 'cancelled', message: 'x' } }));
  assert.deepStrictEqual(plain(await job.result()), { status: 'cancelled' });

  env = bridgeApp(() => undefined);
  job = await env.despia.ffmpeg.transcode({ input: INPUT });
  env.emit(ev('done', 1, { ok: false, status: 'failed', error: { code: 'handler_error', message: 'bad codec' } }));
  await assert.rejects(job.result(), { code: 'handler_error', message: 'bad codec' });

  env = bridgeApp(() => undefined);
  job = await env.despia.ffmpeg.transcode({ input: INPUT });
  env.emit(ev('done', 1, { ok: false }));
  await assert.rejects(job.result(), { code: 'internal' });
});

test('job outcome: done gets the status, error fires only for failed', async () => {
  const run = async (data) => {
    const env = bridgeApp(() => undefined);
    const dones = [];
    const errors = [];
    const job = await env.despia.ffmpeg.transcode({ input: INPUT }, {
      done: (d) => dones.push(d.status),
      error: (e) => errors.push(e.code)
    });
    env.emit(ev('done', 1, data));
    await job.result.then(() => {}, () => {});
    return { dones, errors };
  };
  assert.deepStrictEqual(await run({ ok: true }), { dones: ['success'], errors: [] });
  assert.deepStrictEqual(await run({ ok: false, error: { code: 'cancelled', message: 'c' } }), { dones: ['cancelled'], errors: [] });
  assert.deepStrictEqual(await run({ ok: false, status: 'failed', error: { code: 'handler_error', message: 'e' } }),
    { dones: ['failed'], errors: ['handler_error'] });
});

test('job.result works as a property and as a call, with one promise behind both', async () => {
  const env = bridgeApp(() => undefined);
  const job = await env.despia.ffmpeg.transcode({ input: INPUT });
  const viaProperty = outcome(Promise.resolve(job.result));
  const viaThen = outcome(job.result.then((o) => o));
  const viaCall = outcome(job.result());
  env.emit(ev('done', 1, { ok: true, output: FILE }));
  await Promise.all([viaProperty.done, viaThen.done, viaCall.done]);
  const expected = { status: 'success', output: FILE };
  assert.deepStrictEqual(plain(viaProperty.value), expected);
  assert.deepStrictEqual(plain(viaThen.value), expected);
  assert.deepStrictEqual(plain(viaCall.value), expected);
  assert.equal(job.result(), job.result(), 'the same memoised promise');
  assert.equal(await job.result.finally(() => {}).then((o) => o.status), 'success');
  assert.equal(await job.result.catch(() => 'never').then((o) => o.status), 'success');
  assert.equal((await job.result).status, 'success');
});

// ---- generator -------------------------------------------------------------

const catalog = (actions) => [{ file: 'c.json', catalog: { features: { tool: { actions, events: {} } } } }];
const statuses = (extra) => Object.assign({ success: {} }, extra);

test('generator: returns and result are mutually exclusive, and the error names the action', () => {
  assert.throws(() => generate(catalog({
    pick: { kind: 'request', args: {}, result: { type: 'string' }, returns: { statuses: statuses() } }
  })), /tool\.pick.*mutually exclusive/);
});

test('generator: failed and error cannot be declared statuses', () => {
  ['failed', 'error'].forEach((name) => {
    assert.throws(() => generate(catalog({
      go: { kind: 'request', args: {}, returns: { statuses: statuses({ [name]: {} }) } }
    })), /tool\.go.*cannot be a declared status/, name);
  });
});

test('generator: returns is checked for shape, names, payloads and default', () => {
  const run = (returns) => () => generate(catalog({ go: { kind: 'request', args: {}, returns } }));
  assert.throws(run({}), /needs a "statuses"/);
  assert.throws(run({ statuses: {} }), /at least one status/);
  assert.throws(run({ statuses: { Bad: {} } }), /invalid status name/);
  assert.throws(run({ statuses: statuses({ a: { data: { type: 'string' } } }) }), /must be an object schema/);
  assert.throws(run({ statuses: statuses({ a: { data: { type: 'object', properties: { status: { type: 'string' } } } } }) }), /own "status"/);
  assert.throws(run({ statuses: statuses(), default: 'nope' }), /not a declared status/);
  assert.throws(run({ statuses: { done: {} } }), /no "success" status/);
  run({ statuses: { done: {} }, default: 'done' })();
});

test('generator: cancelWhen needs a cancelled status and a way to recognise the answer', () => {
  const legacy = (cancelWhen) => ({ scheme: 'x', variable: 'v', answer: 'variable', cancelWhen });
  const run = (returns, cancelWhen) => () => generate(catalog({ go: { kind: 'request', args: {}, returns, legacy: legacy(cancelWhen) } }));
  assert.throws(run({ statuses: statuses() }, { code: 'cancelled' }), /declare a "cancelled" status/);
  assert.throws(run({ statuses: statuses({ cancelled: {} }) }, {}), /"code" string or an "equals" value/);
  run({ statuses: statuses({ cancelled: {} }) }, { equals: 'cancelled' })();
});

test('generator: reserved action words are refused in both spellings', () => {
  const words = ['on', 'off', 'once', 'then', 'catch', 'finally', 'constructor', 'prototype', 'to_string', 'value_of',
    'has_own_property', 'is_prototype_of', 'property_is_enumerable', 'to_locale_string'];
  words.forEach((name) => {
    assert.throws(() => generate(catalog({ [name]: { kind: 'request', args: {} } })), /reserved/, name);
  });
  generate(catalog({ set_expiry: { kind: 'request', args: {} } }));
});

test('generator: outcome types are a union per declared status', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE_CATALOG, 'utf8'));
  const { dts } = generate([{ file: 'f', catalog: fixture }]);
  assert.match(dts, /status: "success";\s+file: FileRef;/);
  assert.match(dts, /status: "cancelled";/);
});

test('job outcome: a done with status "error" is a failure and keeps its error', async () => {
  const env = bridgeApp(() => undefined);
  const dones = [];
  const errors = [];
  const job = await env.despia.ffmpeg.transcode({ input: INPUT }, {
    done: (d) => dones.push(d.status),
    error: (e) => errors.push(e.code)
  });
  env.emit(ev('done', 1, { ok: false, status: 'error', error: { code: 'handler_error', message: 'bad codec' } }));
  await assert.rejects(job.result(), { code: 'handler_error', message: 'bad codec' });
  assert.deepStrictEqual(dones, ['failed']);
  assert.deepStrictEqual(errors, ['handler_error']);
});

test('outcome: a reply whose status is failed or error rejects with its error', async () => {
  for (const status of ['failed', 'error']) {
    const env = bridgeApp((call) => (call.action === 'capture'
      ? ok({ status, error: { code: 'unavailable', message: 'no camera' } }) : undefined));
    await assert.rejects(env.despia.media.capture(), { code: 'unavailable', message: 'no camera' }, status);
  }
});

test('generator: unknown keys in returns and in a status entry are refused', () => {
  const run = (returns) => () => generate(catalog({ go: { kind: 'request', args: {}, returns } }));
  assert.throws(run({ statuses: statuses(), defualt: 'success' }), /unknown key "defualt"/);
  assert.throws(run({ statuses: statuses({ cancelled: { descripton: 'x' } }) }), /status "cancelled" has an unknown key "descripton"/);
  run({ statuses: statuses({ cancelled: { description: 'x' } }), default: 'success' })();
});

test('generator: job types always include cancelled and navigated, without a payload', () => {
  const { dts } = generate(catalog({
    go: { kind: 'job', args: {}, returns: { statuses: { success: { data: { type: 'object', properties: { out: { type: 'string', required: true } } } } } } }
  }));
  assert.match(dts, /outcome: \{\s+status: "success";\s+out: string;\s+\} \| \{\s+status: "cancelled";\s+\} \| \{\s+status: "navigated";/);
});
