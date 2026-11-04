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
  default-browser checks, telemetry, reporting, and studies, and preserve beta.30's
  automation popup policy (`dom.disable_open_during_load=false`). beta.41 restores
  Firefox's blocker; its driver-only exemption does not cover synthetic `_blank`
  links because retargeting is checked in the parent process. Both launch paths
  use this hook. This deliberately retains beta.30's page-observable global popup
  allowance rather than beta.41's no-gesture popup anti-detection improvement.
  `local-storage-checkpoint`
  authenticates its storage-state endpoint and returns a snapshot only after persistence.
- **Surfaces:** `plugins/local-hardening/`, `plugins/local-storage-checkpoint/`,
  `camofox.config.json`
- **Upstream issue:** No exact Camofox issue after checked 2026-11-03; #7742
  concerns viewport sizing, not popup blocking.
- **Upstream PR:** [Camoufox #779](https://github.com/daijro/camoufox/pull/779)
  and beta.41's [`popup-blocker-parity.patch`](https://github.com/daijro/camoufox/blob/c3ad3bf2c3c6e93225aa6587246c8b70f9314664/browser/patches/popup-blocker-parity.patch)
  document intentional blocker parity and the synthetic-link limitation.
- **Regression:** `npm run test:plugins`,
  `NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand tests/unit/tabLifecycleContract.test.js tests/e2e/popupLaunchPolicy.test.js`,
  and `CAMOFOX_PACKAGE_DIR=$PWD node --test plugins/local-storage-checkpoint/index.test.js`
- **Rollback:** `git revert <CAMOFOX-001 commit>`
- **Retire when:** upstream releases equivalent supported plugin behavior and the
  deployment configuration no longer needs the local plugins.
