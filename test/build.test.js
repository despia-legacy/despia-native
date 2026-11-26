'use strict';

// The shipped index.js and the generated feature files match their sources,
// and the generator accepts and refuses what it should.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, FIXTURE_CATALOG } = require('./helpers');
const { build } = require('../scripts/build');
const { generate, readCatalogs, RESERVED_FEATURES } = require('../scripts/generate-features');

const SHIPPED_CATALOG = path.join(ROOT, 'bridge-catalog.json');
const fixture = () => generate(readCatalogs([FIXTURE_CATALOG]));

// A one-feature catalog around `patch`.
function catalogWith(feature) {
  return [{ file: 'c.json', catalog: { features: feature } }];
}
const simple = (extra) => Object.assign({
  actions: { get: { kind: 'request', args: {}, legacy: { scheme: 'x', answer: 'none' } } },
  events: {}
}, extra);

test('index.js is the current build of src/', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'), build());
});

test('features.d.ts and src/features.js are the current output of bridge-catalog.json', () => {
  const { dts, js } = generate(readCatalogs([SHIPPED_CATALOG]));
  assert.equal(fs.readFileSync(path.join(ROOT, 'features.d.ts'), 'utf8'), dts);
  assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'features.js'), 'utf8'), js);
});

test('src/ modules run directly under Node and match the bundle', () => {
  const direct = require('../src/index');
  const bundled = require('../index');
  for (const name of ['haptics', 'vault', 'device', 'revenuecat', 'gps', 'on', 'ready', 'jobs', 'bridge', 'legacy']) {
    assert.equal(typeof direct[name], typeof bundled[name], name);
  }
  assert.deepEqual(Object.keys(direct.vault), Object.keys(bundled.vault));
});

test('generator: request actions with and without a legacy mapping', () => {
  const { runtime } = fixture();
  assert.deepStrictEqual(runtime.notes.actions.get, {
    kind: 'request',
    timeoutMs: 2000,
    legacy: {
      scheme: 'extension', host: 'notes', route: 'get',
      args: [{ arg: 'id', name: 'id', encoding: 'plain' }, { arg: 'tags', name: 'tags', encoding: 'json' }],
      variable: 'notesResult', callback: 'onNotes', answer: 'envelope'
    }
  });
  assert.deepStrictEqual(runtime.notes.actions.search, { kind: 'request' });
  assert.equal('legacy' in runtime.media.actions.pick, false);
  assert.equal(runtime.media.actions.pick.timeoutMs, 30000);
});

