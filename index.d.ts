// index.d.ts - TypeScript definitions for Despia SDK

import type { DespiaFeatureMap } from './features';

export * from './features';

/** Error codes the SDK itself produces. Native codes pass through as strings. */
export type DespiaErrorCode =
  | 'not_in_app'
  | 'unsupported'
  | 'invalid_args'
  | 'timeout'
  | 'bridge_error'
  | 'native_error'
  | (string & {});

/**
 * Every rejection from `despia.<feature>.<action>()` is a DespiaError.
 * Check with `err instanceof despia.DespiaError` and branch on `err.code`.
 */
declare class DespiaError extends Error {
  constructor(code: DespiaErrorCode, message?: string, details?: unknown);
  readonly name: 'DespiaError';
  readonly code: DespiaErrorCode;
  readonly details?: unknown;
}
export type { DespiaError };

/** Removes the listener it was returned for. Safe to call more than once. */
export type DespiaOff = () => void;

type IsOptional<T> = {} extends T ? true : false;

/** The function type of one action, derived from `{ args, result }`. */
export type DespiaAction<S> = S extends { args: infer A; result: infer R }
  ? [A] extends [void]
    ? () => Promise<R>
    : IsOptional<A> extends true
      ? (args?: A) => Promise<R>
      : (args: A) => Promise<R>
  : never;

/** `despia.<feature>`: one method per action, plus `on(event, listener)`. */
export type DespiaFeature<F> = F extends { actions: infer Actions; events: infer Events }
  ? { readonly [K in keyof Actions]: DespiaAction<Actions[K]> } & {
      /** Listen to one event of this feature. Returns an off function. */
      on<E extends keyof Events & string>(event: E, listener: (data: Events[E]) => void): DespiaOff;
    }
  : never;

/** All typed features, keyed by name. */
export type DespiaFeatures = {
  readonly [K in keyof DespiaFeatureMap]: DespiaFeature<DespiaFeatureMap[K]>;
};

/** Names of the typed features. */
export type DespiaFeatureName = keyof DespiaFeatureMap;

/** Action names of one feature. */
export type DespiaActionName<F extends DespiaFeatureName> = keyof DespiaFeatureMap[F]['actions'] & string;

/** Arguments of one action (`void` when it takes none). */
export type DespiaArgs<F extends DespiaFeatureName, A extends DespiaActionName<F>> =
  DespiaFeatureMap[F]['actions'][A] extends { args: infer X } ? X : never;

/** Resolved value of one action. */
export type DespiaResult<F extends DespiaFeatureName, A extends DespiaActionName<F>> =
  DespiaFeatureMap[F]['actions'][A] extends { result: infer X } ? X : never;

/** Any event of a typed feature, as received by `despia.on(listener)`. */
export type DespiaEvent = {
  [F in DespiaFeatureName]: {
    [E in keyof DespiaFeatureMap[F]['events'] & string]: {
      feature: F;
      event: E;
      data: DespiaFeatureMap[F]['events'][E];
    };
  }[keyof DespiaFeatureMap[F]['events'] & string];
}[DespiaFeatureName];

/** `despia.legacy`: access to the old window-variable channel. */
export interface DespiaLegacy {
  /** Reads a variable the app injected the old way (`window[name]`). */
  variable<T = unknown>(name: string): T | undefined;
}

/**
 * Despia protocol command types
 */
type DespiaCommand = 
  | `widget://${string}`
  | `revenuecat://${string}`
  | `requestcontactpermission://`
  | `readcontacts://`
  | `backgroundlocationon://`
  | `backgroundlocationoff://`
  | `registerpush://`
  | `sendlocalpushmsg://${string}`
  | `getonesignalplayerid://`
  | `getappversion://`
  | `get-uuid://`
  | `takescreenshot://`
  | `scanningmode://auto`
  | `scanningmode://on`
  | `scanningmode://off`
  | `getstorelocation://`
  | `savethisimage://?url=${string}`
  | `reset://`
  | `user-disable-tracking://`
  | `spinneron://`
  | `spinneroff://`
  | `shareapp://message?=${string}&url=${string}`
  | `hidebars://on`
  | `hidebars://off`
  | `bioauth://`
  | `statusbarcolor://{${string}}`
  | `statusbartextcolor://{${string}}`
  | `lighthaptic://`
  | `heavyhaptic://`
  | `successhaptic://`
  | `warninghaptic://`
  | `errorhaptic://`
  | `haptic://${string}`
  | `purchase://${string}`
  | `push://${string}`
  | `camera://${string}`
  | `biometric://${string}`
  | `location://${string}`
  | `download://${string}`
  | `analytics://${string}`
  | `statusbar://${string}`
  | `file://${string}`
  | string; // Allow any string for future protocol extensions

/**
 * Main Despia SDK function interface
 */
interface DespiaFunction extends DespiaFeatures {
  /**
   * Execute a Despia protocol command without watching for response variables
   * @param command - The Despia protocol command (e.g., 'applinks://open?url=...')
   * @returns Promise that resolves when command is queued
   * 
   * @example
   * ```typescript
   * await despia('applinks://open?url=https://example.com');
   * await despia('biometric://authenticate?reason=Login');
   * ```
   */
  (command: DespiaCommand): Promise<void>;

  /**
   * Execute a Despia protocol command and watch for specific response variables
   * @param command - The Despia protocol command
   * @param watch - Array of variable names to watch for in the response
   * @returns Promise that resolves with the watched variables
   * 
   * @example
   * ```typescript
   * const result = await despia('getappversion://', ['versionNumber', 'bundleNumber']);
   * const purchase = await despia('revenuecat://purchase?external_id=user_777&product=monthly_premium', ['purchaseResult', 'transactionID']);
   * ```
   */
  <T = Record<string, any>>(command: DespiaCommand, watch: string[]): Promise<T>;
  
  /**
   * Access any window variable directly (useful for Despia response data)
   * @param key - The variable name to access
   * @returns The value of the window variable
   * 
   * @example
   * ```typescript
   * const currentUser = despia.currentUser;
   * const deviceInfo = despia.deviceInfo;
   * ```
   */
  [key: string]: any;

  /**
   * Listen to every event from every feature (broadcast).
   * @returns An off function.
   *
   * @example
   * ```typescript
   * const off = despia.on(({ feature, event, data }) => console.log(feature, event, data));
   * ```
   */
  on(listener: (event: DespiaEvent) => void): DespiaOff;

  /** The old window-variable channel. */
  readonly legacy: DespiaLegacy;

  /** Error class for rejections of the typed API. */
  readonly DespiaError: typeof DespiaError;
}

/**
 * Despia SDK - JavaScript SDK for Despia native integrations
 * 
 * Typed calls: `despia.<feature>.<action>(args)` returns a Promise and
 * `despia.<feature>.on(event, listener)` returns an off function. The
 * original `despia(command, watch)` form keeps working unchanged.
 * 
 * @see https://docs.despia.com/docs/native-integrations/getting-started
 * 
 * @example
 * ```typescript
 * import despia from 'despia-native';
 * 
 * await despia.haptics.success();
 * const token = await despia.vault.get({ key: 'sessionToken' });
 * const off = despia.gps.on('change', (point) => console.log(point.latitude));
 * 
 * // Execute Despia protocol commands
 * await despia('applinks://open?url=https://maps.apple.com');
 * 
 * // Execute and watch for response variables
 * const authResult = await despia('biometric://authenticate', ['authResult', 'userID']);
 * 
 * // Access window variables directly
 * const deviceInfo = despia.deviceInfo;
 * ```
 */
declare const despia: DespiaFunction;

export default despia;