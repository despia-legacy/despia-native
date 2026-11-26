// index.d.ts - TypeScript definitions for Despia SDK

import type { DespiaFeatureMap } from './features';

export * from './features';

// ---- wire types -------------------------------------------------------------

/** A feature id, for example "ffmpeg". */
export type FeatureId = string;
/** An action name, for example "run". */
export type ActionName = string;

/**
 * Error codes. Native codes pass through unchanged; `not_in_app` and
 * `aborted` are produced by the SDK itself. Features may add their own.
 */
export type ErrorCode =
  | 'bad_request' | 'too_large' | 'unsupported_version'
  | 'forbidden_frame' | 'forbidden_origin'
  | 'unknown_feature' | 'feature_not_installed' | 'feature_disabled' | 'unknown_action'
  | 'bad_args' | 'rate_limited' | 'busy' | 'timeout' | 'cancelled' | 'navigated'
  | 'not_found' | 'permission_denied' | 'handler_error' | 'internal'
  | 'undeclared_dependency'
  | 'not_in_app' | 'aborted'
  | (string & {});

/** The error a failed call carries. */
export interface BridgeError {
  code: ErrorCode;
  message: string;
  /** Names the offending argument for `bad_args`. */
  path?: string;
}

/** A request as the app receives it. */
export interface Request {
  v: 1;
  id: string;
  doc: string;
  feature: FeatureId | 'bridge';
  action: ActionName;
  args: Record<string, unknown>;
}

/** The app's answer to one request. */
export type Reply =
  | { v: 1; t: 'reply'; id: string; ok: true; value: unknown }
  | { v: 1; t: 'reply'; id: string; ok: false; error: BridgeError };

/** One event the app sent to the page. */
export interface EventPacket {
  v: 1;
  t: 'event';
  feature: FeatureId | 'bridge';
  event: string;
  data: Record<string, unknown>;
  /** Present on job events. */
  jobId?: string;
  /** Present on job events: per job, counting from 1. */
  seq?: number;
  /** Set when the packet comes from the durable log instead of live. */
  replay?: true;
  /** Android: the document the packet is for. */
  doc?: string;
}

/**
 * A file the app made available. Only the app creates one; pass back what
 * you were given. Never file bytes.
 */
