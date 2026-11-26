# [Despia Native](https://despia.com)

> ### Part of Despia Convert
>
> This repository supports **Despia Convert** and Despia V4 WebView applications. Despia Convert is the fastest way to turn an existing web application into an iOS or Android app while keeping the existing web codebase.
>
> This project is actively supported for Convert and WebView-based applications.
>
> For projects that require fully native UI and native rendering, use **DSX Native**, Despia's native-first platform (SwiftUI on iOS, Jetpack Compose on Android). Convert applications can migrate to DSX Native later if deeper native UI or performance is required. Despia does not charge a migration fee.
>
> Current documentation: [docs.despia.com](https://docs.despia.com)

Add 50+ native iOS and Android capabilities to any web app (React, Vue, Angular, Svelte, Next.js, vanilla JS) through one typed `despia` object: real JSON arguments in, promises and events out. Plus native offline support, a local SQLite database, and an on-device streaming CDN, solving 15 years of hybrid-app problems with modern runtime architecture.

[![npm](https://img.shields.io/npm/v/despia-native)](https://www.npmjs.com/package/despia-native)

**[Full documentation](https://setup.despia.com)**

---

## Installation

```bash
npm install despia-native
# pnpm add despia-native
# yarn add despia-native
```

```js
import despia from 'despia-native';
```

Or via CDN:

```html
<!-- UMD -->
<script src="https://cdn.jsdelivr.net/npm/despia-native/index.min.js"></script>
```

```html
<!-- ESM -->
<script type="module">
  import despia from 'https://cdn.jsdelivr.net/npm/despia-native/+esm';
</script>
```

---

## Quick Start

```js
import despia from 'despia-native';

// Launch a RevenueCat paywall
await despia.revenuecat.paywall({ externalId: userId, offering: 'default' });

// Store a session token behind Face ID / Touch ID (survives reinstall)
await despia.vault.set({ key: 'sessionToken', value: 'abc123', locked: true });

// Read it back later (prompts biometric)
const sessionToken = await despia.vault.get({ key: 'sessionToken' });

// Listen for native events; the return value unsubscribes
const off = despia.gps.on('change', (point) => console.log(point.latitude, point.longitude));
```

No initialization. Open your app in the Despia runtime and it works. Every call is typed: TypeScript checks action names, arguments and results at compile time.

---

## Why Despia

Despia is a hybrid app runtime built on the web platform. The web handles what it's good at (logic, UI, routing, state, storage); everything else (biometrics, push, in-app purchases, background GPS, system pickers) is handed to a native engine through the `despia` object.

Works with any web codebase. Bring an existing app or start fresh with any framework, any build tool, any host. No framework lock-in, no proprietary hosting, nothing to migrate.

Full native offline support. [`@despia/local`](https://www.npmjs.com/package/@despia/local) serves your web build from `http://localhost`, and the [Local CDN](https://setup.despia.com/local-cdn) streams cached media from device storage. For on-device database options, see the [current Despia documentation](https://docs.despia.com). File transfers stream between native storage and the web layer without loading into the JS heap.

Push, monetization, ads, and attribution are built in: OneSignal, RevenueCat, AdMob, AppsFlyer. Pre-wired into the runtime, configured from the Despia dashboard, called from web code. Builds, signing, and store submission run from the browser. No Xcode, no Android Studio.

---

## Contents

- [Why Despia](#why-despia)
- [Environment Detection](#environment-detection)
- [For AI Coding](#for-ai-coding)
- [API Reference](#api-reference)
- [Deployment Models](#deployment-models)
- [Features](#features)
- [Capability Reference](#capability-reference)
- [Safe Area](#safe-area)
- [Extending the Runtime](#extending-the-runtime)
- [Web Native vs React Native](#web-native-vs-react-native)
- [Publishing](#publishing)
- [MCP Server](#mcp-server)
- [How It Works](#how-it-works)
- [Support](#support)

---

## Environment Detection

The SDK only activates inside the Despia runtime. In a plain browser every typed call rejects with a `DespiaError` whose `code` is `'not_in_app'`, so you can fall back in one place:

```js
try {
  await despia.revenuecat.purchase({ externalId: userId, product: 'monthly_premium' });
} catch (err) {
  if (err instanceof despia.DespiaError && err.code === 'not_in_app') {
    window.location.href = webCheckoutUrl;
  } else {
    throw err;
  }
}
```

To check up front, read the user agent:

```js
const isDespia = navigator.userAgent.toLowerCase().includes('despia');

const isDespiaIOS = isDespia && (
  navigator.userAgent.toLowerCase().includes('iphone') ||
  navigator.userAgent.toLowerCase().includes('ipad')
);

const isDespiaAndroid = isDespia && navigator.userAgent.toLowerCase().includes('android');

if (isDespia) despia.haptics.light();
```

---

## For AI Coding

Full API context: [`llms.txt`](https://setup.despia.com/llms.txt).

- Import as default: `import despia from 'despia-native'`
- Use the typed form `despia.<feature>.<action>({ ...args })`; it returns a Promise and rejects with `despia.DespiaError`
- Pass plain JSON objects as arguments; do not build query strings or URL-encode values
- Subscribe with `despia.<feature>.on(event, fn)` and call the returned function to unsubscribe
- Never write `window.despia` directly; the SDK uses it internally
- There is no `.init()`, `.ready()`, or `.setup()`; the SDK needs no initialization
- Do not mock or reimplement the SDK; mock implementations will not trigger the native runtime on real devices
- Gate native calls with the environment check above
- For Local Server apps, install via a package manager so the SDK ships with the build
- Do not `await` `localcdn://write` with a watch key; use `window.contentServerChange`
- For the upload API, read `window.location.host`; don't hardcode ports

---

## API Reference

### `despia.<feature>.<action>(args?, opts?)`

Calls a native action with a plain JSON object and returns a `Promise` of its result. It rejects with a `DespiaError` (`code`, `message`, and `path` when the app names the offending argument).

```ts
const token: string = await despia.vault.get({ key: 'sessionToken' });
const { versionNumber, bundleNumber } = await despia.device.appVersion();
await despia.haptics.success();
```

Pass `{ signal }` as the last argument to stop waiting: the promise rejects locally with `code: 'aborted'` while the app keeps running the call.

Argument types, limits and bounds are checked by the app, which answers `bad_args` with the argument's path. The SDK checks only that `args` is a plain object.

### Long-running actions: jobs

An action that runs for a while answers at once with a `Job`. Pass callbacks for the events you want; `done` fires last, and `error` is a shortcut for a `done` that did not succeed.

```ts
const job = await despia.ffmpeg.run({ input: file }, {
  progress: ({ percent }) => bar.set(percent),
  log: ({ line }) => console.log(line),
  error: ({ code, message }) => console.error(code, message)
});

const done = await job.result();   // resolves on success, rejects with DespiaError otherwise
await job.cancel();                // { cancelled, state }
```

| Member                          | Meaning                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `job.id`                        | The job id                                                                 |
| `job.on(event, fn, { since })`  | Another listener for this job; returns `off()`                             |
| `job.result()`                  | Resolves with the `done` event when it succeeded                           |
| `job.cancel()`                  | Asks the app to cancel                                                     |
| `job.ack(seq)`                  | Tells the app it may forget stored events up to `seq`                      |

Events carry a per-job `seq`. The SDK delivers them in that order and drops duplicates. Pass the callbacks to the call itself to see the very first events: they are attached before anything is delivered, while a listener added with `job.on()` after the call returns hears what comes next. The SDK removes a job's own callbacks once its `done` has been delivered.

### `despia.<feature>.on(event, listener, opts?)`

Subscribes to one event of a feature. Returns an `off()` function. Events come from the JSON bridge; in an older app build that only has protocol URLs, the callbacks the app calls on `window` (for example `onRevenueCatPurchase`) keep working as before and are not forwarded to `on()`.

```ts
const off = despia.gps.on('change', (point) => updateMap(point.latitude, point.longitude));
off();
```

Jobs that the app keeps in a durable log can be picked up again after a reload. The page keeps the last `seq` it handled; the SDK keeps no cursor across reloads.

```ts
// Everything after seq 41 of this job, then live events:
despia.ffmpeg.on('progress', render, { jobId, since: 41 });
// Every stored job of the feature:
despia.ffmpeg.on('done', record, { since: 'all' });
```

Replayed events reach only listeners that passed `since`, and each of them gets a given event once.

### `despia.on(listener)`

Hears every event packet the page receives (broadcast): `{ feature, event, data, jobId?, seq?, replay? }`. Returns an `off()` function.

```ts
const off = despia.on((packet) => console.log(packet.feature, packet.event, packet.data));
```

### `despia.jobs`

```ts
await despia.jobs.list({ feature: 'ffmpeg', states: ['running'] });   // JobInfo[]
await despia.jobs.get(jobId);                                         // JobInfo
await despia.jobs.cancel(jobId);                                      // { cancelled, state }
```

### `despia.ready()`

Resolves once the page knows how it talks to the app: `{ bridge: true, hello }` with the JSON bridge, `{ bridge: false }` with legacy protocol URLs only. `hello` lists the app's installed features, their actions and events, and its limits.

### `despia.bridge`

The bridge's own actions: `hello`, `subscribe`, `unsubscribe`, `jobs`, `job`, `cancel`, `ack`, `status` and `assets`, plus `despia.bridge.on('job' | 'dropped', fn)`.

```ts
const { baseUrl } = await despia.bridge.assets({ feature: 'ffmpeg' });
const { installed, active, permissions } = await despia.bridge.status({ feature: 'vault' });
```

### `despia.legacy`

```ts
despia.legacy.variable('appsFlyerUID');                                  // window value now
await despia.legacy.variable('pushToken', { wait: true, timeoutMs: 5000 }); // when it changes
await despia.legacy.call('getappversion://', ['versionNumber']);         // same as despia(command, watch)
```

`name` must be a plain identifier (letters, digits, `_`, `$`, up to 64 characters) or the call throws a `TypeError`.

`despia.<name>` resolves in this order: the SDK's own words (`legacy`, `on`, `jobs`, `bridge`, `ready`), then a feature, then a window variable the app injected.

### Errors

Rejections are `despia.DespiaError` instances with a `code` and a `message`. Codes from the app pass through unchanged (`bad_args`, `feature_not_installed`, `feature_disabled`, `permission_denied`, `busy`, `timeout`, `cancelled`, `not_found`, `undeclared_dependency`, and codes features define). The SDK itself adds:

| Code           | Meaning                                                                   |
| -------------- | ------------------------------------------------------------------------- |
| `not_in_app`   | Running in a plain browser, outside the Despia app                        |
| `aborted`      | Your `AbortSignal` fired                                                  |
| `timeout`      | No reply within the action's `timeoutMs` plus 5 seconds                   |
| `feature_not_installed` | This app build has no JSON route for the action and no protocol URL |
| `bad_args`     | `args` was not a plain object                                             |
| `internal`     | The app sent a malformed reply                                            |

### Typed features

| Feature              | Actions                                           | Events     |
| -------------------- | ------------------------------------------------- | ---------- |
| `despia.haptics`     | `light`, `heavy`, `success`, `warning`, `error`   |            |
| `despia.vault`       | `set`, `get`                                      |            |
| `despia.device`      | `appVersion`, `uuid`, `storeLocation`           |            |
| `despia.revenuecat`  | `purchase`, `paywall`, `history`                  | `purchase` |
| `despia.gps`         | `start`, `stop`                                   | `change`   |

More features join the typed map as the app publishes them; the map is generated from the app's feature catalog (`npm run generate`). Features not listed yet are called with a protocol URL, shown in their sections below; that form keeps working.

### TypeScript

Types ship with the package. Helper types are exported for your own wrappers:

```ts
import despia, { type DespiaArgs, type DespiaResult, type Job, type EventPacket } from 'despia-native';

type VaultGetArgs = DespiaArgs<'vault', 'get'>;   // { key: string }
type Version = DespiaResult<'device', 'appVersion'>;
```

`despia.LIMITS` holds the hard limits the app enforces (message size 4 MiB, in-flight requests, and so on). The SDK does not re-check them.

---

## Deployment Models

**Remote hydration (default).** Binary ships without web assets; Despia fetches the current build on launch. Web updates do not require store resubmission.

**Local Server.** Build is cached on-device and served from `http://localhost`. See [Local Server](#local-server).

**Version gating.** Use [`despia-version-guard`](https://www.npmjs.com/package/despia-version-guard) to gate features by minimum runtime version:

```jsx
import { VersionGuard } from 'despia-version-guard';

<VersionGuard min_version="21.0.3">
  <NewFeature />
</VersionGuard>
```

---

## Features

Haptics, Identity Vault, device info, RevenueCat and GPS use the typed API. The other features below are not in the typed map yet and are called with a protocol URL, `despia('feature://action?…')`, until they are.

### RevenueCat In-App Purchases

```js
// Paywall
await despia.revenuecat.paywall({ externalId: userId, offering: 'default' });

// Direct purchase
await despia.revenuecat.purchase({ externalId: userId, product: 'monthly_premium_ios' });
```

The `purchase` event fires when the store confirms a transaction. Verify entitlement before unlocking (via your backend webhook, or by reading the store directly):

```js
despia.revenuecat.on('purchase', async () => {
  const history = await despia.revenuecat.history();
  if (history.some(p => p.isActive && p.entitlementId === 'premium')) unlockPremium();
});
```

Events need a current app build. Older builds report the purchase through `window.onRevenueCatPurchase()` instead.

In the browser, fall back to a RevenueCat Web Purchase Link.

[Intro](https://setup.despia.com/native-features/revenuecat/introduction) · [Reference](https://setup.despia.com/native-features/revenuecat/reference)

---

### Push Notifications

Permission and OneSignal registration happen automatically at launch. Link the device to your user on every authenticated load:

```js
despia(`setonesignalplayerid://?user_id=${userId}`);

// Check permission
const { nativePushEnabled } = await despia('checkNativePushPermissions://', ['nativePushEnabled']);
if (!nativePushEnabled) despia('settingsapp://');

// Local scheduled notification
despia('sendlocalpushmsg://push.send?s=60&msg=Hello&!#Title&!#https://myapp.com');
```

Configure OneSignal with **Native iOS** and **Native Android** as platforms, then send remote pushes from your backend with the OneSignal REST API.

[Intro](https://setup.despia.com/native-features/onesignal/introduction) · [Reference](https://setup.despia.com/native-features/onesignal/reference)

---

### Identity Vault

Encrypted key-value storage backed by iCloud KV (iOS) and Android App Backup. Values survive uninstall and sync across a user's own devices. Set `locked=true` to require Face ID, Touch ID, or fingerprint on read.

```js
// Write
await despia.vault.set({ key: 'sessionToken', value: 'abc123', locked: true });

// Read (prompts biometric if locked)
const sessionToken = await despia.vault.get({ key: 'sessionToken' });
```

`vault.get` rejects if the key doesn't exist. Wrap in try/catch.

[Docs](https://setup.despia.com/native-features/storage-vault)

---

### OAuth Authentication

Opens a secure browser session (`ASWebAuthenticationSession` / Chrome Custom Tabs). A deeplink with the `oauth/` prefix closes the session and returns to your WebView.

```js
const redirectUri = isDespia
  ? 'https://yourapp.com/native-callback.html'
  : 'https://yourapp.com/auth/callback';

const authUrl = `https://provider.com/oauth/authorize?client_id=xxx&redirect_uri=${encodeURIComponent(redirectUri)}`;

if (isDespia) {
  despia(`oauth://?url=${encodeURIComponent(authUrl)}`);
} else {
  window.location.href = authUrl;
}
```

In `public/native-callback.html` (plain HTML, not a framework route, so the hash isn't stripped on navigation):

```html
<script>
  var hash  = new URLSearchParams(window.location.hash.substring(1));
  var token = hash.get('access_token');
  if (token) window.location.href = '{yourscheme}://oauth/auth?access_token=' + encodeURIComponent(token);
</script>
```

Deeplink format: `{yourscheme}://oauth/{path}?params`. Without the `oauth/` prefix the browser session stays open.

[Docs](https://setup.despia.com/native-features/oauth/introduction)

---

### AppsFlyer Attribution

iOS today, Android soon. Enable in **Despia > App > Settings > Integrations > AppsFlyer** with your dev key.

```js
// Attribution available on every launch
despia.legacy.variable('appsFlyerAttribution')
despia.legacy.variable('appsFlyerReferrer')
despia.legacy.variable('appsFlyerUID')

// After login
despia('appsflyer://set_user_id?customer_user_id=' + encodeURIComponent(userId));

// Log an event (af_-prefixed events map to Meta and TikTok automatically)
const values = { af_revenue: 9.99, af_currency: 'USD' };
despia('appsflyer://log_event?event_name=af_purchase&event_values=' + encodeURIComponent(JSON.stringify(values)));
```

[Intro](https://setup.despia.com/analytics/appsflyer/introduction) · [Attribution](https://setup.despia.com/analytics/appsflyer/attribution)

---

### GPS Location

```js
const off = despia.gps.on('change', (point) => {
  if (point.active) console.log(point.latitude, point.longitude);
});

// buffer in seconds, movement threshold in centimetres
await despia.gps.start({ buffer: 60, movement: 100 });

const session = await despia.gps.stop();
off();
```

Add `server: 'https://api.example.com/track'` to POST each point as it's recorded. The `change` event needs a current app build; older builds call `window.onLocationChange` instead.

[Docs](https://setup.despia.com/native-features/gps-location)

---

### Apple Health (HealthKit)

iOS only. Gate behind `isDespiaIOS`. Permissions are requested on first call per identifier.

```js
// Read
const { healthkitResponse } = await despia(
  'readhealthkit://HKQuantityTypeIdentifierStepCount?days=7',
  ['healthkitResponse']
);

// Write
despia('writehealthkit://HKQuantityTypeIdentifierBodyMass//74.5');

// Observe and POST to your backend on change
despia('healthkit://observe?types=HKQuantityTypeIdentifierStepCount&frequency=hourly&server=https://api.example.com/webhook');
```

Any `HKQuantityTypeIdentifier`, `HKCategoryTypeIdentifier`, `HKWorkoutTypeIdentifier`, or `HKCharacteristicTypeIdentifier` works.

[Docs](https://setup.despia.com/health-data/apple-health)

---

### File and Media Operations

Standard HTML file inputs route to native UI with events delivered back to the input:

```html
<input type="file">                                       <!-- Action sheet -->
<input type="file" accept="image/*">                      <!-- Image gallery -->
<input type="file" accept="video/*">                      <!-- Video gallery -->
<input type="file" accept="image/*" capture="environment"><!-- Camera -->
```

```js
despia('takescreenshot://');
despia('savethisimage://?url=https://example.com/image.jpg');
despia('file://https://example.com/document.pdf');
despia('shareapp://message?=Check%20this%20out&url=https://myapp.com');
```

[File sharing](https://setup.despia.com/native-features/file-sharing) · [Camera roll](https://setup.despia.com/native-features/camera-roll)

---

### AdMob Inline Ads

Ads render as real DOM elements via Google's WebView API for Ads. Enable in **Despia > App > Settings > AdMob**, then use standard AdSense, Google Publisher Tag, or IMA tags. No SDK calls from web.

[Inline ads](https://setup.despia.com/native-features/admob/inline-ads) · [Rewarded](https://setup.despia.com/native-features/admob/rewarded-ads)

---

### Web Payment Request API

Apple Pay and Google Pay work through the standard Payment Request API with no Despia-specific calls.

```js
const request = new PaymentRequest(
  [{ supportedMethods: 'https://apple.com/apple-pay' }],
  { total: { label: 'Total', amount: { currency: 'USD', value: '9.99' } } }
);
await (await request.show()).complete('success');
```

[Docs](https://setup.despia.com/native-features/external-links)

---

### Local Server

Caches the web build on-device and serves it from `http://localhost` for offline launch. Updates are detected and swapped atomically on the next launch.

```bash
npm install --save-dev @despia/local
```

```js
// vite.config.js (also Webpack, Rollup, Nuxt, SvelteKit, Astro, Remix, esbuild)
import { despiaLocalPlugin } from '@despia/local/vite';

export default {
  plugins: [despiaLocalPlugin({ outDir: 'dist', entryHtml: 'index.html' })],
};
```

Or run `npx despia-local dist` after any build. Deploy as normal.

[Intro](https://setup.despia.com/local-server/introduction) · [Reference](https://setup.despia.com/local-server/reference)

---

### Local CDN

Cache remote files on-device for offline playback and background downloads. Transfers use `NSURLSession` / `WorkManager` and continue when the app is closed, with Live Activity (iOS) or system tray (Android) progress.

```js
// Called on download complete
window.contentServerChange = (item) => {
  // item.local_cdn, item.cdn, item.index, item.size, item.status, item.local_path
};

// Start a download. Do NOT await with a watch key.
despia(`localcdn://write?url=${remoteUrl}&filename=videos/clip.mp4&index=clip_1`);

// Query cache
const { cdnItems } = await despia('localcdn://query', ['cdnItems']);
```

Play cached media from the `local_cdn` URL. For uploads, POST to `http://${window.location.host}/api/upload` (Local Server only).

[Intro](https://setup.despia.com/local-cdn/introduction) · [Reference](https://setup.despia.com/local-cdn/reference)

---

### Web Storage APIs

The app runs on a real origin, so `localStorage`, `IndexedDB`, and Web Crypto work normally. For data that must survive uninstall or be locked behind biometrics, use [Identity Vault](#identity-vault).

---

### Haptic Feedback

```js
despia.haptics.light();   // Subtle
despia.haptics.heavy();   // Strong
despia.haptics.success(); // Success
despia.haptics.warning(); // Warning
despia.haptics.error();   // Error
```

[Docs](https://setup.despia.com/native-features/haptic-feedback)

---

### UI Controls and Styling

```js
despia('spinneron://');
despia('spinneroff://');
despia('hidebars://on');                     // Hide status bar
despia('hidebars://off');
despia('statusbarcolor://{255, 255, 255}');  // RGB
despia('statusbartextcolor://{black}');      // black | white
despia('settingsapp://');                    // Open native app settings
despia('reset://');
```

[Safe areas](https://setup.despia.com/native-features/safe-areas) · [App settings](https://setup.despia.com/native-features/app-settings)

---

### App Information and Device Data

```js
const { versionNumber, bundleNumber } = await despia.device.appVersion();
const uuid          = await despia.device.uuid();
const storeLocation = await despia.device.storeLocation();

// Not in the typed map yet:
const { trackingDisabled } = await despia('user-disable-tracking://', ['trackingDisabled']);
```

[Device indexing](https://setup.despia.com/native-features/device-indexing) · [Store location](https://setup.despia.com/native-features/store-location) · [App privacy](https://setup.despia.com/native-features/app-privacy)

---

### Clipboard

```js
const { clipboarddata } = await despia('getclipboard://', ['clipboarddata']);
```

[Docs](https://setup.despia.com/native-features/clipboard)

---

### Contacts

```js
const { contacts } = await despia('readcontacts://', ['contacts']);
```

[Docs](https://setup.despia.com/native-features/contact-access)

---

## Capability Reference

**Core.** Identity Vault, Face ID / Touch ID / fingerprint, background GPS, contacts, clipboard, haptics, native file system, image saving, background audio, local push, status bar controls, safe area CSS variables, device orientation, zoom lock, sleep lock, fullscreen, splash screen, iOS Home Widgets, Siri Shortcuts, native share, AirPrint, screen shield, PkPass for mobile wallets.

**SDK bridges.** RevenueCat, OneSignal, AppsFlyer, AdMob, HealthKit.

**Infrastructure.** ATT compliance, vendor ID, store location, jailbreak detection, App Clips, Share Extensions, Home Widget configuration.

**Web interception.** `<input type="file">` routes to the native action sheet; `capture` opens the camera; `accept` filters to media gallery. Deeplinks and HTTPS deeplinks are handled natively.

---

## Safe Area

Top and bottom safe area insets are exposed as CSS custom properties:

```css
.header { padding-top: var(--safe-area-top); }
.footer { padding-bottom: var(--safe-area-bottom); }
```

Left and right insets are not exposed.

[Docs](https://setup.despia.com/native-features/safe-areas)

---

## Extending the Runtime

Intercept any custom scheme in `WebViewController.swift` (iOS) or `MainActivity.java` (Android), run native code, write the result back as a window variable. The SDK resolves it the same way as built-in schemes.

```swift
// iOS
if requestURL.absoluteString.hasPrefix("mycustom://") {
    webView.evaluateJavaScript("window.myResult = '\(runMyNativeCode())';")
    decisionHandler(.cancel)
    return
}
```

```java
// Android
if (url.startsWith("mycustom://")) {
    webView.evaluateJavascript("window.myResult = '" + runMyNativeCode() + "';", null);
    return true;
}
```

```js
// Web
const { myResult } = await despia('mycustom://', ['myResult']);
```

Full Xcode and Android Studio project export is available for custom native code.

---

## Web Native vs React Native

This SDK is for web-native apps (React, Vue, Angular, Svelte, Next.js, Vite, Nuxt, vanilla JS) running inside the Despia runtime. It is not for React Native, Expo, or native mobile development.

---

## Publishing

iOS and Android store deployment runs from the web editor. Cloud Mac Mini infrastructure handles code signing, provisioning, and submission.

[iOS](https://setup.despia.com/deployment/apple-ios/automatic) · [Android](https://setup.despia.com/deployment/google-android/automatic)

---

## MCP Server

Point your AI assistant at the Despia MCP for the full `despia-native` API.

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://despia.com/mcp/cursor)
[![Install in VS Code](https://img.shields.io/badge/Install_in_VS_Code-007ACC?logo=visualstudiocode&logoColor=white)](https://despia.com/mcp/vs-code)

For web builders (Lovable, Bolt, v0), paste: `https://setup.despia.com/mcp`.

[Setup guide](https://setup.despia.com/mcp-server)

---

## How It Works

The app gives each page one object, `window.despiaBridge`. Every typed call goes through it:

```js
// When you call:
await despia.vault.get({ key: 'sessionToken' });

// the SDK runs:
const reply = await window.despiaBridge.call('vault', 'get', { key: 'sessionToken' });
// { ok: true, value: 'abc123' }  or  { ok: false, error: { code, message, path? } }
```

The payload is real JSON, so there is no URL encoding. Files cross as references (`{ url, name, type, size }`), never as bytes.

Once per page the SDK asks the app what it has (`bridge.hello`) and then picks the channel for each call:

1. **JSON bridge** when the app lists the action.
2. **Protocol URL** when the bridge is missing or does not list the action, and the action has one: the call is translated to the feature's original scheme (for example `vault.get` becomes `readvault://?key=sessionToken`) and the result is read from the window variable the app writes back.
3. **`feature_not_installed`** when neither exists.
4. **`not_in_app`** in a plain browser.

The original `despia('scheme://…', ['variable'])` call is still supported and behaves exactly as before.

No dependencies, no initialization, no lifecycle to manage.

---

## Support

[npm@despia.com](mailto:npm@despia.com)
