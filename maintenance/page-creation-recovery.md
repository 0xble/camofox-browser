# macOS input and page creation maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare both native launch paths and shared page-creation recovery with upstream. Require the recorded regression and disposable-browser evidence before adopting changes to native input or deadline cancellation.

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
