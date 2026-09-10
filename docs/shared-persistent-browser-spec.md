# Shared persistent Camofox browser

**Status:** implementation contract — 2026-09-10

## Outcome

Camofox remains the single loopback-authenticated browser service at `127.0.0.1:9377`. It can own an interactive, persistent browser context for the three named identities `personal`, `lpg`, and `meridian`; the same identity is available to the human and to Hermes through Camofox's existing native HTTP API.

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

1. Only the allowlisted identities may use the shared persistent mode. Other `userId`s retain existing isolated ephemeral behavior.
2. Each named identity gets a distinct profile directory below `CAMOFOX_SHARED_PROFILE_DIR`. Existing state is never copied into another identity. First creation makes a backup/marker rather than importing Chrome or the old manual profile.
3. A persistent identity opens as a visible desktop browser. The service serializes create/open/close operations per identity; an existing identity is focused, never launched a second time.
4. Firefox profile state retains extensions and settings. Cookies are checkpointed separately as a deliberately scoped recovery layer. On a service restart, stored cookies are injected with `context.addCookies()` before the first page is opened. Existing `storageState` is not passed to persistent-context launch.
5. A checkpoint always replaces the prior cookie snapshot, including an empty snapshot. This makes an explicit logout durable instead of resurrecting an older login. Expired cookies are omitted. Checkpoints retain cookie attributes accepted by Playwright (`domain`, `path`, `expires`, `httpOnly`, `secure`, `sameSite`, and `partitionKey` when present).
6. A persistent tab is keep-open by default and is excluded from idle, task, pressure, and orphan-page cleanup. Pages opened from the visible Firefox UI are registered under a service-owned shared-identity group; the keep-open exclusion remains a fail-safe for a page-event race. Explicit close/session reset still works. A handoff changes only a service-owned tab state (`agent` or `human`); it does not clone a profile or start another process.
7. The existing production click issue is explicitly out of scope. Console capture is deferred. No browser-engine source or engine pin changes are permitted.

## Interfaces

Existing `/tabs` calls for a named identity cause the shared context to be opened/reused. New authenticated browser endpoints expose only safe control metadata:

- `POST /browser/identities/:userId/open` — ensure the named context exists, register a visible tab, and focus it.
- `POST /browser/identities/:userId/focus` — focus and register an existing visible tab; responses include its opaque `tabId` for explicit handoff.
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
