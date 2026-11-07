# Native Window Binding Verification

## Installation Lifetime

Camoufox beta.41 installs `config.addons` from each native window's
`browser-init.js`. Installing the generated visibility controller that way
creates overlapping background executions. A copied signed app trace showed
multiple workers processing the same command, overlapping native challenges,
and an accepted create followed by a rejected duplicate acknowledgement whose
rollback closed the accepted page. This is an installation-lifetime defect.
The trace does not establish that locking caused it.

The parent compared the original installation route with a once-installed
controller on disposable copies of the same signed app and fresh profiles,
without changing display or lock state. The original route failed. The
once-installed probe passed the 860x540 parking harness in 23.8 seconds with
1 background, 6 unique create commands, 6 surviving pages producing real
screenshots, and 6 distinct native numbers. Inputs seeded before subsequent
window creates survived every open/release cycle. That probe demonstrates the
installation discriminator, not acceptance of a later source revision or
locked-desktop behavior.

`shared-identity-launch.js` excludes generated helpers from the `launchOptions`
addon input. Headed visibility and identity-indicator helpers share one
once-per-context installation through Firefox's shipped RDP addons actor,
after the persistent context launches and before it is returned. Ordinary
Camoufox/default addons, signed profile extensions, extension warmup, fingerprint,
locale and timezone retain their existing paths. Headless and warmup contexts
never install generated helpers. The existing native matchers and rejection
semantics are unchanged.

The temporary RDP listener uses a short launch-owned directory under TMPDIR,
explicitly mode 0700. This matters because Firefox creates its Unix socket as
0666. Socket paths over 103 bytes fail before launch. No TCP listener, signature
bypass or OS grant is requested. Before headed launch, the installer appends
`devtools.chrome.enabled=true`, `devtools.debugger.remote-enabled=true` and
`devtools.debugger.prompt-connection=false` to profile `user.js`, so Firefox
sees them before Playwright's later `Browser.enable` applies `firefoxUserPrefs`.
Cleanup restores only `user.js`, preserving an existing file and its metadata,
or removes the launch-created file. Firefox copies these preferences into
`prefs.js`, which cleanup does not restore. They persist in the profile and can
be inherited by later headless launches. In particular, the chrome-privileged
Browser Console remains enabled. Unrelated `user.js` edits during launch are
left intact and cause cleanup to fail. Cleanup failure closes the context and
rejects the launch. A process kill or host crash before cleanup can leave the
appended suffix in `user.js`. A later launch preserves that existing suffix.
Headless and warmup launches never append these startup prefs themselves.
A single deadline bounds connect, greeting, actor discovery
and all helper installs. Split/multiple byte-framed packets, actor errors, EOF,
browser exit and malformed responses are handled. The client disconnects and
the listener pathname and directory are removed before returning the context.
Installer failure closes the created context. Uncertain closure preserves
`profileOwnershipUnconfirmed` and the original failure.

The macOS/Linux Unix listener is supported. Native Windows headed shared
identities with a generated indicator or visibility helper now fail before
browser launch. This regresses the previous Windows indicator path through
Camoufox's addon input. Headless launches and headed launches without generated
helpers retain their existing paths. No Windows runtime installer is provided.

## Geometry And Identity

Native readback uses owner PID, native window number, layer and bounds, never
native titles. Bind the exact Firefox window by reversible horizontal motion,
then retain that exact native number for final main/parking checks. Three-sample
app-hidden handoff requires no moving sibling. Five-sample sized parking uses
unequal excursions to distinguish independent concurrent movers. Missing,
new, duplicate or ambiguous native numbers fail closed. No singleton, title,
sibling or approximate-size fallback supplies identity.

AppKit/WebExtension coordinates and CGWindow visual bounds can differ. A
historical disposable AppKit probe observed 1280x900 becoming 1153x811 and
horizontal displacements scaled by 0.9 in that desktop state. The historical
app-hidden signed-browser harness passed both main/off-main starts with retained
inputs/PID and independent AppKit hide confirmation. Focus remained false while
loginwindow owned global activation. Do not infer a fixed scale, lock causality
for the later parking incident, or global focus from per-app frontmost order.

A separate parent AppKit probe observed 860x572 yielding widths 774/775 during
pure horizontal movement. That quantization has not been demonstrated in the
browser incident. The once-install browser discriminator used stable 860x540
native dimensions. Native width equality is therefore retained in this repair.
CGWindow dimensions must not be asserted equal to the requested fingerprint.

## Disposable Native Acceptance

The native parking harness pins a coherent 860x540 fingerprint and seeds inputs
before creating more windows. It exercises 1 serial, 2 concurrent and 3 concurrent
creates, 6 unique exact native bindings, real screenshot bytes, retained PID,
all sibling pages and inputs, native main placement and exact-number parking
on release. Opt-in bounded diagnostics count background starts, create execution
and command acknowledgements without rewriting generated source or changing
operational acknowledgements. The harness requires 1 worker, 1 execution per
create and no rejected/duplicate acknowledgements. CGWindow visual dimensions
are recorded separately from requested AppKit/fingerprint dimensions. Cleanup
is bounded and preserves the original failure. The existing app-hidden native
cases retain their placement, frontmost, PID/input and independent hide checks.

```sh
CAMOFOX_NATIVE_TEST_APP=/Applications/Camoufox.app CAMOFOX_NATIVE_TEST_PARK=1 \
node --test tests/native/mainDisplayHandoff.mjs
```

The harness copies and verifies the signed app, uses a fresh disposable profile
and the production launch/locale/timezone helpers, and never contacts the live
server or profiles. It uses only an existing display. It does not change lock,
power, topology or permissions. Its socket directory is deliberately shorter
than the signed-app/profile scratch path. Existing already-running contexts are
not modified by source publication or temporary-helper installation.

Protocol tests use a real local Unix socket and framed messages. Launch tests
cover helper exclusion, default-addon preservation, readiness ordering, warmup
and headless exclusion, installation failures, listener cleanup and uncertain
context ownership:

```sh
node --experimental-vm-modules node_modules/.bin/jest --runInBand \
  tests/unit/runtimeAddons.test.js tests/unit/runtimeAddonLaunch.test.js
```

Qualification requires signed native acceptance, the full repository gate and
exact-candidate review. Source verification does not imply installation,
activation, no-ScreenRecording proof or lock-state causality.
