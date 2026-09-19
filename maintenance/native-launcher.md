# Native launcher maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream metadata and launcher capabilities with this patch. Reconcile server metadata and the app together, and retain the recorded API, Swift, and GUI proof before accepting a replacement.

### CAMOFOX-003: dynamic native launcher metadata and app

- **Status:** Active; source and launcher metadata must evolve together, while app installation and service activation remain separate.
- **Stable subject:** `Add dynamic native launcher service API` (`becd7eabedfcbe60bc38525e676a630dd2c16305`).
- **Behavior:** the authenticated loopback API exposes configured shared identity metadata; `macos/CamofoxLauncher/` reads only that API and its credential provider, never aliases or profile state.
- **Surfaces:** `server.js`, `lib/shared-identity-metadata.js`, `openapi.json`, `tests/unit/sharedIdentityMetadata.test.js`, `macos/CamofoxLauncher/`.
- **Regression:** `npm test -- --runInBand tests/unit/sharedIdentityMetadata.test.js`, `swift test`, and an isolated GUI fixture before installation.
- **Rollback:** revert the patch; do not alter Hermes identities, browser profiles, or the managed service.
- **Retire when:** a supported upstream launcher provides the same dynamic identity contract.
