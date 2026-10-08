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

Add 50+ native iOS and Android capabilities to any web app (React, Vue, Angular, Svelte, Next.js, vanilla JS) through a single `despia()` function. Plus native offline support, a local SQLite database, and an on-device streaming CDN, solving 15 years of hybrid-app problems with modern runtime architecture.

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
despia(`revenuecat://launchPaywall?external_id=${userId}&offering=default`);

// Link the device to your user for OneSignal push
despia(`setonesignalplayerid://?user_id=${userId}`);

// Store a session token behind Face ID / Touch ID (survives reinstall)
await despia('setvault://?key=sessionToken&value=abc123&locked=true');

// Read it back later (prompts biometric)
const { sessionToken } = await despia('readvault://?key=sessionToken', ['sessionToken']);
```

No initialization. Open your app in the Despia runtime and it works.

---

## Why Despia

Despia is a hybrid app runtime built on the web platform. The web handles what it's good at (logic, UI, routing, state, storage); everything else (biometrics, push, in-app purchases, background GPS, system pickers) is handed to a native engine via a single `despia()` call.

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

The SDK only activates inside the Despia runtime. Gate native calls:

```js
const isDespia = navigator.userAgent.toLowerCase().includes('despia');

const isDespiaIOS = isDespia && (
  navigator.userAgent.toLowerCase().includes('iphone') ||
  navigator.userAgent.toLowerCase().includes('ipad')
);

const isDespiaAndroid = isDespia && navigator.userAgent.toLowerCase().includes('android');

if (isDespia) despia('lighthaptic://');
```

---

## For AI Coding

Full API context: [`llms.txt`](https://setup.despia.com/llms.txt).

- Import as default: `import despia from 'despia-native'`
- Never write `window.despia` directly; the SDK uses it internally
- There is no `.init()`, `.ready()`, or `.setup()`; the SDK exports a single function with no initialization
- Do not mock or reimplement the SDK; mock implementations will not trigger the native runtime on real devices
- Gate native calls with the environment check above
- For Local Server apps, install via a package manager so the SDK ships with the build
- Do not `await` `localcdn://write` with a watch key; use `window.contentServerChange`
- For the upload API, read `window.location.host`; don't hardcode ports

---

## API Reference

### `despia(command, watch?)`

| Parameter | Type       | Description                                    |
| --------- | ---------- | ---------------------------------------------- |
| `command` | `string`   | A Despia protocol URL, e.g. `'lighthaptic://'` |
| `watch`   | `string[]` | Variable names to wait for                     |

Returns a `Promise` that resolves when all watched variables are set, with a 30-second timeout. Long-running work (downloads, purchases, biometric prompts) reports back via global callbacks like `window.onRevenueCatPurchase` or `window.contentServerChange` instead. `despia.variableName` is equivalent to `window.variableName`.

Protocol format: `feature://action?param1=value1&param2=value2`

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

### RevenueCat In-App Purchases

```js
// Paywall
despia(`revenuecat://launchPaywall?external_id=${userId}&offering=default`);

// Direct purchase
despia(`revenuecat://purchase?external_id=${userId}&product=monthly_premium_ios`);
```

`window.onRevenueCatPurchase()` fires when the store confirms a transaction. Verify entitlement before unlocking (via your backend webhook, or by reading the store directly):

```js
window.onRevenueCatPurchase = async () => {
  const { restoredData } = await despia('getpurchasehistory://', ['restoredData']);
  if (Array.isArray(restoredData) && restoredData.some(p => p.isActive && p.entitlementId === 'premium')) unlockPremium();
};
```

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
await despia('setvault://?key=sessionToken&value=abc123&locked=true');

// Read (prompts biometric if locked)
const { sessionToken } = await despia('readvault://?key=sessionToken', ['sessionToken']);
```

`readvault://` throws if the key doesn't exist. Wrap in try/catch.

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
despia.appsFlyerAttribution
despia.appsFlyerReferrer
despia.appsFlyerUID

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
window.onLocationChange = (data) => {
  if (data.active) console.log(data.latitude, data.longitude);
};

// buffer in seconds, movement threshold in centimetres
despia('location://?buffer=60&movement=100');

const { locationSession } = await despia('stoplocation://', ['locationSession']);
```

Add `&server=https://api.example.com/track` to POST each point as it's recorded.

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
despia('lighthaptic://');   // Subtle
despia('heavyhaptic://');   // Strong
despia('successhaptic://'); // Success
despia('warninghaptic://'); // Warning
despia('errorhaptic://');   // Error
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
const { versionNumber, bundleNumber } = await despia('getappversion://', ['versionNumber', 'bundleNumber']);
const { uuid }             = await despia('get-uuid://',              ['uuid']);
const { storeLocation }    = await despia('getstorelocation://',      ['storeLocation']);
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

The SDK is a thin wrapper over a setter-based protocol bridge. Calling `despia()` assigns the scheme string to `window.despia`, which the native layer intercepts:

```js
// When you call:
despia('lighthaptic://');

// the SDK does:
window.despia = 'lighthaptic://';
```

iOS intercepts the assignment in `WebViewController.swift`; Android intercepts it in `MainActivity.java`. Results come back as named window variables, which the SDK resolves as a promise via the optional `watch` array. For long-running work (downloads, purchases, biometric prompts), the native layer calls back via global functions like `window.onRevenueCatPurchase` or `window.contentServerChange` instead.

No dependencies, no initialization, no lifecycle to manage.

---

## Support

[npm@despia.com](mailto:npm@despia.com)

## Watched response values

A watched native response can be `null`, an empty array (`[]`), or an empty object (`{}`). These values complete the request immediately. `null` can indicate unavailable data or failure; an empty collection can be a valid result, so check the response shape before treating it as success. Values that are `undefined` or `"n/a"` continue waiting until the existing timeout. See [release notes](CHANGELOG.md) for the observer changes in 1.0.0.
