# Release notes

## 1.0.0 — unreleased

- Watched empty arrays and objects now complete immediately. For example, purchase history with no purchases returns `[]` rather than waiting for the timeout.
- Explicit `null` now completes multi-variable watches, matching single-variable watches. A native unavailable/error response can therefore resolve as `null`; it is not automatically a successful result.
- Clear watched variables and attach observers before dispatching the native command, so a synchronous native reply is retained rather than cleared after dispatch.
- Keep the existing `undefined`/`"n/a"` waiting rules, timeout durations, command dispatch and native bridge protocol.
- Guard the purchase-history README example with `Array.isArray` and document nullable/empty response values in the TypeScript interface.

Applications that relied on empty collections timing out should explicitly check collection contents. In particular, `if (restoredData)` or `if (!healthkitResponse)` cannot distinguish a valid empty collection from a successful nonempty response. Concurrent watches of the same window variable retain their existing shared-variable behavior.