test('generator: a job action and its events', () => {
  const { runtime, dts } = fixture();
  assert.deepStrictEqual(runtime.ffmpeg.actions.run, { kind: 'job', events: ['progress', 'log', 'done'] });
  assert.deepStrictEqual(runtime.ffmpeg.events, ['progress', 'log', 'done']);
  assert.match(dts, /kind: 'job';/);
  assert.match(dts, /result: JobDone & \{/);
  assert.match(dts, /import type \{ FileRef, JobDone \} from '\.\/index';/);
});

test('generator: legacy arg names and encodings come from the catalog', () => {
  const { runtime } = generate(readCatalogs([SHIPPED_CATALOG]));
  assert.deepStrictEqual(runtime.revenuecat.actions.purchase.legacy.args, [
    { arg: 'externalId', name: 'external_id', encoding: 'plain' },
    { arg: 'product', name: 'product', encoding: 'plain' }
  ]);
  assert.equal(runtime.revenuecat.actions.purchase.legacy.host, 'purchase');
});

test('generator: emitted files never mention an internal field of the injected object', () => {
  for (const out of [fixture(), generate(readCatalogs([SHIPPED_CATALOG]))]) {
    assert.doesNotMatch(out.dts, /\bcap\b/);
    assert.doesNotMatch(out.js, /\bcap\b/);
  }
  for (const file of ['index.d.ts', 'features.d.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /\bcap\b/, file);
  }
});

test('generator: refuses the reserved feature ids', () => {
  for (const id of ['bridge', 'legacy', 'jobs', 'on', 'off', 'ready', 'version', 'call']) {
    assert.ok(RESERVED_FEATURES.has(id), id);
    assert.throws(() => generate(catalogWith({ [id]: simple() })), /reserved feature id/, id);
  }
  // Names that would collide with the function object itself.
  for (const id of ['then', 'apply', 'bind', 'length', 'name', 'prototype']) {
    assert.throws(() => generate(catalogWith({ [id]: simple() })), /reserved feature id/, id);
  }
});

test('generator: refuses malformed ids, action names, arg names and kinds', () => {
  const run = (feature, id = 'tool') => () => generate(catalogWith({ [id]: feature }));
  for (const bad of ['Tool', 'a', 'x'.repeat(33), 'bad-name', '1tool', 'tool__x', '_tool']) {
    assert.throws(run(simple(), bad), /invalid feature id/, bad);
  }
  assert.throws(run(simple({ actions: { Get: { kind: 'request', args: {} } } })), /invalid action name/);
  assert.throws(run(simple({ actions: { on: { kind: 'request', args: {} } } })), /reserved/);
  assert.throws(run(simple({ actions: { then: { kind: 'request', args: {} } } })), /reserved/);
  assert.throws(run(simple({ actions: { go: { kind: 'stream', args: {} } } })), /kind must be/);
  assert.throws(run(simple({ actions: { go: { kind: 'request', args: { Bad: { type: 'string', max: 1 } } } } })), /invalid arg name/);
  assert.throws(run(simple({ actions: { go: { kind: 'request', args: { a: { type: 'float' } } } } })), /unknown type/);
  assert.throws(run(simple({ actions: { go: { kind: 'request', args: { a: { type: 'enum' } } } } })), /enum needs/);
  assert.throws(run(simple({ events: { Bad: { scope: 'app', data: { type: 'object' } } } })), /invalid event name/);
  assert.throws(run(simple({ actions: { go: { kind: 'request', args: {}, legacy: { scheme: 'Bad Scheme', answer: 'none' } } } })), /legacy.scheme/);
  assert.throws(run(simple({ actions: { go: { kind: 'request', args: {}, legacy: { scheme: 'x', answer: 'variable' } } } })), /needs legacy.variable/);
  assert.throws(() => generate([{ file: 'c.json', catalog: {} }]), /missing "features"/);
});

test('generator: refuses a feature defined twice', () => {
  assert.throws(() => generate([
    { file: 'a.json', catalog: { features: { tool: simple() } } },
    { file: 'b.json', catalog: { features: { tool: simple() } } }
  ]), /defined twice/);
});

test('generator: asset paths with "." or ".." segments are refused', () => {
  const withAssets = (...files) => () => generate(catalogWith({ tool: simple({ assets: { files } }) }));
  withAssets('core.wasm', 'worker/ffmpeg.js', 'a/b/c.bin')();
  for (const bad of ['../core.wasm', 'a/../b.wasm', './core.wasm', 'a/./b', 'a/..', '..', '.', '/abs/core.wasm', 'a//b', 'a\\b', '']) {
    assert.throws(withAssets('ok.wasm', bad), /asset path/, JSON.stringify(bad));
  }
  assert.throws(() => generate(catalogWith({ tool: simple({ assets: { files: 'x' } }) })), /assets.files/);
});

test('generator CLI: --check passes on the shipped files and fails on a stale one', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const script = path.join(ROOT, 'scripts', 'generate-features.js');
  const okRun = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(okRun.status, 0, okRun.stderr);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'despia-gen-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'features.d.ts'), '// stale\n');
    fs.writeFileSync(path.join(dir, 'src', 'features.js'), '// stale\n');
    const stale = spawnSync(process.execPath, [script, '--check', '--out', dir, SHIPPED_CATALOG], { encoding: 'utf8' });
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /out of date/);
    const written = spawnSync(process.execPath, [script, '--out', dir, SHIPPED_CATALOG], { encoding: 'utf8' });
    assert.equal(written.status, 0, written.stderr);
    assert.equal(fs.readFileSync(path.join(dir, 'src', 'features.js'), 'utf8'),
      fs.readFileSync(path.join(ROOT, 'src', 'features.js'), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generator: a {name} in legacy.variable must name a declared string argument', () => {
  const action = (args, variable) => ({ kind: 'request', args, legacy: { scheme: 'x', variable, answer: 'variable' } });
  const run = (a) => () => generate(catalogWith({ tool: simple({ actions: { get: a } }) }));
  run(action({ key: { type: 'string', max: 8 } }, '{key}'))();
  assert.throws(run(action({}, '{key}')), /not a declared string argument/);
  assert.throws(run(action({ key: { type: 'int' } }, '{key}')), /not a declared string argument/);
});

test('generator: envelope and variable answers need a variable; timeoutMs and asset names are bounded', () => {
  const act = (extra) => ({ actions: { get: Object.assign({ kind: 'request', args: {} }, extra) } });
  assert.throws(() => generate(catalogWith({ tool: simple(act({ legacy: { scheme: 'x', answer: 'envelope' } })) })), /needs legacy.variable/);
  assert.throws(() => generate(catalogWith({ tool: simple(act({ timeoutMs: 50 })) })), /100 to 600000/);
  assert.throws(() => generate(catalogWith({ tool: simple(act({ timeoutMs: 700000 })) })), /100 to 600000/);
  generate(catalogWith({ tool: simple(act({ timeoutMs: 600000 })) }));
  assert.throws(() => generate(catalogWith({ tool: simple({ assets: { files: ['%2e%2e/x'] } }) })), /may only use/);
});
