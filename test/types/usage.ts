// Compile-time checks for the typed API (`tsc -p test/types`).
// Lines marked @ts-expect-error must fail to type-check.

import despia, {
  DespiaArgs,
  DespiaError,
  DespiaEvent,
  DespiaOff,
  DespiaResult,
  GpsPoint,
  RevenueCatPurchase,
} from '../..';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function assertType<T extends true>(): void {}

async function typedCalls(): Promise<void> {
  // Results are typed per action.
  const nothing: void = await despia.haptics.light();
  const token: string = await despia.vault.get({ key: 'sessionToken' });
  const version = await despia.device.appVersion();
  const versionNumber: string = version.versionNumber;
  const history: RevenueCatPurchase[] = await despia.revenuecat.history();
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
}

function events(): void {
  const off: DespiaOff = despia.gps.on('change', (point) => {
    const p: GpsPoint = point;
    const lat: number = point.latitude;
    void p; void lat;
  });
  off();

  despia.revenuecat.on('purchase', (data) => void data);

  // @ts-expect-error: unknown event
  despia.gps.on('moved', () => {});
  // @ts-expect-error: haptics has no events
  despia.haptics.on('change', () => {});

  const offAll = despia.on((e: DespiaEvent) => {
    if (e.feature === 'gps' && e.event === 'change') {
      const lng: number = e.data.longitude;
      void lng;
    }
    // @ts-expect-error: not a typed feature
    if (e.feature === 'nope') return;
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
      if (e.code === 'not_in_app') return;
      void code;
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

void typedCalls; void events; void errors; void legacyStillTyped;
