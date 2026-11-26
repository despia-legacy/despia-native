'use strict';

// Type tests for what the shipped catalog does not contain: job actions,
// request actions with file refs, and the typed callbacks. The generated
// types of the fixture catalog are compiled together with index.d.ts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');
const { ROOT, FIXTURE_CATALOG } = require('./helpers');
const { generate, readCatalogs } = require('../scripts/generate-features');

function compile(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'despia-types-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'index.d.ts'), path.join(dir, 'index.d.ts'));
    fs.writeFileSync(path.join(dir, 'features.d.ts'), generate(readCatalogs([FIXTURE_CATALOG])).dts);
    fs.writeFileSync(path.join(dir, 'check.ts'), source);
    const program = ts.createProgram([path.join(dir, 'check.ts')], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2019, lib: ['lib.es2019.d.ts', 'lib.dom.d.ts'],
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: []
    });
    return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('types: job actions, callbacks, Job handle and file refs', () => {
  const diagnostics = compile(`
    import despia, { FileRef, Job, JobDone, Outcome } from './index';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    function assertType<T extends true>(): void {}

    export async function jobs(input: FileRef): Promise<void> {
      const job = await despia.ffmpeg.run({ input }, {
        progress: (d) => { const p: number = d.percent; const id: string = d.jobId; void p; void id; },
        log: (d) => { const l: 'info' | 'warn' = d.level; void l; },
        done: (d) => { const files: FileRef[] | undefined = d.outputs; const ok: boolean = d.ok; void files; void ok; },
        error: (e) => { const c: string = e.code; const id: string = e.jobId; void c; void id; }
      });
      const id: string = job.id;
      const done = await job.result();
      const st: string = done.status;
      const first: FileRef | undefined = done.outputs?.[0];
      void st;
      const cancelled = await job.cancel();
      const state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' = cancelled.state;
      await job.ack(3);
      const off = job.on('progress', (d) => void d, { since: 'all' });
      off();
      const typed: Job<JobDone & { outputs?: FileRef[] }> = job;
      void id; void first; void state; void typed;

      await despia.ffmpeg.run({ input }, undefined, { signal: new AbortController().signal });

      // @ts-expect-error: input is required
      await despia.ffmpeg.run({});
      // @ts-expect-error: unknown callback event
      await despia.ffmpeg.run({ input }, { nope: () => {} });
      // @ts-expect-error: progress data has percent, not pct
      await despia.ffmpeg.run({ input }, { progress: (d) => d.pct });
      // @ts-expect-error: preset is an enum
      await despia.ffmpeg.run({ input, preset: 'huge' });
    }

    export async function requests(input: FileRef): Promise<void> {
      const picked: FileRef | null = await despia.media.pick({ kind: 'image', from: input });
      const note = await despia.notes.get({ id: '1' }, { signal: new AbortController().signal });
      const text: string = note.text;
      const found: string[] = await despia.notes.search({ query: 'x' });
      void picked; void text; void found;
      // @ts-expect-error: kind is an enum
      await despia.media.pick({ kind: 'audio' });
      // @ts-expect-error: a request action takes no callbacks
      await despia.notes.search({ query: 'x' }, { done: () => {} });
    }

    export async function spellings(): Promise<void> {
      await despia.notes.setExpiry({ id: '1', seconds: 5 });
      await despia.notes.set_expiry({ id: '1', seconds: 5 });
      await despia.media.embeddedHide();
      await despia.media.embedded_hide({ animated: false });
      type Same = Equal<Parameters<typeof despia.notes.setExpiry>, Parameters<typeof despia.notes.set_expiry>>;
      assertType<Same>();
      // @ts-expect-error: seconds is required under either spelling
      await despia.notes.setExpiry({ id: '1' });
      // @ts-expect-error: seconds is required under either spelling
      await despia.notes.set_expiry({ id: '1' });
    }

    export function events(): void {
      despia.ffmpeg.on('progress', (d) => { const p: number = d.percent; void p; }, { jobId: 'j-1', since: 4 });
      despia.ffmpeg.on('done', (d) => { const ok: boolean = d.ok; void ok; });
      // @ts-expect-error: not an event of ffmpeg
      despia.ffmpeg.on('finished', () => {});
    }

    assertType<Equal<ReturnType<typeof despia.ffmpeg.run>, Promise<Job<JobDone & { jobId: string; outputs?: FileRef[] }, Outcome & { outputs?: FileRef[] }>>>>();
  `);
  assert.deepEqual(diagnostics, []);
});

test('types: the native object, Hello and statuses carry the 1.1 fields and no internal ones', () => {
  const diagnostics = compile(`
    import despia, { Hello, FeatureStatus, ErrorCode, DespiaBridgeNative } from './index';
    const hello: Hello = {
      v: 1, platform: 'ios', contract: '1.1', origin: 'local_app',
      features: { a: { version: '1.0.0', actions: ['x'], events: [], dependencies: { b: '^1.0.0' } } },
      limits: { maxMessageBytes: 1, maxInFlight: 1 }
    };
    const status: FeatureStatus = {
      installed: true, active: true, permissions: {}, dependencies: { b: 'not_installed', c: 'disabled', d: 'installed' }
    };
    const codes: ErrorCode[] = ['undeclared_dependency', 'not_in_app', 'aborted', 'timeout', 'some_feature_code'];
    declare const native: DespiaBridgeNative;
    native.call('ffmpeg', 'run', {}, { timeoutMs: 5000 });
    native.call('ffmpeg', 'run');
    void hello; void status; void codes; void despia;
    // @ts-expect-error: contract is "1.1"
    const bad: Hello['contract'] = '2.0';
    // @ts-expect-error: origin is web or local_app
    const worse: Hello['origin'] = 'file';
    // @ts-expect-error: not a documented Hello field
    hello.extra;
    // @ts-expect-error: not a documented field of the native object
    native.extra;
    void bad; void worse;
  `);
  assert.deepEqual(diagnostics, []);
});

test('types: outcome actions resolve a union of statuses; job.result is an awaitable outcome', () => {
  const diagnostics = compile(`
    import despia, { FileRef } from './index';
    type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    function assertType<T extends true>(): void {}

    export async function outcomes(input: FileRef): Promise<void> {
      const shot = await despia.media.capture({ camera: 'back' });
      if (shot.status === 'success') {
        const file: FileRef = shot.file;
        void file;
      } else {
        const only: 'cancelled' = shot.status;
        void only;
      }
      const scan = await despia.media.scan();
      const kind: 'scanned' | 'cancelled' = scan.status;
      void kind;
      // @ts-expect-error: failed is not a declared status
      const bad: typeof shot.status = 'failed';
      void bad;

      const job = await despia.ffmpeg.transcode({ input }, {
        done: (d) => { const s: 'success' | 'cancelled' | 'navigated' | 'failed' = d.status; void s; },
        error: (e) => void e.code
      });
      const viaProperty = await job.result;
      const viaCall = await job.result();
      assertType<Equal<typeof viaProperty, typeof viaCall>>();
      if (viaProperty.status === 'success') {
        const out: FileRef = viaProperty.output;
        void out;
      }
      // @ts-expect-error: failed rejects, it is not an outcome status
      const nope: typeof viaProperty.status = 'failed';
      void nope;
      const plain = await despia.ffmpeg.run({ input });
      const status: string = (await plain.result).status;
      void status;
    }
  `);
  assert.deepStrictEqual(diagnostics, []);
});
