# Maintenance

## Background

Maintained fork: `0xble/camofox-browser` of `jo-inc/camofox-browser` on
the canonical `master` branch. Canonical checkout: `/Users/brianle/camofox-browser`;
implementation worktree: `/Users/brianle/.worktrees/camofox-browser-fork-foundation`.
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

## Update

Rebase recorded patches from the deployed `v1.14.0` baseline onto a deliberately
selected upstream release; do not advance merely because upstream `master` moved.
Update this register with any patch change or retirement before publication.

## Verify

Run the patch regressions above, the repository test/build gates, and inspect the
fork-only diff. Before an upstream-sync claim, require zero upstream-only commits
for the explicitly selected upstream baseline; after publication, read back exact
`origin` SHA parity. Installation and live-service evidence are separately required.
