# macOS input and page creation maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare both native launch paths and shared page-creation recovery with upstream. Require the recorded regression and disposable-browser evidence before adopting changes to native input or deadline cancellation.

### CAMOFOX-004: macOS mouse and shared tab creation recovery

- **Status:** Active. Installation and runtime verification remain separate.
- **Behavior:** both launch paths enable native mouse humanization on macOS
  only when the selected engine metadata is at least `v158.0.1-beta.41`; old
  or unknown macOS engines fail closed with one warning. Other platforms keep
  humanization enabled. The source/CI pin is `v158.0.1-beta.41`. This supersedes
  the macOS workaround for `v152.0.4-beta.30`; it does not remove page-creation
  recovery. Shared page-creation failures never destroy other tasks' identity
  tabs. Request deadlines fence late continuations and close late pages.
- **Engine evidence:** upstream [6e994b9](https://github.com/daijro/camoufox/commit/6e994b9b16ce8925b6ad8c47b7a3299efb205ea4)
  fixes chrome/content boundary-row acknowledgements (#751/#752), released via
  [PR #756](https://github.com/daijro/camoufox/pull/756), merge `35b45c1`.
  The engine also bounds a missed acknowledgement at 5 s. The locked
  `camoufox-js@0.11.5` launches beta.41; v156 is not compatible.
- **Disposable macOS acceptance:** beta.41 humanized first clicks passed 5/5
  within 2 s (695–1201 ms). Beta.30 missed 1/5 mid-page trials at the 2 s
  bound and wedged in 5/12 top-edge trials at an 8 s bound; beta.41 passed
  12/12 top-edge trials. One additional
  beta.41 trial missed the stricter 2 s bound; it did not reproduce with the
  8 s bound (0/10 misses). These samples justify the regression's 8 s bound,
  not a guarantee that every click finishes within 2 s.
- **Surfaces:** `server.js`, `lib/shared-identity-launch.js`, engine/build pins,
  `lib/new-page-recovery.js`, `lib/request-deadline.js`, `lib/browser-errors.js`,
  `openapi.json`.
- **Upstream issue/PR:** None after bounded searches for new-page and mouse
  timeouts on 2026-09-15. Upstream master `79d425be2674` still has the same
  destructive new-page recovery helper. This is an urgent scoped repair, not an
  upstream synchronization. The later engine upgrade above retires only the
  native-humanization workaround; page-creation recovery remains fork-owned.
- **Regression:** focused new-page, request-deadline, native-humanization,
  browser-error and shared-identity tests, plus `tests/e2e/nativeHumanize.test.js`
  and disposable browser acceptance.
- **Rollback:** revert this patch and reinstall a retained verified release.
  Retain all identity profiles and checkpoints. Old behavior can reintroduce
  cross-task tab loss, so a rollback is not a recovery guarantee.
- **Retire when:** supported upstream provides working macOS native input and
  cancellation-safe shared page creation with equivalent regression evidence.
