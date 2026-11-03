# Maintenance

## Background

Maintained fork: `0xble/camofox-browser` of `jo-inc/camofox-browser` on
the canonical `master` branch. Canonical checkout: `/Users/brianle/Repos/camofox-browser`.
Accepted deployed baseline: upstream tag `v1.14.0`, commit
`e5a36f5cd0332fde6597de474329a308a53a0716`. `origin` is the owned publish
remote; `upstream` is fetch-only and must never receive pushes. The upstream MIT
`LICENSE` is retained unchanged.

## Preserve

- This fork owns deployment plugins and its matching plugin configuration, not a
  Camoufox/Firefox engine fork or a Hermes configuration.
- Deployment, installation, and runtime activation are distinct stages.
- CI tests the deployed engine, not upstream's latest: `scripts/ci-install-camoufox.sh`
  installs the checksummed Camoufox build from this fork's `camoufox-backup-*`
  mirror release. Change that pin together with the deployed engine pin.
- `agenthook-notify.yml` secrets are optional; the fork has no agenthook
  configuration, so notification is skipped instead of failing its callers.

## Active patches

This root is the sole enrolled and scheduled contract. Read every linked support
file on every maintenance run, including no-change runs. Each file keeps the
patch record, update rule, regression proof, rollback, and retirement condition
together. Preserve these invariants when applying the shared adoption rules below.

| Patch | Required invariant | Maintenance detail |
|---|---|---|
| CAMOFOX-001 | Supported hardening hooks and authenticated snapshots only after persistence. | [Deployment plugins](maintenance/deployment-plugins.md) |
| CAMOFOX-002 | Shared identity routing, headless-by-default profiles, explicit headed handoff with clean-close cookie restoration, and serialized human control. | [Shared identity](maintenance/shared-identity.md) |
| CAMOFOX-003 | Authenticated dynamic metadata shared by the API and native launcher. | [Native launcher](maintenance/native-launcher.md) |
| CAMOFOX-004 | Working macOS native input and cancellation-safe creation without cross-task tab loss. | [Page creation recovery](maintenance/page-creation-recovery.md) |
| CAMOFOX-005 | Pinned, checksummed per-identity extensions installed into persistent profiles; human-installed extensions untouched. | [Profile extensions](maintenance/profile-extensions.md) |
| CAMOFOX-006 | Bounded session teardown checkpoints before closure. Idle tabs close in live sessions, and idle browser reclamation preserves in-flight context acquisition. | [Runtime reliability](maintenance/runtime-reliability.md) |
| CAMOFOX-007 | Inline bytes share the existing upload route without changing legacy paths, global parser limits, or replaying ambiguous attachments. | [Inline upload compatibility](maintenance/inline-uploads.md) |

## Update

### 2026-09-16 upstream reconciliation

- Upstream default branch: `master`, checked at
  `79d425be2674` (server version `1.16.0`). The prior fork was
  `7d6de5d`; the prior installed release was `166c992`.
- Preserve CAMOFOX-001 through CAMOFOX-004. Merge upstream HTTP navigation
  status reporting with the existing cancellation fence, and retain shared
  keep-open exclusions alongside upstream's disabled-session-timeout support.
- Retain the fork's existing bounded CI layout and Node checkpoint-test lane.
  Dependency overrides now match upstream, including `fast-uri` 3.1.7.
- Read upstream `AGENTS.md` and `CONTRIBUTING.md` at the fetched revision.
  Related upstream persistent-profile PR #6525 is closed. Reliability PR #9538
  is open and proposes active-session memory restarts and faster crashed-tab
  cleanup, not a released equivalent of our shared-profile lifecycle. Do not
  import its session destruction into keep-open identities.
- At that reconciliation, Camoufox `v152.0.4-beta.30` was the engine baseline
  (superseded by the candidate pin below). Engine issues #719 (unresponsive
  Juggler pipe) and #762 (content process memory crash) are related reports,
  not confirmed local root causes.
- Source synchronization does not prove installation. Deploy a separately
  verified immutable release from the landed fork and retain profile backups.

On every maintenance run, fetch `origin` and `upstream` separately, resolve the
live upstream default branch (currently `master`), and reconcile the maintained
`master` with its latest tip while preserving the registered deployment patches.
The deployed `v1.14.0` baseline is historical provenance, not a source-sync pin.
Review linked upstream issues/PRs and replacement behavior; update this register
before publishing any patch change or retirement. Run the patch regressions and
repository test/build gates, then publish only to `origin` and read back its SHA.
If reconciliation, tests, or publication cannot complete safely, report `Blocked`
with the exact failing stage, refs, and recovery action; never silently defer sync.
Installation, deployment, and runtime activation require separate authorization.

### Camoufox engine pin: v158.0.1-beta.41

- CI, Docker and build defaults pin `158.0.1` / `beta.41`; keep `camoufox-js`
  at `0.11.5`. Do not substitute v156: its property set is incompatible.
- CI uses the existing `camoufox-backup-428447379` mirror of
  [upstream v158.0.1-beta.41](https://github.com/daijro/camoufox/releases/tag/v158.0.1-beta.41).
  The official release's `digest` for `camoufox-158.0.1-beta.41-lin.x86_64.zip`
  is `sha256:3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33`;
  the mirror asset has the same digest.
- The macOS arm64 archive digest is
  `sha256:9038f86d666c9780b6fff199d488737b8596c01f24e3e517845a0ecfb0cf8add`.
  This is a source/CI candidate, not evidence that the live engine was replaced.
- Both native launch paths enable humanization, including macOS, after the
  released near-edge mouse acknowledgement fix. See
  [macOS input evidence](maintenance/page-creation-recovery.md).
- Deployment is separate: the dotfiles launcher `automation/camofox/launch.py`
  still guards `engines/152.0.4-beta.30` and its matching `version.json`.
  Its owner must update the expected engine directory to `engines/158.0.1-beta.41`
  and metadata to `{'version': '158.0.1', 'release': 'beta.41'}` together with
  the verified cache pin before activation. This repository does not edit it.
- Regress with `tests/e2e/nativeHumanize.test.js`: real trusted clicks on twelve
  cold pages per top-edge/mid-page target, macOS fingerprint even on Linux CI,
  and one 8 s bound covering both the native click and its page handler.

## Verify

Inspect the fork-only diff and retain the verification evidence above. MCP
packaging verification must install the actual tarball under an explicit temporary
npm prefix, preserving the installed-bin and protocol assertions without changing
an ancestor project. Immediately before `Updated` or `Already current`, fetch
upstream again and require
`git rev-list --left-right --count upstream/<live-default>...master` to report zero
on the left (upstream-only), with the exact fetched upstream SHA recorded. If it
moved, reconcile and reverify or report `Blocked`. Require published `origin/master`
to equal the verified maintained SHA. Source-sync success proves no installation
or live-service activation; those stages need their own evidence and rollback.
