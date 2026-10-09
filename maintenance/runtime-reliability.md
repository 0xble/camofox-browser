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

#### Bounded session close

- **Behavior:** `teardownEphemeralSession()` in `lib/session-close.js` bounds
  every step of a non-shared session close at 10 s: the `session:destroying`
  checkpoint, `tracing.stop`, and `context.close()`. When the context does not
  close in time, each page is closed with `runBeforeUnload: false` and its own
  2 s bound. The session and its tab groups are always removed from the
  registry, and timeouts log `session close step timed out` or
  `session context close timed out; closed pages individually`.
- **Evidence:** on 2026-10-09 `hermes_51df174154` logged `session expired` at
  01:57:20Z with no `storage state persisted` after it, while its tab
  `78b10665` had a content process at 100% CPU. The `session_timeout`
  checkpoint only logged at 02:40:24Z, seconds after that process was killed,
  so the teardown was blocked inside the checkpoint (`storageState()` evaluates
  in every page) for 43 minutes, with `context.close()` unbounded behind it.
  `_closing` stopped the timers from retrying, and at 02:09Z `getSession`
  replaced the stuck session, which left its context tracked by nothing.
- **Surfaces:** `server.js` (`closeSessionNow`), `lib/session-close.js`,
  `tests/unit/sessionCloseBounded.test.js`.
- **Regression:** `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/sessionCloseBounded.test.js`.
- **Rollback:** revert the repair commit.
- **Retire when:** upstream bounds ephemeral session teardown.

#### Idle tabs in non-shared sessions

- **Behavior:** the 60 s idle sweep also closes non-shared tabs whose agent has
  been inactive for `CAMOFOX_HIDDEN_TAB_IDLE_MIN` (default 30, `0` disables),
  even while the session stays alive through a sibling tab. It reuses the
  shared-identity rules in `lib/idle-tabs.js` (`tabClosable`): never the most
  recent tab, nor a tab with an active or queued lock, a page lease, a download
  or a human handoff. Activity is any `/tabs/:tabId` request, or a tool call
  counted since the previous sweep.
- **Surfaces:** `server.js` (activity middleware, idle sweep interval),
  `lib/idle-tabs.js`, `tests/unit/idleTabs.test.js`.
- **Regression:** `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/idleTabs.test.js`.
- **Rollback:** set `CAMOFOX_HIDDEN_TAB_IDLE_MIN=0` to disable all idle-tab
  cleanup, or revert the repair commit.
- **Retire when:** upstream closes idle tabs inside live sessions.
