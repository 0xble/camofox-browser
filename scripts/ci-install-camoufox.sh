#!/usr/bin/env bash
# Install the exact checksummed official engine selected for native-input repair.
# `camoufox fetch` follows upstream latest, so it is not a reproducible CI pin.
# beta.34 was incompatible with camoufox-js 0.11.5. beta.40 restores that schema
# and contains the native edge-coordinate and renderer-ack deadline repairs.
# Installation here does not activate or replace any deployed macOS engine.
#
# Requires: gh (authenticated via GH_TOKEN), unzip, sha256sum.
set -euo pipefail

VERSION=158.0
RELEASE=beta.40
SOURCE_TAG="${CAMOUFOX_MIRROR_TAG:-v158.0-beta.40}"
ASSET="camoufox-${VERSION}-${RELEASE}-lin.x86_64.zip"
SHA256=2ead498d4765394addd3278d6a663962f3f99b189a99d3f966de56656cefc823
INSTALL_DIR="${CAMOUFOX_INSTALL_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/camoufox}"
# Until an owned byte-identical backup is published, use the immutable official
# release. A mirror override changes distribution only, never the digest or pin.
SOURCE_REPOSITORY="${CAMOUFOX_MIRROR_REPOSITORY:-daijro/camoufox}"

expected_version="{\"version\":\"${VERSION}\",\"release\":\"${RELEASE}\"}"
if [[ -f "$INSTALL_DIR/version.json" ]] && [[ "$(tr -d '[:space:]' < "$INSTALL_DIR/version.json")" == "$expected_version" ]]; then
  echo "Camoufox ${VERSION}-${RELEASE} already installed at ${INSTALL_DIR}"
  exit 0
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/camoufox-install.XXXXXX")
trap 'rm -rf "$work"' EXIT
gh release download "$SOURCE_TAG" --repo "$SOURCE_REPOSITORY" --pattern "$ASSET" --dir "$work"
echo "${SHA256}  ${work}/${ASSET}" | sha256sum --check --strict -

rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
unzip -q "$work/$ASSET" -d "$INSTALL_DIR"
chmod -R 755 "$INSTALL_DIR"
printf '%s' "$expected_version" > "$INSTALL_DIR/version.json"
echo "Installed Camoufox ${VERSION}-${RELEASE} at ${INSTALL_DIR}"
