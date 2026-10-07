#!/usr/bin/env bash
# Install the pinned Camoufox engine for CI from this fork's checksummed mirror.
#
# camoufox-js's `fetch` installs whatever daijro/camoufox marks latest. When
# v156.0.1-beta.34 shipped (2026-10-04) every browser test failed with
# "Unknown property navigator.product in config", because camoufox-js 0.11.5
# targets the 152 engine. CI must test the engine that is actually deployed
# (MAINTENANCE.md: Camoufox 152.0.4-beta.30), so install exactly that build.
#
# Requires: gh (authenticated via GH_TOKEN), unzip, sha256sum.
set -euo pipefail

VERSION=152.0.4
RELEASE=beta.30
MIRROR_TAG=camoufox-backup-380139564
ASSET="camoufox-${VERSION}-${RELEASE}-lin.x86_64.zip"
SHA256=5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672
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
