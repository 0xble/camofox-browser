# Shared persistent Camofox browser

**Status:** implementation contract — 2026-09-10

## Outcome

Camofox remains the single loopback-authenticated browser service at `127.0.0.1:9377`. It owns a persistent browser context for an explicitly configured allowlist of native Hermes `userId` values; sessions start headless and an explicit open request shows the same opaque identity in a headed window.

## Current facts

- Source baseline is `284ae081ff6683e0e2eab1d0746b9492b187dc6f` from `0xble/camofox-browser` `origin/master`.
- The service currently uses ephemeral Playwright contexts and a separate manual Camoufox process/profile. Storage-state restoration is insufficient for full Firefox profile state and can revive stale login state.
- The deployed service is loopback-only and bearer-authenticated. Its manually launched profile is `~/.local/share/camofox/state/manual-profile`; it must not be deleted, reused, or imported by this feature.

## Boundaries and authority

| Component | Owns | Must not own |
| --- | --- | --- |
| Camofox service | lifecycle lock, persistent profile/context, live tab/session mapping, cookie checkpoint/restore, explicit handoff state | another process using an identity profile |
| Thin launcher | authenticated request to open/focus or hand off a named identity | browser processes, profile locking, cookie/state files |
| Hermes | normal Camofox API calls under a named `userId` | direct Firefox process/profile access |
| Human | visible tabs and any direct interaction after a handoff | service lifecycle internals |

## Settled behavior

1. Only configured opaque Hermes `userId`s may use shared persistent mode. `CAMOFOX_SHARED_IDENTITIES` contains those opaque values. When a local launcher needs aliases, `CAMOFOX_SHARED_IDENTITY_MAP` maps each alias to one configured opaque value; both paths normalize before session/profile lookup. Other `userId`s retain existing isolated ephemeral behavior.
2. Each configured opaque identity gets a distinct profile directory below `CAMOFOX_SHARED_PROFILE_DIR`. Existing state is never copied into another identity. First creation makes a backup/marker rather than importing Chrome or the old manual profile.
3. Normal agent session use launches a headless persistent context on the identity's existing profile. `POST /browser/identities/:userId/open` creates a headed window (or focuses an existing headed window). A headless-to-headed transition refuses with HTTP 409 `{ "error": "identity busy" }` while that identity has work in flight, clean-closes the profile with a session-cookie checkpoint, relaunches it headed, and restores the most recently used page URL except `about:blank`. Concurrent opens coalesce. Previous tab IDs are discarded and return 404; clients must use the returned `tabId`. Ending the headed session resets the next normal session launch to headless. Firefox may briefly retain a profile lock after context close; a failed relaunch is reported rather than opening a second profile owner.
4. Firefox profile state retains extensions, settings, and persistent cookies. Only session cookies are a scoped recovery layer: a snapshot is eligible solely after a clean service close, is invalidated before a subsequent context launch, and is injected with `context.addCookies()` before the first page is opened. A crash therefore cannot replay a stale session snapshot; exact crash-session recovery is intentionally not promised. Existing `storageState` is not passed to persistent-context launch.
5. A clean close replaces the session-cookie snapshot, including an empty snapshot. This makes an explicit logout durable. Persistent cookies stay in the Firefox profile and are never overlaid from a checkpoint. Expired cookies are omitted; session snapshots retain the Playwright cookie attributes accepted by `addCookies()`.
6. Headed shared tabs are not reaped; headless shared tabs are eligible for separate agent-idle cleanup except the most recently used tab, leased/in-flight tabs, or an active download. Pages opened from the visible Firefox UI are registered under a service-owned shared-identity group. Human handoff waits behind the current tab operation, focuses that page, and blocks later agent operations until transfer back.
7. Every 60 seconds, macOS HID inactivity at or above `CAMOFOX_HEADED_IDLE_RELEASE_MIN` (default 30) may release a headed identity if no agent request, download, or human handoff is active. Headless tabs idle from agent activity for `CAMOFOX_HIDDEN_TAB_IDLE_MIN` (default 30) may be closed, keeping the most recent; headless sessions idle from agent activity for `CAMOFOX_HIDDEN_SESSION_IDLE_MIN` (default 120) may be cleanly closed when not busy/downloading. Integer `0` disables each respective action; invalid values use defaults. A shared headless tab at the configured cap may evict only an oldest eligible idle tab, otherwise admission fails.
8. The macOS HID reader invokes `ioreg -c IOHIDSystem` in an isolated child-process module and converts `HIDIdleTime` nanoseconds to seconds. Non-macOS platforms, command failures, and malformed output return no reading, so headed auto-release fails closed. Headless cleanup depends on agent activity, not HID.
9. Automatic release uses the explicit release gate and retries on later ticks when busy. A manual window close invalidates only its exact context's session and tab IDs. Profile-lock relaunch retries are bounded to 45 seconds after a confirmed clean close; uncertain ownership never retries.
10. The existing production click issue is explicitly out of scope. Console capture is deferred. No browser-engine source or engine pin changes are permitted.

## Interfaces

Existing `/tabs` calls for a named identity cause the shared context to be opened/reused. New authenticated browser endpoints expose only safe control metadata:

- `POST /browser/identities/:userId/open` — show the named profile headed; if it was headless, clean-close/relaunch with session cookies and recent URL, returning `restarted: true` and a new `tabId`. Busy identities return 409 without closing.
- `POST /browser/identities/:userId/release` — snapshot cookies before teardown and close without relaunching. Returns 200 `{ "ok": true, "released": true }` for a closed headed or headless identity, 200 `{ "ok": true, "released": false }` if no session, 404 `{ "error": "Shared identity not configured" }` for an unknown identity, or 409 `{ "error": "identity busy" }` when a request, download, or human handoff is active. Snapshot/close failure returns an error; a snapshot failure leaves the live session intact. Subsequent normal use launches headless and restores clean-close session cookies and the last HTTP(S) URL.
- `POST /browser/identities/:userId/focus` — focus and register an existing headed tab; a headless identity returns 409 and must be shown through `/open`.
- `POST /tabs/:tabId/handoff` — set `human` or `agent`; optional human handoff focuses the window.

Responses never contain cookies, stored state, extension data, page body, or titles/URLs beyond the existing tab API contract.

## Test boundary

The primary test boundary is Camofox's authenticated HTTP API backed by a synthetic persistent-context adapter. It verifies: profile/identity isolation; one open under concurrent requests; focus/open behavior; safe cookie persistence and restore ordering; logout-empty snapshot; keep-open cleanup protection; and handoff transitions. One local runtime smoke test uses disposable synthetic identities only; it must not touch browser-account state.

## Migration and rollback

- Migration creates new profile directories only. It preserves `state/manual-profile`, old hashed `state/profiles`, and Chrome profiles untouched.
- Deployment copies a versioned release and atomically updates only the launcher package target after source verification. A controlled service restart checkpoints active contexts first.
- Rollback repoints the launcher to the previous immutable release and restarts the LaunchAgent. New profile directories remain preserved, not deleted.

## Non-goals

- No Chrome default-browser/session changes.
- No real account login, cookie export, or secret output.
- No VNC/noVNC, console capture, engine fork, or unrelated Hermes restart.
