// index.d.ts - TypeScript definitions for Despia SDK

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
interface DespiaFunction {
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
   * Watched values may be null, [] or {}; validate response shape before using it.
   * Missing undefined/"n/a" values retain the existing timeout behavior.
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
}

/**
 * Despia SDK - JavaScript SDK for Despia native integrations
 * 
 * Provides command queuing, variable watching, and direct window access for
 * Despia's native integration system.
 * 
 * @see https://docs.despia.com/docs/native-integrations/getting-started
 * 
 * @example
 * ```typescript
 * import despia from 'despia-native';
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