export interface FileRef {
  url: string;
  name: string;
  /** MIME type. */
  type: string;
  size: number;
  id?: string;
  persisted?: boolean;
  /** Milliseconds since the epoch, UTC. */
  expiresAt?: number;
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

/** The terminal event of a job. Features add their own fields. */
export interface JobDone {
  jobId: string;
  ok: boolean;
  error?: BridgeError;
  [key: string]: unknown;
}

export interface JobInfo {
  jobId: string;
  feature: FeatureId;
  action: ActionName;
  state: JobState;
  scope: 'document' | 'app';
  durable: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeq: number;
  done?: JobDone;
}

/** What the app reports about itself in answer to `bridge.hello`. */
export interface Hello {
  v: 1;
  platform: 'ios' | 'android';
  /** Version of the bridge contract the app implements. */
  contract?: '1.1';
  /** Where the page is served from. */
  origin?: 'web' | 'local_app';
  features: Record<FeatureId, {
    version: string;
    actions: ActionName[];
    events: string[];
    /** Features this one calls, with the version range it needs. */
    dependencies?: Record<FeatureId, string>;
  }>;
  limits: { maxMessageBytes: number; maxInFlight: number };
}

export type PermissionState =
  | 'granted' | 'denied' | 'undetermined' | 'limited' | 'restricted' | 'unknown';

/** Value of `bridge.status`. */
export interface FeatureStatus {
  installed: boolean;
  active: boolean;
  permissions: Record<string, PermissionState>;
  dependencies?: Record<FeatureId, 'installed' | 'not_installed' | 'disabled'>;
}

/** Hard limits the app enforces. The SDK does not re-check them. Read as `despia.LIMITS`. */
declare const LIMITS: {
  readonly maxMessageBytes: 4194304;
  readonly maxDepth: 32;
  readonly maxNodes: 100000;
  readonly maxKeyLength: 128;
  readonly maxInFlight: 64;
  readonly maxPerSecond: 200;
  readonly newStringMaxBytes: 262144;
};

/** Type of `despia.LIMITS`. */
export type Limits = typeof LIMITS;

/** The object the app injects as `window.despiaBridge`. */
export interface DespiaBridgeNative {
  readonly v: 1;
  readonly platform: 'ios' | 'android';
  /** Never rejects: resolves with the reply. */
  call(
    feature: FeatureId | 'bridge',
    action: ActionName,
    args?: Record<string, unknown>,
    opts?: { timeoutMs?: number }
  ): Promise<Reply>;
  /** Every event packet this document receives. Returns an off function. */
  listen(fn: (packet: EventPacket) => void): () => void;
}
declare global {
  interface Window {
    readonly despiaBridge?: DespiaBridgeNative;
  }
}

// ---- errors -----------------------------------------------------------------

/**
 * Every rejection from the typed API is a DespiaError.
 * Check with `err instanceof despia.DespiaError` and branch on `err.code`.
 */
declare class DespiaError extends Error {
  constructor(code: ErrorCode, message?: string, path?: string);
  readonly name: 'DespiaError';
  readonly code: ErrorCode;
  /** Names the offending argument for `bad_args`. */
  readonly path?: string;
}
export type { DespiaError };

/** Removes the listener it was returned for. Safe to call more than once. */
export type DespiaOff = () => void;

// ---- jobs -------------------------------------------------------------------

/** Options of one call. */
export interface CallOptions {
  /** Rejects the promise locally with `aborted`; the app keeps running. */
  signal?: AbortSignal;
}

/** Options of an event listener. */
export interface ListenOptions {
  /**
   * Also deliver stored events the page missed: those after this number for
   * `jobId`, or `'all'` for every stored job of the feature.
   */
  since?: number | 'all';
  /** Only events of this job. A numeric `since` needs it. */
  jobId?: string;
}

/** The handle of one running job. */
export interface Job<Done extends JobDone = JobDone> {
  readonly id: string;
  readonly feature: FeatureId;
  readonly action: ActionName;
  /** Listen to one event of this job (`error` is a `done` with `ok: false`). */
  on(event: string, fn: (data: any) => void, opts?: { since?: number | 'all' }): DespiaOff;
  /** Resolves with the terminal event when it succeeds, rejects with DespiaError when not. */
  result(): Promise<Done>;
  cancel(): Promise<{ cancelled: boolean; state: JobState }>;
  /** Tells the app it may drop stored events up to `seq`. */
  ack(seq: number): Promise<void>;
}

/** Callbacks of any job: one function per event name, plus `done` and `error`. */
export type Callbacks = { [event: string]: (data: any) => void } & {
  done?: (d: JobDone) => void;
  error?: (e: BridgeError & { jobId: string }) => void;
};

/** Callbacks typed from a job action's declared events. */
export type JobCallbacks<E, D extends JobDone = JobDone> = {
  [K in Exclude<keyof E, 'done'> & string]?: (data: E[K]) => void;
} & {
  done?: (data: D) => void;
  error?: (error: BridgeError & { jobId: string }) => void;
};

// ---- typed features ---------------------------------------------------------

type IsOptional<T> = {} extends T ? true : false;
type NoArgs = undefined | Record<string, never>;

/** The function type of one action, derived from its declaration. */
export type DespiaAction<S> =
  S extends { kind: 'job'; args: infer A; result: infer D; events: infer E }
    ? D extends JobDone
      ? [A] extends [void]
        ? (args?: NoArgs, callbacks?: JobCallbacks<E, D>, opts?: CallOptions) => Promise<Job<D>>
        : IsOptional<A> extends true
          ? (args?: A, callbacks?: JobCallbacks<E, D>, opts?: CallOptions) => Promise<Job<D>>
          : (args: A, callbacks?: JobCallbacks<E, D>, opts?: CallOptions) => Promise<Job<D>>
      : never
    : S extends { kind: 'request'; args: infer A; result: infer R }
      ? [A] extends [void]
        ? (args?: NoArgs, opts?: CallOptions) => Promise<R>
        : IsOptional<A> extends true
          ? (args?: A, opts?: CallOptions) => Promise<R>
          : (args: A, opts?: CallOptions) => Promise<R>
      : never;

/** `despia.<feature>`: one method per action, plus `on(event, listener, opts)`. */
export type DespiaFeature<F> = F extends { actions: infer Actions; events: infer Events }
  ? { readonly [K in keyof Actions]: DespiaAction<Actions[K]> } & {
      /** Listen to one event of this feature. Returns an off function. */
      on<E extends keyof Events & string>(
        event: E,
        listener: (data: Events[E]) => void,
        opts?: ListenOptions
      ): DespiaOff;
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

/** Resolved value of one request action, or the terminal event of a job action. */
export type DespiaResult<F extends DespiaFeatureName, A extends DespiaActionName<F>> =
  DespiaFeatureMap[F]['actions'][A] extends { result: infer X } ? X : never;

// ---- built-in actions and jobs ------------------------------------------------

/** `despia.bridge`: the built-in actions of the bridge itself. */
export interface DespiaBridgeActions {
  hello(): Promise<Hello>;
  subscribe(args: { feature: FeatureId | '*'; events?: string[]; since?: Record<string, number> | 'all' }): Promise<{ subscribed: true }>;
  unsubscribe(args: { feature: FeatureId | '*'; events?: string[] }): Promise<Record<string, never>>;
  jobs(args?: { feature?: FeatureId; states?: JobState[] }): Promise<{ jobs: JobInfo[] }>;
  job(args: { jobId: string }): Promise<JobInfo>;
  cancel(args: { jobId: string }): Promise<{ cancelled: boolean; state: JobState }>;
  ack(args: { jobId: string; seq: number }): Promise<Record<string, never>>;
  status(args: { feature: FeatureId }): Promise<FeatureStatus>;
  assets(args: { feature: FeatureId }): Promise<{ baseUrl: string }>;
  /** Listen to the bridge's own events: `job` (state changes) and `dropped`. */
  on(event: 'job', listener: (data: JobInfo) => void, opts?: ListenOptions): DespiaOff;
  on(event: 'dropped', listener: (data: { count: number }) => void, opts?: ListenOptions): DespiaOff;
  on(event: string, listener: (data: any) => void, opts?: ListenOptions): DespiaOff;
}

/** `despia.jobs`: every job the page can see. */
export interface DespiaJobs {
  list(filter?: { feature?: FeatureId; states?: JobState[] }): Promise<JobInfo[]>;
  get(jobId: string): Promise<JobInfo>;
  cancel(jobId: string): Promise<{ cancelled: boolean; state: JobState }>;
}

/** `despia.legacy`: the old scheme calls and window variables. */
export interface DespiaLegacy {
  /** Reads a variable the app injected the old way (`window[name]`) right now. */
  variable<T = unknown>(name: string): T | undefined;
  /**
   * Resolves when the variable becomes set and changes, or with `undefined`
   * after `timeoutMs` (default 30000).
   */
  variable<T = unknown>(name: string, opts: { wait: true; timeoutMs?: number }): Promise<T | undefined>;
  /** The same as `despia(command, watch)`. */
  call<T = Record<string, any>>(command: string, watch?: string[]): Promise<T | void>;
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
   * Listen to every event packet the page receives (broadcast).
   * @returns An off function.
   *
   * @example
   * ```typescript
   * const off = despia.on((p) => console.log(p.feature, p.event, p.data));
   * ```
   */
  on(listener: (packet: EventPacket) => void): DespiaOff;

  /** Built-in bridge actions: hello, subscribe, jobs, cancel, ack, status, assets. */
  readonly bridge: DespiaBridgeActions;

  /** Jobs the page can see. */
  readonly jobs: DespiaJobs;

  /**
   * Settles once the document knows whether it has the JSON bridge.
   * `bridge: false` means legacy scheme calls only.
   */
  ready(): Promise<{ bridge: boolean; hello?: Hello }>;

  /** The old window-variable channel and scheme calls. */
  readonly legacy: DespiaLegacy;

  /** Error class for rejections of the typed API. */
  readonly DespiaError: typeof DespiaError;

  /** Hard limits the app enforces. */
  readonly LIMITS: typeof LIMITS;
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