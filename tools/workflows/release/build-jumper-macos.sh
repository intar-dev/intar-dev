#!/usr/bin/env bash
# release.yml, job build, step "Build the app's bundle"; and the app lane, to
# check the bundle (`cuenv task bundle-app`).
# Builds the desktop app as a macOS bundle for Apple silicon,
# target/release/bundle/Intar.app, and what a release publishes of it:
# dist/intar-desktop_<version>_macos_arm64.zip and its checksums, and nothing else in
# dist/, since a release uploads every file there. A release sets VERSION to
# the version it publishes.
#
# How the bundle is signed:
#   - With MACOS_CERT_P12_BASE64 and MACOS_CERT_PASSWORD (release.yml, from the
#     macos-signing environment): with that Developer ID Application
#     certificate, imported into a keychain of the build's own, and the
#     hardened runtime; with ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8, an App
#     Store Connect API key, it is notarized and the ticket stapled.
#   - With SIGN_IDENTITY: with that identity from the login keychain, say a
#     self-signed one, so a local build keeps its keychain access across
#     builds. Not notarized.
#   - Otherwise ad hoc.
# The QEMU in it is the pinned set. Signed ad hoc, it keeps the signature and
# the hypervisor entitlement it was published with; with an identity it is
# signed again with that entitlement given back, never through --deep, which
# would take the entitlement away, and macOS then refuses it the hypervisor.
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

app="target/release/bundle/Intar.app"
rm -rf "${app}" dist/intar-desktop_*_macos_arm64.zip dist/intar-desktop_*_checksums.txt
mkdir -p dist "${app}/Contents/MacOS" "${app}/Contents/Helpers" "${app}/Contents/Resources/qemu"
cp "${built}" "${app}/Contents/MacOS/jumper"
# Only programs in the code directories: any other file there is signed
# through extended attributes, which a zip loses.
cp "${qemu}/bin/qemu-system-aarch64" "${qemu}/bin/qemu-img" "${app}/Contents/Helpers/"
# QEMU's licences and where its exact sources are (the GPL's source offer).
cp -R "${qemu}/licenses" "${qemu}/SOURCES" "${app}/Contents/Resources/qemu/"
# The app's own licences, and what it is built from: every crate in the
# program for this target, with its licence.
cp LICENSE "${app}/Contents/Resources/LICENSE-MIT"
cp apps/jumper/LICENSE-APACHE "${app}/Contents/Resources/LICENSE-APACHE"
cargo metadata --locked --format-version 1 --filter-platform aarch64-apple-darwin |
  python3 -c '
import json, sys
metadata = json.load(sys.stdin)
packages = {package["id"]: package for package in metadata["packages"]}
nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
pending = [package["id"] for package in metadata["packages"] if package["name"] == "jumper" and package["source"] is None]
reached = set(pending)
while pending:
    for dependency in nodes[pending.pop()]["deps"]:
        # What is compiled into the program, not what only builds or tests it.
        if dependency["pkg"] not in reached and any(kind["kind"] is None for kind in dependency["dep_kinds"]):
            reached.add(dependency["pkg"])
            pending.append(dependency["pkg"])
inventory = sorted(
    ({"name": p["name"], "version": p["version"], "license": p["license"], "repository": p["repository"]}
     for p in (packages[i] for i in reached) if p["source"] is not None),
    key=lambda entry: (entry["name"], entry["version"]),
)
if len(inventory) < 50 or any(not entry["license"] for entry in inventory):
    sys.exit("the dependency inventory is incomplete: %d crates" % len(inventory))
json.dump(inventory, sys.stdout, indent=1)
' > "${app}/Contents/Resources/rust-dependencies.json"

# The icon, from the one picture the repository keeps.
scratch="$(mktemp -d)"
trap 'rm -rf "${scratch}"' EXIT
iconset="${scratch}/Intar.iconset"
mkdir "${iconset}"
for size in 16 32 128 256 512; do
  sips -z "${size}" "${size}" apps/jumper/assets/icon.png --out "${iconset}/icon_${size}x${size}.png" > /dev/null
  sips -z "$((size * 2))" "$((size * 2))" apps/jumper/assets/icon.png --out "${iconset}/icon_${size}x${size}@2x.png" > /dev/null
done
iconutil --convert icns --output "${app}/Contents/Resources/Intar.icns" "${iconset}"

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

identity="${SIGN_IDENTITY:-}"
if [ -n "${MACOS_CERT_P12_BASE64:-}" ]; then
  [ -n "${MACOS_CERT_PASSWORD:-}" ] || { echo "MACOS_CERT_P12_BASE64 is set without MACOS_CERT_PASSWORD." >&2; exit 1; }
  keychain="${scratch}/signing.keychain-db"
  keychain_password="$(openssl rand -hex 24)"
  searched="$(security list-keychains -d user | tr -d '"')"
  trap 'security list-keychains -d user -s ${searched}; security delete-keychain "${keychain}" 2> /dev/null; rm -rf "${scratch}"' EXIT
  security create-keychain -p "${keychain_password}" "${keychain}"
  security set-keychain-settings -lut 3600 "${keychain}"
  security unlock-keychain -p "${keychain_password}" "${keychain}"
  base64 --decode <<< "${MACOS_CERT_P12_BASE64}" > "${scratch}/certificate.p12"
  security import "${scratch}/certificate.p12" -k "${keychain}" -f pkcs12 -P "${MACOS_CERT_PASSWORD}" -T /usr/bin/codesign > /dev/null
  rm "${scratch}/certificate.p12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${keychain_password}" "${keychain}" > /dev/null
  # shellcheck disable=SC2086 # the keychains searched before, one per word
  security list-keychains -d user -s "${keychain}" ${searched}
  identity="$(security find-identity -p codesigning "${keychain}" | awk '/"Developer ID Application: / {print $2; exit}')"
  [ -n "${identity}" ] || { echo "The certificate is no Developer ID Application identity." >&2; exit 1; }
