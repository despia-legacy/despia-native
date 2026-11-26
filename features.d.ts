// features.d.ts - typed feature map for the Despia JSON bridge.
//
// Hand-written for now. scripts/generate-features.js emits this same shape
// from native routes.json files and will replace this file; src/features.js
// is its runtime twin.
//
// Each feature lists its actions (`args` and `result`) and its events (the
// payload type of each). `args: void` means the action takes no arguments.

/** A purchase record as returned by RevenueCat. */
export interface RevenueCatPurchase {
  isActive: boolean;
  entitlementId: string;
  productId?: string;
  [key: string]: unknown;
}

/** A position reported by background location tracking. */
export interface GpsPoint {
  active: boolean;
  latitude: number;
  longitude: number;
  [key: string]: unknown;
}

export interface DespiaFeatureMap {
  haptics: {
    actions: {
      /** Subtle tap. */
      light: { args: void; result: void };
      /** Strong tap. */
      heavy: { args: void; result: void };
      success: { args: void; result: void };
      warning: { args: void; result: void };
      error: { args: void; result: void };
    };
    events: {};
  };

  vault: {
    actions: {
      /** Store a value in the encrypted, backed-up vault. */
      set: {
        args: {
          /** @minLength 1 */
          key: string;
          value: string;
          /** Require Face ID / Touch ID / fingerprint to read it back. */
          locked?: boolean;
        };
        result: void;
      };
      /** Read a value (prompts biometrics when it was stored locked). */
      get: {
        args: {
          /** @minLength 1 */
          key: string;
        };
        result: string;
      };
    };
    events: {};
  };

  device: {
    actions: {
      appVersion: { args: void; result: { versionNumber: string; bundleNumber: string } };
      uuid: { args: void; result: string };
      storeLocation: { args: void; result: string };
    };
    events: {};
  };

  revenuecat: {
    actions: {
      purchase: {
        args: {
          /** Your user id. @minLength 1 */
          externalId: string;
          /** Store product id. @minLength 1 */
          product: string;
        };
        result: void;
      };
      paywall: {
        args: {
          /** Your user id. @minLength 1 */
          externalId: string;
          /** @minLength 1 */
          offering?: string;
        };
        result: void;
      };
      history: { args: void; result: RevenueCatPurchase[] };
    };
    events: {
      /** The store confirmed a transaction. */
      purchase: Record<string, unknown>;
    };
  };

  gps: {
    actions: {
      start: {
        args: {
          /** Seconds between points. @minimum 1 */
          buffer?: number;
          /** Movement threshold in centimetres. @minimum 0 */
          movement?: number;
          /** POST each point to this URL. @minLength 1 */
          server?: string;
        };
        result: void;
      };
      stop: { args: void; result: unknown };
    };
    events: {
      change: GpsPoint;
    };
  };
}
