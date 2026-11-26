'use strict';

// The shipped index.js matches src/, and the routes.json generator emits the
// same feature map that is hand-written today.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { ROOT } = require('./helpers');
const { build } = require('../scripts/build');
const { generate, readRoutes } = require('../scripts/generate-features');
const handWritten = require('../src/features');

const ROUTES = path.join(__dirname, 'fixtures', 'routes');
const routeFiles = fs.readdirSync(ROUTES).map((f) => path.join(ROUTES, f));

test('index.js is the current build of src/', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'), build());
});

test('src/ modules run directly under Node and match the bundle', () => {
  const direct = require('../src/index');
  const bundled = require('../index');
  for (const name of ['haptics', 'vault', 'device', 'revenuecat', 'gps']) {
    assert.deepEqual(Object.keys(direct[name]), Object.keys(bundled[name]));
  }
});

test('generator: runtime table equals the hand-written one for the same features', () => {
  const { runtime } = generate(readRoutes(routeFiles));
  assert.deepEqual(Object.keys(runtime).sort(), ['gps', 'haptics', 'vault']);
  for (const feature of Object.keys(runtime)) {
    assert.deepStrictEqual(runtime[feature], handWritten[feature], feature);
  }
});

test('generator: emitted JS loads and emitted types equal the hand-written types', () => {
  const { dts, js } = generate(readRoutes(routeFiles));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'despia-gen-'));
  try {
    fs.writeFileSync(path.join(dir, 'features.js'), js);
    assert.deepStrictEqual(require(path.join(dir, 'features.js')).vault, handWritten.vault);

    fs.writeFileSync(path.join(dir, 'generated.d.ts'), dts);
    const handPath = path.join(ROOT, 'features').split(path.sep).join('/');
    fs.writeFileSync(path.join(dir, 'check.ts'), [
      "import type { DespiaFeatureMap as Gen } from './generated';",
      `import type { DespiaFeatureMap as Hand } from '${handPath}';`,
      'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
      "export const haptics: Equal<Gen['haptics'], Hand['haptics']> = true;",
      "export const vault: Equal<Gen['vault'], Hand['vault']> = true;",
      "export const gps: Equal<Gen['gps'], Hand['gps']> = true;",
      ''
    ].join('\n'));
    const program = ts.createProgram([path.join(dir, 'check.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2019, types: [],
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler
    });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    assert.deepEqual(diagnostics, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generator: rejects names that would collide with the SDK', () => {
  const run = (route) => () => generate([{ file: 'x.json', route }]);
  assert.throws(run({ feature: 'on', actions: {} }), /reserved/);
  assert.throws(run({ feature: 'legacy', actions: {} }), /reserved/);
  assert.throws(run({ feature: 'call', actions: {} }), /reserved/);
  assert.throws(run({ feature: 'gps', actions: { on: {} } }), /reserved/);
  assert.throws(run({ feature: 'bad-name', actions: {} }), /invalid "feature"/);
  assert.throws(run({ feature: 'gps', actions: { start: { params: { a: { type: 'float' } } } } }), /unknown type/);
  assert.throws(() => generate([
    { file: 'a.json', route: { feature: 'gps', actions: {} } },
    { file: 'b.json', route: { feature: 'gps', actions: {} } }
  ]), /defined twice/);
});
