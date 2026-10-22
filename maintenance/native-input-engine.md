# Official Native Input Engine

Read the [root contract](../MAINTENANCE.md) and
[macOS input policy](page-creation-recovery.md) first.

## Required Behavior

Native movement on viewport boundaries must not wedge later input across an
identity's browser process. Promise completion and HTTP 200 are insufficient:
require trusted page-observed movement and clicks, plus a subsequent sibling
click with its unsaved state intact. Preserve the macOS `humanize:false` policy.
Do not substitute JavaScript clicks, coordinate nudges, longer server budgets,
or destructive session restarts for the engine repair.

## Exact Official Pin

Selected upstream release: [`v158.0-beta.40`](https://github.com/daijro/camoufox/releases/tag/v158.0-beta.40),
source commit `c9ed439d49948cc8e4335aee6bea1a7b23dc4d2d`.

| Consumer | Official Asset | SHA-256 |
| --- | --- | --- |
| Linux x86_64 CI | `camoufox-158.0-beta.40-lin.x86_64.zip` | `2ead498d4765394addd3278d6a663962f3f99b189a99d3f966de56656cefc823` |
| macOS arm64 deployment | `camoufox-158.0-beta.40-mac.arm64.zip` | `b8aba26d86f761627651b8e7f0d90ade022a32a3d750e0b68ff5830ebefd3aab` |

These are official distribution bytes, not a maintained engine fork. The macOS
archive's digest and packaged Juggler `MouseDispatch.js`, `PageHandler.js`,
`TargetRegistry.js`, and `Helper.js` were checked against the release-tag source.
`MouseDispatch.js` SHA-256:
`655f863b3777da2677f82c8522cdca9e4a9739b2e133f883bdb4b1b9d484085b`.
The beta.40 property schema accepts the existing camoufox-js 0.11.5 launch policy.
The earlier beta.34 incompatibility is not a reason to silently retain beta.30.

## Verification

Run the source-owned regression with the selected exact engine installed:

```sh
node --test tests/native-input-engine.test.mjs
```

On Linux, run it under `xvfb-run --auto-servernum`. It executes headed and
headless modes with macOS spoofing, direct origin/top-row and viewport-ring
moves, repeated/outside-return moves, a thin top-row native click, a sibling
click with preserved unsaved state, a 2-second content-main-thread delay, and
an intentionally late 6.5-second renderer acknowledgement. The late-ack case
requires dispatch to return within 6 seconds and then observes a trusted sibling
click after the content thread resumes.
Every changed in-viewport move and each click must be trusted and page-observed.
A native deadline is an explicit failure, never successful cancellation. The
engine's installed metadata and packaged application version must both match
`158.0-beta.40`, so a stale engine cannot silently pass the CI lane.

The disposable macOS A/B canary reproduced beta.30's top-row stall and later
sibling native stall in both display modes, while evaluation retained unsaved
state. The same generated launch configuration on beta.40 delivered trusted
movement and clicks, preserved sibling state, and recovered after slow content.
An unmodified disposable Camofox HTTP server additionally exercised trusted
selector, snapshot-ref, iframe, offscreen, edge-target, and sibling clicks.
These are scratch canaries, not installed or live-service verification.

The renderer acknowledgement deadline is 5 seconds. APZ flush and tab activation
waits are separate and are not proven cancelled or universally bounded by this
repair. The canary does not attribute every historical live timeout to this
edge trigger.

## Distribution And Activation

`scripts/ci-install-camoufox.sh` downloads the exact checksummed Linux asset
from the official release. It never follows `latest`. Hosted CI runs the native
regression without a skip or a beta.30 fallback. Installing CI bytes does not
install or activate the macOS deployment pin.

If an owned backup is desired, publish only the 2 byte-identical assets listed
above to `0xble/camofox-browser`, proposed tag
`camoufox-backup-158.0-beta.40`. Record both digests in that release. After
publication and exact asset readback, CI can use:

```sh
CAMOUFOX_MIRROR_REPOSITORY=0xble/camofox-browser \
CAMOUFOX_MIRROR_TAG=camoufox-backup-158.0-beta.40 \
scripts/ci-install-camoufox.sh
```

The mirror override changes distribution only, never the version or checksum.
Mirror publication is a separate action, not performed by the installer.
Production activation must preserve existing profiles and cookies, install only
the verified official macOS asset, and repeat the trusted edge/sibling canary
through a disposable identity before reporting live repair.

## Update And Rollback

On any engine change, independently verify release identity, all selected asset
digests, packaged Juggler source, client/schema compatibility, trusted native
observations, and exact-engine Linux CI. Change source CI and deployment pins as
one selected release, but report source, distribution, installation, and live
activation separately. If the candidate is incompatible, preserve the exact
failure rather than editing fingerprint preferences or maintaining a custom
engine. beta.36 is a backup only when evidence shows it resolves that failure.

Rollback requires the retained verified beta.30 engine plus unchanged identity
profiles and checkpoints. It restores the old native-input deadlock risk, so a
rollback is not proof of recovery. Retire this maintenance record only when the
repository's normal engine selection and native regression enforce the complete
behavior without a fork-specific distribution override.
