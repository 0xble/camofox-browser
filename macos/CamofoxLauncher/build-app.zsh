#!/bin/zsh
set -euo pipefail
root=${0:A:h}
cd "$root"
# Build first: --show-bin-path only reports an existing release directory and
# can otherwise cause a stale executable to be bundled.
swift build -c release
bin=$(swift build -c release --show-bin-path)
app="$root/.build/Camofox.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin/Camofox" "$app/Contents/MacOS/Camofox"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Camofox</string>
<key>CFBundleIdentifier</key><string>com.brianle.camofox-launcher</string>
<key>CFBundleName</key><string>Camofox</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
plutil -lint "$app/Contents/Info.plist"
echo "$app"
