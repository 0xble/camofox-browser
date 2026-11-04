# Native handoff reliability follow-ups

These non-blocking P2 findings were deferred from the approved review of
[PR #51](https://github.com/0xble/camofox-browser/pull/51). They are backlog
requirements only; no runtime behavior changes in this document.

## Return a stable, non-retryable unavailable error

At candidate `7f5373f7a68b5538f702d69a5eaa1e7dc5c2719a`,
`lib/darwin-identity-visibility.js` wraps the sticky `windowControlError` in an
error without `code` or `statusCode`. If its text contains
`identity visibility operation timed out after 12000ms`, `isTimeoutError` can
classify it as HTTP 503 `operation_timeout`, retryable with recovery `retry`,
and count it toward the hang/frustration streak. A 3 s hide plus the 10 s
addon-ready wait can exceed that 12 s deadline. Retrying cannot help while the
startup failure remains sticky.

Done when unavailable native handoff returns a dedicated non-retryable
`handoff_unavailable` error and HTTP 409, does not increment timeout/hang
frustration counters, and regression tests cover a nested timeout message.

## Log degradation and allow bounded recovery

`windowControlError` is only set, never cleared, and is not logged. A slow addon
acknowledgement or transient NSScreen query failure can therefore disable
same-context handoff for a browser context's entire lifetime after the
underlying condition has recovered.

Done when:

- A structured log identifies the failed handoff capability without secrets or
  page content.
- A bounded recovery/re-probe lets the context recover after transient
  display/addon readiness failures while preserving tabs and keeping handoff
  fail-closed until native proof succeeds.
- Regression tests cover one transient startup failure followed by successful
  recovery, and no unhide or human-control transfer on failed proof.

[Reviewed source](https://github.com/0xble/camofox-browser/blob/7f5373f7a68b5538f702d69a5eaa1e7dc5c2719a/lib/darwin-identity-visibility.js#L88-L130).
