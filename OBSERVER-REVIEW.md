# Observer completion review

This WIP changes the maintained `despia-native` consumer SDK, not the native DSX response contract. It is not published and retains the existing package version until release approval.

An actual iPhone 17 probe found `revenuecat.history` returns a raw empty array and `getpurchasehistory://` assigns `window.restoredData=[]`. Version 1.0.28's single-variable observer rejects this valid response, then returns undefined after 30 seconds. Empty contacts objects suffer the same rejection. Its multi-variable observer also rejects null, although the owner-approved native unavailable-data contract explicitly writes null to complete callers.

The correction accepts fresh empty arrays/objects and explicit null. It clears old watched values and starts observing before command dispatch, so a synchronous native response cannot be deleted. Undefined and `"n/a"` remain pending, and the existing single-variable 30-second and multi-variable five-minute timeout behavior remains intact. No third timeout argument is introduced.

Run `npm test`. The independent public-callable tests execute the shipping UMD entry point in a controlled browser/timer fixture: valid empty/scalar responses, explicit null across multiple variables, synchronous native response, stale globals, delayed response, timeout, and fire-and-forget dispatch. Baseline 1.0.28 fails four cases; corrected source passes all 13 cases. These are consumer tests, not a substitute for device proof. The iOS lane will privately serve this exact WIP entry point to the existing native fixture and verify actual history completes with an empty array; no fake native bridge or public CDN change is permitted.

Publishing npm, a module mirror, or switching a public CDN remains owner-gated. No native signing, keys, production data, or customer messaging is changed.
