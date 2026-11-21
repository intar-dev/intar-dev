#!/usr/bin/env bash
# Builds the desktop app as a macOS bundle for Apple silicon:
# dist/Intar.app, dist/jumper_<version>_macos_arm64.zip and its checksums.
# The app lane runs it to check the bundle (`cuenv task bundle-app`); a
# release runs it with VERSION set to the version it publishes.
#
# The bundle is signed ad hoc. The QEMU in it is the pinned set, with the
# signature and the hypervisor entitlement it was published with: signing it
# again, or the bundle with --deep, would take the entitlement away, and macOS
# then refuses it the hypervisor.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
cd "${root}"
[ "$(uname -sm)" = "Darwin arm64" ] || { echo "The app's bundle is built on macOS on Apple silicon, not on $(uname -sm)." >&2; exit 1; }

# The oldest macOS the bundled QEMU runs on (tools/workflows/qemu/build.sh).
export MACOSX_DEPLOYMENT_TARGET=13.0
cargo build --locked --release -p jumper --bin jumper
built="target/release/jumper"
version="$("${built}" --version | sed -n 's/^jumper //p')"
[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "jumper --version printed no version." >&2; exit 1; }
[ -z "${VERSION:-}" ] || [ "${VERSION}" = "${version}" ] || { echo "The app is version ${version}, not the ${VERSION} to release." >&2; exit 1; }

# The pinned QEMU, checked against its pin, in target/release/qemu.
bash "${root}/tools/workflows/qemu/fetch.sh" release
qemu="target/release/qemu"

app="dist/Intar.app"
rm -rf "${app}" dist/jumper_*_macos_arm64.zip dist/jumper_*_checksums.txt
mkdir -p "${app}/Contents/MacOS" "${app}/Contents/Helpers" "${app}/Contents/Resources/qemu"
cp "${built}" "${app}/Contents/MacOS/jumper"
# Only programs in the code directories: any other file there is signed
# through extended attributes, which a zip loses.
cp "${qemu}/bin/qemu-system-aarch64" "${qemu}/bin/qemu-img" "${app}/Contents/Helpers/"
# QEMU's licences and where its exact sources are (the GPL's source offer).
cp -R "${qemu}/licenses" "${qemu}/SOURCES" "${app}/Contents/Resources/qemu/"

# The icon, from the one picture the repository keeps.
iconset="$(mktemp -d)/Intar.iconset"
mkdir "${iconset}"
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" apps/jumper/assets/icon.png --out "${iconset}/icon_${size}x${size}.png" > /dev/null
  sips -z "$((size * 2))" "$((size * 2))" apps/jumper/assets/icon.png --out "${iconset}/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil --convert icns --output "${app}/Contents/Resources/Intar.icns" "${iconset}"
rm -rf "$(dirname "${iconset}")"

cat > "${app}/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleExecutable</key><string>jumper</string>
  <key>CFBundleIconFile</key><string>Intar</string>
  <key>CFBundleIdentifier</key><string>dev.intar.jumper</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Intar</string>
  <key>CFBundleDisplayName</key><string>Intar</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>${MACOSX_DEPLOYMENT_TARGET}</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint "${app}/Contents/Info.plist" > /dev/null

# The bundle alone: its helpers are sealed in as they are.
codesign --force --sign - --identifier dev.intar.jumper "${app}"
codesign --verify --strict --deep "${app}"
codesign --display --entitlements - "${app}/Contents/Helpers/qemu-system-aarch64" 2>&1 | grep -q com.apple.security.hypervisor ||
  { echo "The bundled QEMU lost its hypervisor entitlement." >&2; exit 1; }
[ "$("${app}/Contents/MacOS/jumper" --version)" = "jumper ${version}" ]
# Nothing but what macOS ships may be needed.
if otool -L "${app}/Contents/MacOS/jumper" | tail -n +2 | grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)'; then
  echo "The app needs a library that macOS does not ship." >&2; exit 1
fi

zip="jumper_${version}_macos_arm64.zip"
# ditto keeps what a signature needs; zip does not.
ditto -c -k --keepParent "${app}" "dist/${zip}"
(cd dist && shasum -a 256 "${zip}" > "jumper_${version}_checksums.txt")
echo "Built dist/${zip}: $(du -sh "${app}" | cut -f1) unpacked, $(du -h "dist/${zip}" | cut -f1) zipped."
