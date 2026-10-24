# Inline Upload Compatibility

Read the [root contract](../MAINTENANCE.md) first. This unit is required on every
maintenance run and is not independently enrolled.

## CAMOFOX-007: Cross-Host File Uploads

- **Contribution route:** Intentional fork extension for callers whose filesystem
  is not the browser server's filesystem. No upstream contribution is authorized.
- **Upstream baseline:** `jo-inc/camofox-browser` master
  `39c82094013480b373df6600d44c7f036f58356e` still accepts only sandboxed paths.
  Related, not adopted: [upload strategies #8273](https://github.com/jo-inc/camofox-browser/pull/8273),
  [superseded upload #4164](https://github.com/jo-inc/camofox-browser/pull/4164),
  [route-local evaluate parsing #8398](https://github.com/jo-inc/camofox-browser/pull/8398),
  and [path-only MCP proposal #13721](https://github.com/jo-inc/camofox-browser/pull/13721).
- **Fork surfaces:** `server.js` upload route and OpenAPI source,
  `lib/upload-files.js`, and generated `openapi.json`. These supply inline
  Playwright FilePayloads through the existing attachment strategies rather than
  adding an endpoint, client, or temporary-file store.
- **Adoption rule:** Preserve both the legacy path contract and the additive
  inline contract when adopting upstream upload or parser changes. Do not widen
  the global JSON limit or parse large inline requests before access-key and
  shared-identity tracking middleware. Attachment failures can be ambiguous,
  so never add automatic replay or strategy fallback after dispatching inline
  payloads. Keep payload content out of telemetry.
- **Proof surface:** `tests/unit/uploadRoute.test.js` drives the actual route and
  parser over loopback HTTP, including size boundaries and metadata-only events.
  `tests/e2e/upload.test.js` reads actual browser File bytes through direct,
  delayed-panel and cross-origin iframe chooser attachment. These browser tests
  own isolated storage/profile roots and must not reuse authenticated identities.
- **Delivery boundary:** Source support precedes any future client rollout.
  Mac server installation and activation require separate migration coordination.
- **Rollback:** Revert this extension before enabling an inline client, or revert
  the client first. Legacy path uploads do not require migration.
- **Retirement:** Replace this divergence only when released upstream supports
  the same wire format, byte/name validation, limits, telemetry and exact-once
  attachment behavior, with both proof surfaces passing.
