# Maintenance

## Background

Maintained fork: `0xble/camofox-browser` of `jo-inc/camofox-browser` on
the canonical `master` branch. Canonical checkout: `/Users/brianle/Repos/camofox-browser`.
Accepted deployed baseline: upstream tag `v1.14.0`, commit
`e5a36f5cd0332fde6597de474329a308a53a0716`. `origin` is the owned publish
remote; `upstream` is fetch-only and must never receive pushes. The upstream MIT
`LICENSE` is retained unchanged.

## Preserve

- This fork owns deployment plugins and its matching plugin configuration, not a
  Camoufox/Firefox engine fork or a Hermes configuration.
- Deployment, installation, and runtime activation are distinct stages.

## Active patches

### CAMOFOX-001: track reviewed local deployment plugins

- **Status:** Active
- **Stable subject:** `Add hardened local deployment plugins` (`b2a15d5ea8fc73e99eb9636968eec5102e404ff6`)
- **Behavior:** `local-hardening` applies the supported launch hook to disable
  default-browser checks, telemetry, reporting, and studies. `local-storage-checkpoint`
  authenticates its storage-state endpoint and returns a snapshot only after persistence.
- **Surfaces:** `plugins/local-hardening/`, `plugins/local-storage-checkpoint/`,
  `camofox.config.json`
- **Upstream issue:** None after checked 2026-09-09
- **Upstream PR:** None after checked 2026-09-09
- **Regression:** `npm run test:plugins` and `CAMOFOX_PACKAGE_DIR=$PWD node --test plugins/local-storage-checkpoint/index.test.js`
- **Rollback:** `git revert <CAMOFOX-001 commit>`
- **Retire when:** upstream releases equivalent supported plugin behavior and the
  deployment configuration no longer needs the local plugins.

### CAMOFOX-002: shared persistent identity lifecycle

- **Status:** Active; managed installation is authorized only from the landed fork SHA.
- **Stable subject:** `Add shared persistent identity lifecycle` (`85d2f3f`).
- **Behavior:** native Hermes opaque IDs and optional local aliases resolve to one profile; session-only cookies restore only after a clean close; human handoff serializes with tab work and blocks agent operations.
- **Surfaces:** `server.js`, `lib/shared-identity.js`, `lib/config.js`, `docs/shared-persistent-browser-spec.md`
- **Upstream issue/PR:** None after checked 2026-09-10.
- **Regression:** `npm run test:unit` plus the disposable shared-browser acceptance harness.
- **Rollback:** `git revert <CAMOFOX-002 commit>`; do not delete preserved profiles.
- **Retire when:** upstream ships equivalent lifecycle and identity-routing semantics.

### CAMOFOX-003: dynamic native launcher metadata and app

- **Status:** Active; source and launcher metadata must evolve together, while app installation and service activation remain separate.
- **Stable subject:** `Add dynamic native launcher service API` (`becd7eabedfcbe60bc38525e676a630dd2c16305`).
- **Behavior:** the authenticated loopback API exposes configured shared identity metadata; `macos/CamofoxLauncher/` reads only that API and its credential provider, never aliases or profile state.
- **Surfaces:** `server.js`, `lib/shared-identity-metadata.js`, `openapi.json`, `tests/unit/sharedIdentityMetadata.test.js`, `macos/CamofoxLauncher/`.
- **Regression:** `npm test -- --runInBand tests/unit/sharedIdentityMetadata.test.js`, `swift test`, and an isolated GUI fixture before installation.
- **Rollback:** revert the patch; do not alter Hermes identities, browser profiles, or the managed service.
- **Retire when:** a supported upstream launcher provides the same dynamic identity contract.

### CAMOFOX-004: macOS mouse and shared tab creation recovery

- **Status:** Active. Installation and runtime verification remain separate.
- **Behavior:** disable native mouse humanization on macOS in both launch paths.
  A disposable local button fixture on engine 152.0.4 beta.30 hung with
  humanization enabled and completed in 91 ms with it disabled. Other platforms
  retain humanization. Shared page-creation failures never destroy other tasks'
  identity tabs. Request deadlines fence late continuations and close late pages.
- **Surfaces:** `server.js`, `lib/new-page-recovery.js`, `lib/request-deadline.js`,
  `lib/browser-errors.js`, `openapi.json`.
- **Upstream issue/PR:** None after bounded searches for new-page and mouse
  timeouts on 2026-09-15. Upstream master `79d425be2674` still has the same
  destructive new-page recovery helper. This is an urgent scoped repair, not an
  upstream synchronization or engine upgrade.
- **Regression:** focused new-page, request-deadline, native-humanization,
  browser-error and shared-identity tests, plus disposable browser acceptance.
- **Rollback:** revert this patch and reinstall a retained verified release.
  Retain all identity profiles and checkpoints. Old behavior can reintroduce
  cross-task tab loss, so a rollback is not a recovery guarantee.
- **Retire when:** supported upstream provides working macOS native input and
  cancellation-safe shared page creation with equivalent regression evidence.

## Update

### 2026-09-16 upstream reconciliation

- Upstream default branch: `master`, checked at
  `79d425be2674` (server version `1.16.0`). The prior fork was
  `7d6de5d`; the prior installed release was `166c992`.
- Preserve CAMOFOX-001 through CAMOFOX-004. Merge upstream HTTP navigation
  status reporting with the existing cancellation fence, and retain shared
  keep-open exclusions alongside upstream's disabled-session-timeout support.
- Retain the fork's existing bounded CI layout and Node checkpoint-test lane.
  Dependency overrides now match upstream, including `fast-uri` 3.1.7.
- Read upstream `AGENTS.md` and `CONTRIBUTING.md` at the fetched revision.
  Related upstream persistent-profile PR #6525 is closed. Reliability PR #9538
  is open and proposes active-session memory restarts and faster crashed-tab
  cleanup, not a released equivalent of our shared-profile lifecycle. Do not
  import its session destruction into keep-open identities.
- Camoufox engine release `v152.0.4-beta.30` remains the latest published
  engine. Engine issues #719 (unresponsive Juggler pipe) and #762 (content
  process memory crash) are related reports, not confirmed local root causes.
- Source synchronization does not prove installation. Deploy a separately
  verified immutable release from the landed fork and retain profile backups.

On every maintenance run, fetch `origin` and `upstream` separately, resolve the
live upstream default branch (currently `master`), and reconcile the maintained
`master` with its latest tip while preserving the registered deployment patches.
The deployed `v1.14.0` baseline is historical provenance, not a source-sync pin.
Review linked upstream issues/PRs and replacement behavior; update this register
before publishing any patch change or retirement. Run the patch regressions and
repository test/build gates, then publish only to `origin` and read back its SHA.
If reconciliation, tests, or publication cannot complete safely, report `Blocked`
with the exact failing stage, refs, and recovery action; never silently defer sync.
Installation, deployment, and runtime activation require separate authorization.

## Verify

Inspect the fork-only diff and retain the verification evidence above. Immediately
before `Updated` or `Already current`, fetch upstream again and require
`git rev-list --left-right --count upstream/<live-default>...master` to report zero
on the left (upstream-only), with the exact fetched upstream SHA recorded. If it
moved, reconcile and reverify or report `Blocked`. Require published `origin/master`
to equal the verified maintained SHA. Source-sync success proves no installation
or live-service activation; those stages need their own evidence and rollback.
