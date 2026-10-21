# Shared persistent identity maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream identity routing, cookie restoration, and handoff behavior with this patch. Adopt changes only when the recorded unit and disposable-browser proofs preserve the shared lifecycle.

### CAMOFOX-002: shared persistent identity lifecycle

- **Status:** Active; managed installation is authorized only from the landed fork SHA.
- **Stable subject:** `Add shared persistent identity lifecycle` (`85d2f3f`).
- **Behavior:** native Hermes opaque IDs and optional local aliases resolve to one profile; normal agent sessions are headless and explicit `/browser/identities/:userId/open` transitions to headed with a clean-close cookie checkpoint, most-recent URL restoration, busy refusal, and stale-tab invalidation; session-only cookies restore only after a clean close; human handoff serializes with tab work and blocks agent operations. Headed windows of an identity in `CAMOFOX_SHARED_IDENTITY_MAP` show a browser-chrome indicator: a per-identity color (from `CAMOFOX_IDENTITY_COLORS` when that alias has a `#rrggbb`, otherwise `INDICATOR_PALETTE` by sorted alias) and a white alias label, applied by a generated `theme`-only WebExtension loaded as a temporary add-on for headed launches only (`lib/identity-indicator.js`). Camoufox 152 ignores `userChrome.css` even with `toolkit.legacyUserProfileCustomizations.stylesheets`, and does not activate a temporary static theme, so `browser.theme.update()` is the working mechanism. The add-on has no content scripts or web-accessible resources and is never written into the profile; headless launches are unchanged. A 2026-10-06 check on engine 152.0.4-beta.30 showed identical `innerWidth/innerHeight`, `prefers-color-scheme` and system colors with and without it. Authenticated `/browser/identities/:userId/release` checkpoints and closes without relaunching; busy work, downloads, and human handoffs return 409 without teardown. HID inactivity alone may release headed identities after 30 minutes; unavailable HID readings never trigger release. Headless tabs idle for 30 minutes are reaped except the most recent and active/leased tabs; headless sessions idle from agent activity close after 120 minutes if not busy/downloading. Configure these independently via `CAMOFOX_HEADED_IDLE_RELEASE_MIN`, `CAMOFOX_HIDDEN_TAB_IDLE_MIN`, and `CAMOFOX_HIDDEN_SESSION_IDLE_MIN` (0 disables, invalid uses default). The macOS HID reader is isolated from route/core code and fails closed on unsupported platforms, `ioreg` errors, or malformed output.
- **Surfaces:** `server.js`, `lib/shared-identity.js`, `lib/identity-indicator.js`, `lib/shared-identity-launch.js`, `lib/config.js`, `lib/macos-hid-idle.js`, `lib/shared-identity-idle.js`, `lib/downloads.js`, `docs/shared-persistent-browser-spec.md`
- **Upstream issue/PR:** jo-inc/camofox-browser issue #7990 covers native headed mode; open PR #10992 proposes persistent-profile preservation across expiry and VNC handoff. Neither supplies this fork's headless-to-headed named identity transition; assess compatibility before adopting either.
- **Regression:** `npm run test:unit` (including `tests/unit/identityIndicator.test.js`) plus the disposable shared-browser acceptance harness, with a headed screenshot per mapped identity.
- **Rollback:** `git revert <CAMOFOX-002 commit>`; do not delete preserved profiles.
- **Retire when:** upstream ships equivalent lifecycle and identity-routing semantics.

### Parked-window handoffs

When a session has a visibility controller, human handoff must await that controller's `open(page)` before reporting focus or changing control ownership. Agent return must use the same targeted `release({ all: false, page })` behavior as `/release {tabId}`. Both paths recompute headed state from live visibility even on failure, retain the context and sibling tabs, and add no identity-wide lock or transition gate. Last-URL restoration must create an API parked page through `session.createPage`, rather than reuse an unowned initial UI page. Legacy behavior remains unchanged.

Regression coverage: `sharedTabHandoffRoutes.test.js`, the generated-add-on bridge handoff test in `sharedIdentityVisibility.test.js`, and the parked/legacy last-URL restoration test in `sharedIdentityVisibilityRoutes.test.js`.

### Native park verification

Camoufox spoofs `browser.windows.get` geometry, so park and create acknowledgments must be backed by native bounds (`listNativeWindows` in `lib/park-display-launcher.js`). Windows are selected by the browser's owner PID, resolved from this server's process tree and the profile path, plus layer 0 and on-screen state. Never select by `kCGWindowName`. macOS omits other processes' window titles unless the TCC-responsible process holds Screen Recording. Under launchd, the server's node binary is its own responsible process, and the managed node had no grant. A 2026-10-13 probe showed this: with responsibility disclaimed, the managed node saw 0 of 16 window titles and `CGPreflightScreenCaptureAccess` returned false. Owner PID and bounds remained available. Readback failures are retried inside the same bounded loop and then reported per window. They must never trigger the legacy relaunch. Startup classification isolates each window, so command polling always starts.

Regression coverage: `sharedIdentityVisibilityNative.test.js` covers parsing, PID resolution, `/geometry` validation, transient retry and concurrency. The startup-poller restart test is in `sharedIdentityVisibility.test.js`.

When touching this path, rerun the real-display harness from a launchd-equivalent context, either a throwaway LaunchAgent or a responsibility-disclaimed spawn. An interactive terminal can inherit the terminal's Screen Recording grant and hide this failure.