elif [ -z "${identity}" ] && [ -n "${VERSION:-}" ]; then
  echo "::warning::No signing certificate: the app is signed ad hoc." >&2
fi

if [ -z "${identity}" ]; then
  # The bundle alone: its helpers are sealed in as they are.
  codesign --force --sign - --identifier dev.intar.jumper "${app}"
else
  notarize="${ASC_KEY_ID:+yes}"
  # Notarization asks for a secure timestamp; a local build signs without.
  timestamp="--timestamp"
  [ -n "${notarize}" ] || timestamp="--timestamp=none"
  sign=(codesign --force --sign "${identity}" --options runtime "${timestamp}")
  cat > "${scratch}/qemu.entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.hypervisor</key><true/>
</dict>
</plist>
PLIST
  # Inside out: the helpers, then the bundle that seals them.
  "${sign[@]}" --identifier dev.intar.jumper.qemu-system --entitlements "${scratch}/qemu.entitlements" \
    "${app}/Contents/Helpers/qemu-system-aarch64"
  "${sign[@]}" --identifier dev.intar.jumper.qemu-img "${app}/Contents/Helpers/qemu-img"
  "${sign[@]}" --identifier dev.intar.jumper "${app}"
  if [ -n "${notarize}" ]; then
    : "${ASC_ISSUER_ID:?ASC_KEY_ID is set without ASC_ISSUER_ID}" "${ASC_KEY_P8:?ASC_KEY_ID is set without ASC_KEY_P8}"
    printf '%s\n' "${ASC_KEY_P8}" > "${scratch}/notary.p8"
    ditto -c -k --keepParent "${app}" "${scratch}/notarize.zip"
    notary=(--key "${scratch}/notary.p8" --key-id "${ASC_KEY_ID}" --issuer "${ASC_ISSUER_ID}")
    xcrun notarytool submit "${scratch}/notarize.zip" "${notary[@]}" --wait --timeout 1h \
      --output-format json > "${scratch}/notarized.json"
    submission="$(plutil -extract id raw "${scratch}/notarized.json")"
    if [ "$(plutil -extract status raw "${scratch}/notarized.json")" != "Accepted" ]; then
      xcrun notarytool log "${submission}" "${notary[@]}" >&2 || true
      echo "Apple did not notarize the app (submission ${submission})." >&2; exit 1
    fi
    rm "${scratch}/notary.p8" "${scratch}/notarize.zip"
    xcrun stapler staple "${app}"
    spctl --assess --type execute --verbose=2 "${app}" 2>&1 | grep -q "source=Notarized Developer ID" ||
      { echo "Gatekeeper does not accept the app as notarized." >&2; exit 1; }
  fi
fi
codesign --verify --strict --deep "${app}"
codesign --display --entitlements - "${app}/Contents/Helpers/qemu-system-aarch64" 2>&1 | grep -q com.apple.security.hypervisor ||
  { echo "The bundled QEMU lost its hypervisor entitlement." >&2; exit 1; }
[ "$("${app}/Contents/MacOS/jumper" --version)" = "jumper ${version}" ] ||
  { echo "The bundled app does not report version ${version}." >&2; exit 1; }
# Nothing but what macOS ships may be needed.
linked="$(otool -L "${app}/Contents/MacOS/jumper" | tail -n +2)"
if grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)' <<< "${linked}"; then
  echo "The app needs a library that macOS does not ship." >&2; exit 1
fi

# The product is intar-desktop; the program in it, and its crate, are jumper.
zip="intar-desktop_${version}_macos_arm64.zip"
# Without resource forks and extended attributes: every signature here is in
# a program or in _CodeSignature, and the `._` entries ditto would add for
# them are plain files to any other unzipper, which break the seal.
ditto -c -k --norsrc --noextattr --keepParent "${app}" "dist/${zip}"
# The zip as an updater or `unzip` reads it, not as Archive Utility does.
unzip -q "dist/${zip}" -d "${scratch}/unzipped"
codesign --verify --strict --deep "${scratch}/unzipped/Intar.app" ||
  { echo "The bundle's signature does not survive the zip." >&2; exit 1; }
(cd dist && shasum -a 256 "${zip}" > "intar-desktop_${version}_checksums.txt")
echo "Built dist/${zip}: $(du -sh "${app}" | cut -f1) unpacked, $(du -h "dist/${zip}" | cut -f1) zipped."
echo "The bundle is ${app}."
