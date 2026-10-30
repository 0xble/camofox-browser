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
  `session context close unconfirmed; closed pages individually`. Rejection is
  not proof of closure: only a fulfilled close, a public close event, or a
  closed-state readback confirms disposal. Unconfirmed rejected closes use the
  same bounded page fallback and abandoned-context retries as timed-out closes.
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

#### Idle Reclamation During Context Acquisition

- **Behavior:** both idle-shutdown admission checks and the idle memory-pressure
  sweep treat the existing `sessionCreations` map as active work. An ordinary or
  shared context can be acquiring before it appears in `sessions`, so an armed
  idle timer must recheck that map before closing the browser. Failed acquisition
  releases its marker and permits normal idle reclamation again. This adds no
  identity lock or queue. Explicit administrative stop, disconnect and process
  shutdown retain their existing close authority.
- **Surfaces:** `server.js` (`scheduleBrowserIdleShutdown`, idle memory-pressure
  interval), `tests/unit/idleShutdown.test.js`.
- **Regression:** `NODE_OPTIONS=--experimental-vm-modules npx jest --runInBand --forceExit --runTestsByPath tests/unit/idleShutdown.test.js tests/unit/memoryPressure.test.js`.
  The lifecycle tests evaluate the actual server functions with deferred ordinary
  and shared acquisition. They cover old timers, both pressure thresholds,
  successful and rejected acquisition, true-idle reclamation, explicit close
  authority and passive health. The same tests also support Node's focused runner.
- **Upstream checked:** `jo-inc/camofox-browser` master
  `39c82094013480b373df6600d44c7f036f58356e` (2026-10-26) still checks only
  published sessions in both idle paths. No released equivalent was found in the
  related lifecycle work checked during preflight.
- **Rollback:** revert this repair. No persisted state or configuration changes.
- **Retire when:** upstream excludes in-flight acquisition from both idle browser
  reclamation paths and the same regressions pass.

#### Settling timed-out tab operations

- **Behavior:** a route timeout is not browser cancellation. The existing tab
  lock stays active until its route continuation and nested `withTimeout`
  browser promises settle. Queued and new actions, including human handoff,
  receive retryable `503 tab_busy` instead of overlapping abandoned work.
  Snapshot work uses the same boundary because proxy recovery can navigate.
  Snapshot capture is refused with `409 tab_handed_off` until control returns
  to the agent. Snapshot queue/handler timeouts use the same timeout policy.
  Sibling tabs remain independent. Settling refusals feed the existing 3-timeout
  streak: a failed bounded liveness probe retires only that exact tab and returns
  `410 tab_destroyed`, `recovery=create_new_tab`. Concurrent retries do not
  duplicate probes or cleanup. Healthy, navigating, human-controlled, settled
  or replacement targets are preserved during the grace period. Every abandoned
  lock has a separate 30 s settling ceiling, measured from the route returning
  with pending browser work. No retry is required, and liveness probes cannot
  extend it. At the ceiling the exact old lock is retired before bounded page
  closure, then the tab is removed and callers must create a new tab. The old
  page is quarantined from all registration paths even when closure cannot be
  confirmed, so it cannot acquire a fresh tab ID and overlap abandoned work.
  Both parked and legacy handoff selection exclude it before opening or focusing
  a page, including requested-tab, last-used and context-page fallbacks. Download
  file cleanup cannot retain the lock or keep its identity busy. Normal settlement
  and explicit close cancel the timer. Deferred lock release is one-shot, even
  for detached continuations or a replaced tab.
- **Upstream checked:** `jo-inc/camofox-browser` master
  `39c82094013480b373df6600d44c7f036f58356e`. PR #14623 proposes skipping the
  lock for long evaluates, not cancellation or a bounded abandoned-work lifetime.
  Preserve serialization rather than adopting overlapping page actions.
- **Surfaces:** `server.js` (`withTabLock`, `withTimeout`, snapshot),
  `lib/browser-errors.js`, `tests/unit/tabOperationSettling.test.js`,
  `tests/unit/timeoutContinuation.test.js`.
- **Regression:** `node --test tests/unit/abandonedTab.test.js` runs the
  deterministic-clock ceiling, nested timeout, stale timer, late continuation,
  bounded page-close and identity-handoff cases without a browser or dependencies.
  The Jest unit lane also runs these tests alongside
  `tests/unit/tabOperationSettling.test.js` and `tests/unit/timeoutContinuation.test.js`.
- **Rollback:** revert the repair commit. No persisted state changes.
- **Retire when:** upstream guarantees cancellation or equivalent per-tab
  settling before allowing newer work or human handoff.
