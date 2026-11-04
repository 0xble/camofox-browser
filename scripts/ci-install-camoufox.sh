#!/usr/bin/env bash
# Install the pinned Camoufox engine for CI from this fork's checksummed mirror.
#
# camoufox-js's `fetch` installs whatever daijro/camoufox marks latest. When
# v156.0.1-beta.34 shipped (2026-10-04) every browser test failed with
# "Unknown property navigator.product in config", because camoufox-js 0.11.5
# is incompatible with that engine's property set. v158.0.1-beta.41 works with
# 0.11.5 and fixes native mouse acknowledgement deadlocks (#751/#752). Keep CI,
# Docker and the separately managed deployment pin aligned (MAINTENANCE.md).
#
# Requires: gh (authenticated via GH_TOKEN), unzip, sha256sum.
set -euo pipefail

VERSION=158.0.1
RELEASE=beta.41
MIRROR_TAG=camoufox-backup-428447379
ASSET="camoufox-${VERSION}-${RELEASE}-lin.x86_64.zip"
SHA256=3f2eb1d0451fa58e45e43e55f5e6181565069791ae60c0574f0ceb1f01341c33
INSTALL_DIR="${CAMOUFOX_INSTALL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/camoufox}"
# The mirror lives in this fork. Do not derive it from GITHUB_REPOSITORY:
# forks of the fork would look for a release they do not have.
MIRROR_REPOSITORY="${CAMOUFOX_MIRROR_REPOSITORY:-0xble/camofox-browser}"

expected_version="{\"version\":\"${VERSION}\",\"release\":\"${RELEASE}\"}"
if [[ -f "$INSTALL_DIR/version.json" ]] && [[ "$(tr -d '[:space:]' < "$INSTALL_DIR/version.json")" == "$expected_version" ]]; then
  echo "Camoufox ${VERSION}-${RELEASE} already installed at ${INSTALL_DIR}"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$MIRROR_TAG" --repo "$MIRROR_REPOSITORY" --pattern "$ASSET" --dir "$work"
echo "${SHA256}  ${work}/${ASSET}" | sha256sum --check --strict -

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
unzip -q "$work/$ASSET" -d "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
printf '%s' "$expected_version" > "$INSTALL_DIR/version.json"
echo "Installed Camoufox ${VERSION}-${RELEASE} at ${INSTALL_DIR}"
