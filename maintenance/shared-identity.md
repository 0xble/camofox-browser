# Shared persistent identity maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream identity routing, cookie restoration, and handoff behavior with this patch. Adopt changes only when the recorded unit and disposable-browser proofs preserve the shared lifecycle.

### CAMOFOX-002: shared persistent identity lifecycle

- **Status:** Active; managed installation is authorized only from the landed fork SHA.
- **Stable subject:** `Add shared persistent identity lifecycle` (`85d2f3f`).
- **Behavior:** native Hermes opaque IDs and optional local aliases resolve to one profile; normal agent sessions use parking when available and native application hiding on macOS without parking. Legacy headless sessions require explicit `allowRestart: true` on `/browser/identities/:userId/open` to discard live tab state and transition to headed with a clean-close cookie checkpoint, most-recent URL restoration, busy refusal, and stale-tab invalidation; session-only cookies restore only after a clean close; human handoff serializes with tab work and blocks agent operations. Headed windows of an identity in `CAMOFOX_SHARED_IDENTITY_MAP` show a browser-chrome indicator: a per-identity color (from `CAMOFOX_IDENTITY_COLORS` when that alias has a `#rrggbb`, otherwise `INDICATOR_PALETTE` by sorted alias) and a white alias label, applied by a generated `theme`-only WebExtension loaded as a temporary add-on for headed launches only (`lib/identity-indicator.js`). Camoufox 152 ignores `userChrome.css` even with `toolkit.legacyUserProfileCustomizations.stylesheets`, and does not activate a temporary static theme, so `browser.theme.update()` is the working mechanism. The add-on has no content scripts or web-accessible resources and is never written into the profile; headless launches are unchanged. A 2026-10-06 check on engine 152.0.4-beta.30 showed identical `innerWidth/innerHeight`, `prefers-color-scheme` and system colors with and without it. Authenticated `/browser/identities/:userId/release` checkpoints and closes legacy contexts without relaunching only when no live pages remain or `all: true` explicitly accepts losing all live tab state; busy work, downloads, and human handoffs return 409 without teardown. HID inactivity alone may release headed identities after 30 minutes; unavailable HID readings never trigger release. Headless tabs idle for 30 minutes are reaped except the most recent and active/leased tabs; headless sessions idle from agent activity close after 120 minutes if not busy/downloading. Configure these independently via `CAMOFOX_HEADED_IDLE_RELEASE_MIN`, `CAMOFOX_HIDDEN_TAB_IDLE_MIN`, and `CAMOFOX_HIDDEN_SESSION_IDLE_MIN` (0 disables, invalid uses default). The macOS HID reader is isolated from route/core code and fails closed on unsupported platforms, `ioreg` errors, or malformed output. Direct sessions also pass the configured fingerprint locale into Camoufox and Playwright `locale` plus `timezoneId` into the persistent context, reading the same `CONFIG.directIdentity` as ephemeral contexts. A configured proxy (`!!proxyPool`) skips both, but shared persistent contexts are never themselves proxied or GeoIP-spoofed, so they also get no geolocation permission or coordinate.
- **Surfaces:** `server.js`, `lib/shared-identity.js`, `lib/identity-indicator.js`, `lib/shared-identity-launch.js`, `lib/darwin-identity-visibility.js`, `lib/config.js`, `lib/macos-hid-idle.js`, `lib/shared-identity-idle.js`, `lib/downloads.js`, `docs/shared-persistent-browser-spec.md`
- **Upstream issue/PR:** jo-inc/camofox-browser issue #7990 covers native headed mode; open PR #10992 proposes persistent-profile preservation across expiry and VNC handoff. Neither supplies this fork's headless-to-headed named identity transition; assess compatibility before adopting either.
- **Regression:** `npm run test:unit` (including `tests/unit/identityIndicator.test.js` and `tests/unit/sharedIdentityLaunchIdentity.test.js`) plus the disposable shared-browser acceptance harness, with a headed screenshot per mapped identity.
- **Rollback:** `git revert <CAMOFOX-002 commit>`; do not delete preserved profiles.
- **Retire when:** upstream ships equivalent lifecycle and identity-routing semantics.

### Parked-window handoffs

