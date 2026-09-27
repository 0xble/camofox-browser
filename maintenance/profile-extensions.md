# Profile extensions maintenance

Read the [root contract](../MAINTENANCE.md) first. This support file is required
on every maintenance run and is not independently enrolled or scheduled. Resolve
all recorded paths and run commands from the repository root.

## Update rule

Compare upstream extension and addon handling with this patch. Adopt an upstream
equivalent only when it installs a pinned, checksummed set per shared identity
into that identity's persistent profile, without launch-time downloads, and
leaves human-installed extensions alone.

### CAMOFOX-005: pinned per-identity profile extensions

- **Status:** Active.
- **Stable subject:** `Install pinned Firefox extensions per shared identity`.
- **Behavior:** `CAMOFOX_SHARED_IDENTITY_EXTENSIONS` maps an alias or opaque
  shared identity to `[{id, path, sha256}]`. Before each persistent-profile launch,
  `lib/profile-extensions.js` copies each artifact whose SHA-256 matches the pin
  to `<profile>/extensions/<id>.xpi`. Firefox then installs it as a normal
  profile extension, so its storage (for example a password manager's sign-in)
  persists across restarts. Unchanged files are not rewritten. A mismatched or
  unreadable artifact is never installed, and any prior copy is kept. The bytes written are the bytes that were hashed. Extensions
  this module installed earlier but no longer configured are removed.
  A file already present for a configured id that this module did not install is treated as human-owned: skipped, never adopted, overwritten or removed. Ownership is recorded in
  `<profile>/camofox-managed-extensions.json` and journaled: an id is claimed
  before its file is committed and released only after its file is removed, so
  an interrupted sync never makes a Camofox-installed file look human-owned. Unset configuration writes
  nothing. Invalid configuration (malformed JSON, or an invalid list for an
  identity, including an alias and its userId both listed) never prunes: the affected profiles are launched with their
  extensions left exactly as they were. When an identity pins
  `uBlock0@raymondhill.net`, Camoufox's launch-time UBO download is excluded
  for that launch, so uBlock Origin comes only from the pinned local copy. Ephemeral (non-shared) contexts are unaffected.
- **Why profile install, not `addons`:** Camoufox's `addons` launch option loads
  unpacked temporary add-ons. Temporary add-ons can get a fresh internal UUID
  each launch, which orphans their extension storage. A signed `<id>.xpi` in
  the profile keeps a stable identity. The pinned Camoufox engine
  (152.0.4-beta.30) sets `extensions.autoDisableScopes=0` and
  `extensions.enabledScopes=5`, which auto-enables profile-scope installs.
  A 2026-09-26 spike confirmed Mozilla-signed 1Password, I Still Don't Care
  About Cookies, and uBlock Origin XPIs installed with `active=true`,
  `location=app-profile`, and `signedState=2`.
- **First-launch activation:** Firefox registers an extension newly sideloaded
  into an existing profile during the startup that discovers it, but only runs
  it from the next startup. Whenever a sync installs or replaces a file, the
  launch does a brief headless warm-up launch and close first, so the real
  launch runs the extensions immediately. Verified on 2026-09-26 against engine
  152.0.4-beta.30: without warm-up, launch 1 showed the Le Monde consent wall
  and loaded doubleclick. With warm-up, both were handled on the first real launch.
- **Surfaces:** `lib/profile-extensions.js`, `lib/shared-identity-launch.js`,
  `lib/config.js`, `server.js` (`createSharedIdentityContext`),
  `tests/unit/profileExtensions.test.js`.
- **Upstream issue/PR:** None found on 2026-09-26. `jo-inc/camofox-browser` #2797
  (uBlock question, closed) and #5078 (`CAMOFOX_DISABLE_DEFAULT_ADDONS`, merged)
  are related. Neither supplies per-identity or persistent-profile extensions.
- **Regression:** `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/profileExtensions.test.js tests/unit/sharedIdentityWindow.test.js`
  plus a disposable-profile launch showing each configured extension active in
  `extensions.json`.
- **Rollback:** unset `CAMOFOX_SHARED_IDENTITY_EXTENSIONS` (or set it to an empty
  list for an identity) and restart. The next launch removes the managed files and
  Firefox uninstalls them. To remove the code, `git revert <CAMOFOX-005 commit>`.
  Do not delete profiles.
- **Retire when:** upstream ships an equivalent pinned per-identity
  persistent-profile extension mechanism.
