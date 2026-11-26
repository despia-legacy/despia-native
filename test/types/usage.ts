// Compile-time checks for the typed API (`tsc -p test/types`).
// Lines marked @ts-expect-error must fail to type-check.

import despia, {
  DespiaArgs,
  DespiaError,
  DespiaOff,
  DespiaResult,
  ErrorCode,
  EventPacket,
  Hello,
  Job,
  JobInfo,
  Callbacks,
  FeatureStatus,
} from '../..';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(): void {}

async function typedCalls(): Promise<void> {
  // Results are typed per action.
  const nothing: void = await despia.haptics.light();
  const token: string = await despia.vault.get({ key: 'sessionToken' });
  const version = await despia.device.appVersion();
  const versionNumber: string = version.versionNumber;
  // Both spellings are typed; the wire name is the snake_case one.
  const sameVersion: { versionNumber: string; bundleNumber: string } = await despia.device.app_version();
  const storeA: string = await despia.device.storeLocation();
  const storeB: string = await despia.device.store_location();
  void sameVersion; void storeA; void storeB;
  const history = await despia.revenuecat.history();
  const active: boolean = history[0].isActive;
  void nothing; void token; void versionNumber; void active;

  // Optional-only args may be omitted.
  await despia.gps.start();
  await despia.gps.start({ buffer: 60, movement: 100 });
  await despia.revenuecat.paywall({ externalId: 'u1' });

  // @ts-expect-error: unknown action
  await despia.haptics.lihgt();
  // @ts-expect-error: required args missing
  await despia.vault.get();
  // @ts-expect-error: required key missing
  await despia.vault.set({ value: 'x' });
  // @ts-expect-error: wrong arg type
  await despia.vault.set({ key: 'k', value: 'v', locked: 'yes' });
  // @ts-expect-error: unknown arg
  await despia.gps.start({ bufer: 60 });
  // @ts-expect-error: no-arg action takes no args
  await despia.haptics.success({ strength: 1 });
  // @ts-expect-error: result is a string, not a number
  const n: number = await despia.vault.get({ key: 'k' });
  void n;

  assertType<Equal<DespiaArgs<'vault', 'get'>, { key: string }>>();
  assertType<Equal<DespiaResult<'device', 'uuid'>, string>>();
  assertType<Equal<DespiaResult<'device', 'appVersion'>, DespiaResult<'device', 'app_version'>>>();
}

function events(): void {
  const off: DespiaOff = despia.gps.on('change', (point) => {
    const lat: number = point.latitude;
    void lat;
  });
  off();

  despia.revenuecat.on('purchase', (data) => void data);

  // @ts-expect-error: unknown event
  despia.gps.on('moved', () => {});
  // @ts-expect-error: haptics has no events
  despia.haptics.on('change', () => {});

  // Options of a listener.
  despia.gps.on('change', () => {}, { since: 'all' });
  despia.gps.on('change', () => {}, { since: 3, jobId: 'j-1' });
  // @ts-expect-error: since is a number or 'all'
  despia.gps.on('change', () => {}, { since: 'some' });

  const offAll = despia.on((p: EventPacket) => {
    const where: string = p.feature + '.' + p.event;
    const replayed: true | undefined = p.replay;
    void where; void replayed;
  });
  offAll();
}

async function errors(): Promise<void> {
  try {
    await despia.vault.get({ key: 'k' });
  } catch (err) {
    if (err instanceof despia.DespiaError) {
      const e: DespiaError = err;
      const code: string = e.code;
      const known: ErrorCode = 'undeclared_dependency';
      if (e.code === 'not_in_app' || e.code === 'aborted') return;
      void code; void known;
    }
  }
}

async function legacyStillTyped(): Promise<void> {
  // The original form and its types are unchanged.
  const queued: void = await despia('lighthaptic://');
  const vars = await despia('getappversion://', ['versionNumber', 'bundleNumber']);
  const typedVars = await despia<{ uuid: string }>('get-uuid://', ['uuid']);
  const uuid: string = typedVars.uuid;
  const anyWindowVar = despia.appsFlyerUID;
  const injected = despia.legacy.variable<string>('appsFlyerUID');
  const maybe: string | undefined = injected;
  void queued; void vars; void uuid; void anyWindowVar; void maybe;
}

async function bridgeWords(): Promise<void> {
  const state = await despia.ready();
  if (state.hello) {
    const hello: Hello = state.hello;
    const contract: '1.1' | undefined = hello.contract;
    const origin: 'web' | 'local_app' | undefined = hello.origin;
    const deps: Record<string, string> | undefined = hello.features.x.dependencies;
    void contract; void origin; void deps;
  }
  const bridge: boolean = state.bridge;
  const list: JobInfo[] = await despia.jobs.list({ feature: 'x', states: ['running'] });
  const one: JobInfo = await despia.jobs.get('j-1');
  const cancelled = await despia.jobs.cancel('j-1');
  const status: FeatureStatus = await despia.bridge.status({ feature: 'x' });
  const dep: 'installed' | 'not_installed' | 'disabled' | undefined = status.dependencies?.y;
  const hello: Hello = await despia.bridge.hello();
  const offJob = despia.bridge.on('job', (info) => { const s: string = info.state; void s; });
  const max: 4194304 = despia.LIMITS.maxMessageBytes;
  const noop: Job | undefined = undefined;
  const cb: Callbacks = { progress: () => {}, done: () => {}, error: (e) => void e.jobId };
  const native: Window['despiaBridge'] = window.despiaBridge;
  void bridge; void list; void one; void cancelled; void dep; void hello; void offJob; void max; void noop; void cb; void native;

  // @ts-expect-error: the injected object's internal field is not part of any SDK type
  void hello.cap;
  // @ts-expect-error: no such built-in action
  await despia.bridge.nope();
}

void typedCalls; void events; void errors; void legacyStillTyped; void bridgeWords;
