# Deployment plugins maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare the two local plugin implementations with supported upstream launch and persistence hooks. Adopt changes only after the recorded regressions prove both hardening and authenticated post-persistence snapshots.

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