When a session has a visibility controller, human handoff must await that controller's `open(page)` before reporting focus or changing control ownership. Agent return must use the same targeted `release({ all: false, page })` behavior as `/release {tabId}`. Both paths recompute headed state from live visibility even on failure, retain the context and sibling tabs, and add no identity-wide lock or transition gate. Last-URL restoration must create an API parked page through `session.createPage`, rather than reuse an unowned initial UI page. Legacy show and release refuse to discard live tabs by default. `/open` requires explicit `allowRestart: true` for a destructive headless transition, while `/release` requires `all: true` for a destructive whole-context close. `all` and `tabId` cannot be combined.

Hidden-session expiry is distinct from visibility release: eligible expired
contexts snapshot cookies and recheck eligibility immediately before closing,
without parking them again or adding an identity transition gate. The final check
excludes visible windows, active or queued work, page leases, downloads, human
control, and in-progress transitions. Parked open/focus requests count as active
work without gating one another, and honor the existing closing-state refusal.
Expiry only clears locks after that check and downloads after teardown.
Regression coverage: `sharedIdentityExpiry.test.js`.

Regression coverage: `sharedTabHandoffRoutes.test.js`, the generated-add-on bridge handoff test in `sharedIdentityVisibility.test.js`, and the parked/legacy last-URL restoration test in `sharedIdentityVisibilityRoutes.test.js`.

### Single-Display macOS Handoffs

Without parking, create a headed context and hide its application before exposing
any caller tabs. Resolve the browser PID from this server's descendants and exact
profile for every native operation. AppKit hide/unhide must confirm `hidden`
state, never close or relaunch an established context, and request no OS grants.
Drive the native run loop during bounded readback, because AppKit caches the
application state until it processes updates. Sleeping does not refresh it.
The operation is identity-wide, so preserve all human-controlled sibling tabs on
release and on agent return. Failed initial hiding fails acquisition rather than
retrying headless. Failed visibility changes on live contexts retain their pages.
`CAMOFOX_PARK_DISPLAY=off` disables parking, not same-context application hiding.

Regression: `node --test tests/unit/sharedIdentityHidden.test.js`, the same tests
in the normal Jest unit suite, and `tests/e2e/sharedPersistentLifecycle.test.js`
on macOS with parking disabled. Exercise first acquisition, lazy open, repeated
release/reopen, sibling form input, native refusal, and protected human siblings.

### Native main-display app-hidden handoff

- AppKit `hidden=false`/`active=true` proves application state, not physical
  placement of the requested window. Prepare the existing visibility addon
  before persistent launch in show-only mode; never park/create/close windows.
  Display discovery and addon readiness are optional for agent acquisition: their
  failure leaves AppKit hiding and tab creation working, but handoff fails closed
  before unhide with no visible/focused success or ownership transfer.
- Resolve the exact tab/window with the temporary title marker, then bind its
  native CG number using an unused horizontal main-display position signature. beta.41
  fingerprint-controlled native sizes do not reliably follow resize requests,
  and macOS clamps vertical position for tall fingerprint-sized windows.
  Reserve positions absent from current native windows and other bindings;
  never accept a main-display sibling or empty window list as target proof.
  Revalidate the position reservation against a fresh native list immediately
  before each bind update; readbacks before this reservation cannot bind a number.
- Discover NSScreen main geometry afresh, move only the resolved window with
  `browser.windows.update`, and require bound-number native main-placement proof
  before ownership transfer. Focus requires that exact window frontmost within
  its app plus final read-only AppKit active state. Inactive success remains
  `{visible:true,focused:false}`. Abort/expiry invalidates delayed native work.
- Failure keeps the identity protected from expiry with all tabs intact. Release
  still hides the application. No new dependencies, AX/Accessibility or Screen
  Recording grants, profile edits, restart, or display reconfiguration are needed.
  Already-running contexts without the addon need separately authorized normal
  context replacement; publishing source does not activate it.
- Regress with app-hidden/native visibility unit suites and the explicit macOS
  disposable-browser check `node --test tests/native/mainDisplayHandoff.mjs`.
  It records bound-number/main-display geometry and proves retained PID,
  target/sibling unsaved inputs and off-main sibling preservation over repeated
  handoff/release. It never connects to the running server.
- Upstream preflight: `jo-inc/camofox-browser` master `39c8209` has no corresponding
  native visibility helper. All-state handoff/visibility/headed/persistent
  searches found related closed headed/container issue #7990 and closed
  persistent-profile PR #6525, not an equivalent native per-window proof.
  This is fork-owned CAMOFOX-002 behavior. Retire when upstream supplies the
  same preserving native-verified lifecycle. Roll back by reverting this change
  and separately replacing contexts only when authorized; live tabs stay owned.

