# Native handoff reliability fixes

This branch implements the two P2 findings from [PR #51](https://github.com/0xble/camofox-browser/pull/51).

## Stable unavailable error

An unavailable native controller now throws HTTP 409 `handoff_unavailable`.
The response is non-retryable and has no recovery hint. The original error is
retained as `cause`, not appended to the public message. Typed handling takes
precedence over timeout/closed-browser text in error classification and route
handling, so this degradation does not increment tab frustration/hang streaks
or destroy a session. Agent pages remain live; failed handoff does not transfer
human control or unhide the application.

## Diagnosable degradation

Prepare and attach failures emit a WARN at degradation time. The production
logger is forwarded through both direct and parking-fallback launch paths.
Capability and `/health.visibility.handoffUnavailable` expose the stage,
sanitized cause, stable code and `relaunchRequired: true`. Profile paths and
private HTTP endpoints are redacted. No identity name or page content is added.

### Why recovery remains explicit

The addon path is selected before Firefox launches. When prepare fails, creating
a new controller during a later handoff cannot install that addon into the
already-running context. Replacing a controller whose attach timed out would
also replace its private endpoint while the old attach continuation may still
be pending. A safe late-ready recovery needs a separately designed, cancellable
readiness protocol; simply clearing the cached error or re-running prepare
would advertise a capability the running browser has not acquired. This patch
therefore retains fail-closed degradation for that context and does not close,
restart, or relaunch any browser automatically.

## Cookies startup investigation

The cookies test picked random ports in 3100..3999. That range includes 3659,
which Node Fetch rejects as `bad port` **before connecting**, even when an HTTP
listener is healthy. The poll loop swallowed every fetch error and eventually
reported only `Server failed to start`. A local listener + Fetch probe reproduces
this deterministically. The original CI attempt did not log its selected port,
so attribution of that individual failure to 3659 remains unproven; no
`EADDRINUSE` appeared in its failed-step log.

The fixture now requests port 0, learns the actual bound port from the child's
listen event/log, and probes that exact IPv4-loopback listener. This removes
both the unsafe port draw and the probe/release reservation race. It detects
child exit/start errors immediately, includes bounded startup output on
failure, and awaits termination (with an unconditional SIGKILL fallback for a
still-live child) before the next describe. Profile/cookie/upload/trace state is
isolated under a disposable directory. No skips, retries or timeout increases
are used. Regression coverage forces the old random draw to 3659, starts two
fixtures concurrently, and verifies that their exact ports are released.

Failed run 41927046496 attempt 1 contained the cookies startup failure; the
rerun passed. The four older failures are **not the same test**:

- 41788632846: sharedPersistentLifecycle popup registration.
- 41782622478: sharedPersistentLifecycle plus sharedIdentityVisibilityRoutes,
  sharedIdentityTopologyRoutes and amazonSearchNavigation unit failures.
- 41773703269: sharedPersistentLifecycle popup registration.
- 41768613612: sharedPersistentLifecycle plus viewport, evaluateNavigationRace,
  snapshotRefsRerender and scroll failures.

These older failures are outside this follow-up; this branch does not change
their assertions or hide them.
