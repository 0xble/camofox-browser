# Shared persistent identity maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream identity routing, cookie restoration, and handoff behavior with this patch. Adopt changes only when the recorded unit and disposable-browser proofs preserve the shared lifecycle.

### CAMOFOX-002: shared persistent identity lifecycle

- **Status:** Active; managed installation is authorized only from the landed fork SHA.
- **Stable subject:** `Add shared persistent identity lifecycle` (`85d2f3f`).
- **Behavior:** native Hermes opaque IDs and optional local aliases resolve to one profile; normal agent sessions are headless and explicit `/browser/identities/:userId/open` transitions to headed with a clean-close cookie checkpoint, most-recent URL restoration, busy refusal, and stale-tab invalidation; session-only cookies restore only after a clean close; human handoff serializes with tab work and blocks agent operations. Authenticated `/browser/identities/:userId/release` checkpoints and closes without relaunching; busy work, downloads, and human handoffs return 409 without teardown. HID inactivity alone may release headed identities after 30 minutes; unavailable HID readings never trigger release. Headless tabs idle for 30 minutes are reaped except the most recent and active/leased tabs; headless sessions idle from agent activity close after 120 minutes if not busy/downloading. Configure these independently via `CAMOFOX_HEADED_IDLE_RELEASE_MIN`, `CAMOFOX_HIDDEN_TAB_IDLE_MIN`, and `CAMOFOX_HIDDEN_SESSION_IDLE_MIN` (0 disables, invalid uses default). The macOS HID reader is isolated from route/core code and fails closed on unsupported platforms, `ioreg` errors, or malformed output.
- **Surfaces:** `server.js`, `lib/shared-identity.js`, `lib/config.js`, `lib/macos-hid-idle.js`, `lib/shared-identity-idle.js`, `lib/downloads.js`, `docs/shared-persistent-browser-spec.md`
- **Upstream issue/PR:** jo-inc/camofox-browser issue #7990 covers native headed mode; open PR #10992 proposes persistent-profile preservation across expiry and VNC handoff. Neither supplies this fork's headless-to-headed named identity transition; assess compatibility before adopting either.
- **Regression:** `npm run test:unit` plus the disposable shared-browser acceptance harness.
- **Rollback:** `git revert <CAMOFOX-002 commit>`; do not delete preserved profiles.
- **Retire when:** upstream ships equivalent lifecycle and identity-routing semantics.