### Bounded identity open

The open endpoint has a 60-second caller deadline (`sharedIdentityOpenTimeoutMs`
in the JSON config, positive values within Node's timer range). Never-settling
parking discovery, focus, launch, snapshot or visibility work returns explicit
503 `identity_transition_timeout` instead of retaining a caller and returning
`identity busy` for hours. The raw browser operation retains profile ownership;
there is no cancellation, implicit retry, new identity lock or queue. While it
is unresolved, later identity/tab requests fail with that same 503, idle cleanup
leaves the session untouched, and late continuations check before closing,
launching, creating or navigating a new page. Settling releases the guard.
Independent parked windows retain their concurrent behavior. Terminal/recovery
close reasons (`shutdown:*`, `admin_stop`, `browser_restart:*`,
`browser_disconnected`) bypass this block so a never-settling open cannot prevent
browser recovery. Bulk session teardown records and logs each failure, then
continues checkpointing the remaining sessions. Ordinary identity-request closes
and idle cleanup remain blocked. `unavailableIdentityRecovery.test.js` exercises
these exceptions and the preserved block using an unresolved real opener.

Upstream `39c82094013480b373df6600d44c7f036f58356e` has no named shared-identity
opener. Related issues #15183 and #14620 concern ephemeral context/page timeout
recovery, not this fork's persistent-profile ownership. Keep this bounded local
adaptation until an upstream equivalent passes `sharedIdentityDeadline.test.js`
and the existing shared-identity lifecycle suites. Revert the bounded-open
commit to roll back without deleting profiles. Exact-origin matching is unchanged.

### Changing Display Topology

Rediscover on creation, visibility commands, health checks, and failed creation. Never
use the main display for hidden parking. Invalidate native bindings when topology
changes. Without an eligible display, retain contexts and pages, create ordinary
tabs without claiming they are hidden, and refuse show/release with 409
`parking_unavailable`. Reconnection or resize updates the add-on target in place.
Existing legacy contexts are never silently replaced when a display reconnects.

`/health.visibility` reports mode, parking eligibility, same-context session count,
restart-required legacy session count, and failed-window count separately from
server liveness. A missing display alone does not fail liveness.

### Popup Lineage

`GET /tabs` exposes `openerTabId` from an observed Playwright popup event and resolves it against the same session's registry. Keep this local client-integration adaptation until upstream provides equivalent metadata, session affinity, and stale-ID handling. The registry regression suite and `tests/e2e/popupLineage.test.js` own the behavioral proof. The related upstream popup report [jo-inc/camofox-browser#7742](https://github.com/jo-inc/camofox-browser/issues/7742) concerns viewport sizing, not lineage, and is not an equivalent replacement. No upstream contribution is included in this delivery.

### Native park verification

Camoufox spoofs `browser.windows.get` geometry, so park and create acknowledgments must be backed by native bounds (`listNativeWindows` in `lib/park-display-launcher.js`). Windows are selected by the browser's owner PID, resolved from this server's process tree and the profile path, plus layer 0 and on-screen state. Never select by `kCGWindowName`. macOS omits other processes' window titles unless the TCC-responsible process holds Screen Recording. Under launchd, the server's node binary is its own responsible process, and the managed node had no grant. A 2026-10-13 probe showed this: with responsibility disclaimed, the managed node saw 0 of 16 window titles and `CGPreflightScreenCaptureAccess` returned false. Owner PID and bounds remained available. Readback failures are retried inside the same bounded loop and then reported per window after startup, without relaunching an established context. On first launch, an exhausted native readback sends `readyError` and fails attachment, so the fallback can close and relaunch the newly attempted context before caller tabs exist. Ordinary startup window-classification failures remain isolated per window, and command polling starts.

Regression coverage: `sharedIdentityVisibilityNative.test.js` covers parsing, PID resolution, `/geometry` validation, transient retry and concurrency. The startup-poller restart test is in `sharedIdentityVisibility.test.js`.

When touching this path, rerun the real-display harness from a launchd-equivalent context, either a throwaway LaunchAgent or a responsibility-disclaimed spawn. An interactive terminal can inherit the terminal's Screen Recording grant and hide this failure.
