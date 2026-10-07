# Runtime reliability maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream session teardown, periodic cleanup, and snapshot ref handling
with each repair below. Adopt an upstream equivalent only when its recorded
regression passes against the same failure mode, then retire the local repair.

### CAMOFOX-006: runtime reliability repairs

- **Status:** Active.
- **Upstream checked:** `jo-inc/camofox-browser` master `39c82094` (2026-10-04)
  still has each original behavior. Related closed issue #7162 covers a
  shutdown-time persistence race, not the timer race below.

#### Single session teardown

- **Behavior:** `closeSession()` routes every caller through
  `lib/session-close.js` `closeSessionOnce()`, so the session-expiry timer and
  the tab reaper (which both select an idle session in the same tick) share one
  teardown. The persistence plugin checkpoints once, during
  `session:destroying`, while the context is alive. A rejected close (for
  example an aborted headed transition) can be retried. Both timers also skip
  sessions already marked `_closing`.
- **Evidence:** before the fix, every idle expiry of `hermes_51df174154` logged
  `storage state persisted` (`session_timeout`) followed 20-40 ms later by
  `failed to persist storage state ... has been closed` (129 warnings).
- **Surfaces:** `server.js` (`closeSession`, expiry and reaper timers),
  `lib/session-close.js`, `tests/unit/sessionClose.test.js`.
- **Regression:** `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/sessionClose.test.js tests/unit/sessionDestroyingEvent.test.js plugins/persistence`.
- **Rollback:** revert the repair commit. Persisted state is unaffected.
- **Retire when:** upstream serializes concurrent session closes.
