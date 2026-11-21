#!/usr/bin/env bash
# qemu.yml, job build, step "Build QEMU"; also run by hand on a developer's
# computer. Builds the QEMU the desktop app ships for this computer's system
# and processor from the sources pinned in sources.txt: one system emulator
# and qemu-img, with glib and libslirp linked in, so the files need nothing
# but the operating system. Writes dist/intar-qemu_<os>_<arch>.tar.gz and,
# for the GPL's source offer, dist/intar-qemu_sources.tar: the exact sources.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "${here}/../../.." && pwd)"
# One row so far. An x86 emulator also needs SeaBIOS and a boot ROM beside it,
# and a Linux one vhost-vsock and a pinned build image: both come with their rows.
case "$(uname -sm)" in
  "Darwin arm64") os=macos arch=arm64 target=aarch64-softmmu system=qemu-system-aarch64 machine=virt accel=(--enable-hvf) ;;
  *) echo "No QEMU build is defined for $(uname -sm) yet." >&2; exit 1 ;;
esac
work="${QEMU_WORK:-${RUNNER_TEMP:-${root}/target}/qemu-build}"
dist="${root}/dist"
src="${work}/src" tools="${work}/tools" prefix="${work}/prefix"
jobs="$(getconf _NPROCESSORS_ONLN)"
rm -rf "${work}/build" "${tools}" "${prefix}" "${work}/out"
mkdir -p "${src}" "${tools}/bin" "${prefix}" "${work}/build" "${work}/out/qemu/bin" "${work}/out/qemu/licenses" "${dist}"
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# The oldest macOS the files run on.
export MACOSX_DEPLOYMENT_TARGET=13.0

# Every source, checked against its pin, unpacked to ${work}/build/<name>.
while read -r name url pin; do
  case "${name}" in ''|'#'*) continue ;; esac
  file="${src}/${url##*/}"
  [ -f "${file}" ] && [ "$(sha256 "${file}")" = "${pin}" ] ||
    curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error --output "${file}" "${url}"
  [ "$(sha256 "${file}")" = "${pin}" ] || { echo "${url} is not the pinned ${name}." >&2; exit 1; }
  mkdir -p "${work}/build/${name}"
  tar -xf "${file}" -C "${work}/build/${name}" --strip-components 1
done < "${here}/sources.txt"

# The build tools, from their pinned sources: nothing is taken from a package
# manager, so the same script runs on a runner and on a developer's computer.
python3 -m venv "${tools}/venv"
"${tools}/venv/bin/pip" install --quiet --no-index --no-deps --no-build-isolation "${work}/build/meson" 2> /dev/null ||
  "${tools}/venv/bin/pip" install --quiet --no-deps "${work}/build/meson"
ln -s "${tools}/venv/bin/meson" "${tools}/bin/meson"
(cd "${work}/build/ninja" && python3 configure.py --bootstrap > "${work}/ninja.log" && cp ninja "${tools}/bin/ninja")
export PATH="${tools}/bin:${PATH}"
meson setup --buildtype release --default-library static --prefix "${tools}/pkgconf" \
  "${work}/build/pkgconf/_build" "${work}/build/pkgconf" > "${work}/pkgconf.log"
meson install -C "${work}/build/pkgconf/_build" >> "${work}/pkgconf.log"
# Static libraries need what they themselves link, which only --static names.
printf '#!/bin/sh\nexec "%s" --static "$@"\n' "${tools}/pkgconf/bin/pkgconf" > "${tools}/bin/pkg-config"
chmod 0755 "${tools}/bin/pkg-config"
export PKG_CONFIG="${tools}/bin/pkg-config" PKG_CONFIG_LIBDIR="${prefix}/lib/pkgconfig"

# glib with the libraries its own source pins (PCRE2, libffi and a libintl
# stand-in), then libslirp, all static.
meson setup --buildtype release --default-library static --prefix "${prefix}" --libdir lib \
  --force-fallback-for pcre2,libffi,proxy-libintl,zlib \
  -Dtests=false -Dnls=disabled -Dintrospection=disabled -Ddocumentation=false -Dman-pages=disabled \
  -Dglib_debug=disabled -Dselinux=disabled -Dlibmount=disabled -Dxattr=false -Ddtrace=disabled -Dsysprof=disabled \
  "${work}/build/glib/_build" "${work}/build/glib"
meson install -C "${work}/build/glib/_build" > "${work}/glib-install.log"
meson setup --buildtype release --default-library static --prefix "${prefix}" --libdir lib \
  "${work}/build/libslirp/_build" "${work}/build/libslirp"
meson install -C "${work}/build/libslirp/_build" > "${work}/libslirp-install.log"

# QEMU with only what zpm starts it with: one machine family, the system's
# own accelerator, virtio disks and network, the user-mode network, and
# qemu-img. No display, sound, USB, firmware, guest agent or documentation.
(
  cd "${work}/build/qemu"
  ./configure --prefix=/qemu --target-list="${target}" --without-default-features \
    "${accel[@]}" --enable-slirp --enable-tools --enable-fdt=internal \
    --disable-docs --disable-werror --disable-install-blobs --disable-guest-agent \
    --extra-cflags="-I${prefix}/include" --extra-ldflags="-L${prefix}/lib"
  make -j "${jobs}" "${system}" qemu-img
)

out="${work}/out/qemu"
bin="${out}/bin"
built="${work}/build/qemu/build"
# The build leaves the emulator unsigned beside a signed copy; take the
# unsigned one, strip it and sign it here.
cp "${built}/${system}-unsigned" "${bin}/${system}"
cp "${built}/qemu-img" "${bin}/qemu-img"
strip "${bin}/${system}" "${bin}/qemu-img"
# Signed ad hoc; without the hypervisor entitlement macOS refuses HVF. The
# app's release signs both again with its own identity.
codesign --force --sign - --identifier dev.intar.jumper.qemu-system \
  --entitlements "${work}/build/qemu/accel/hvf/entitlements.plist" "${bin}/${system}"
codesign --force --sign - --identifier dev.intar.jumper.qemu-img "${bin}/qemu-img"
codesign --display --entitlements - "${bin}/${system}" 2>&1 | grep -q com.apple.security.hypervisor
# "Linked in" means: nothing but the system's own libraries is needed.
for program in "${system}" qemu-img; do
  if otool -L "${bin}/${program}" | tail -n +2 | grep -Ev '^[[:space:]]+(/usr/lib/|/System/Library/)'; then
    echo "${program} needs a library that macOS does not ship." >&2; exit 1
  fi
done

# What zpm's command line uses must be in the build.
"${bin}/${system}" --version | head -n 1
"${bin}/${system}" -M "${machine}" -accel help | grep -qx hvf
devices="$("${bin}/${system}" -M "${machine}" -device help)"
for device in virtio-blk-pci virtio-net-pci; do grep -q "\"${device}\"" <<< "${devices}"; done
"${bin}/${system}" -M "${machine}" -netdev help | grep -qx user
"${bin}/qemu-img" create -q -f raw "${work}/probe.raw" 1M
"${bin}/qemu-img" create -q -f qcow2 -F raw -b "${work}/probe.raw" "${work}/probe.qcow2"

# The licences of everything linked in, and what each was built from. The
# release holds those exact sources beside this archive: that is the source
# the GPL and the LGPL ask a distributor for.
cp "${work}/build/qemu/COPYING" "${out}/licenses/qemu-COPYING"
cp "${work}/build/qemu/COPYING.LIB" "${out}/licenses/qemu-COPYING.LIB"
cp "${work}/build/qemu/LICENSE" "${out}/licenses/qemu-LICENSE"
cp "${work}/build/glib/LICENSES/LGPL-2.1-or-later.txt" "${out}/licenses/glib-LGPL-2.1-or-later.txt"
cp "${work}/build/libslirp/COPYRIGHT" "${out}/licenses/libslirp-COPYRIGHT"
set_id="$(bash "${here}/set.sh")"
sources="${work}/out/intar-qemu_sources"
rm -rf "${sources}"
mkdir -p "${sources}"
cp "${here}/sources.txt" "${here}/build.sh" "${sources}/"
grep -E '^(qemu|glib|libslirp) ' "${here}/sources.txt" | while read -r _ url _; do cp "${src}/${url##*/}" "${sources}/"; done
# glib builds these from the files its own source pins; they are linked in too.
used=()
for project in "${work}"/build/glib/_build/subprojects/*/; do
  name="$(basename "${project}")"
  find "${project}" -name '*.a' | grep -q . || continue
  used+=("${name}")
  for licence in "${work}/build/glib/subprojects/${name}"/{LICENCE,LICENSE,COPYING}*; do
    [ -f "${licence}" ] && cp "${licence}" "${out}/licenses/${name}-$(basename "${licence}")"
  done
  for packed in "${work}"/build/glib/subprojects/packagecache/*; do
    case "$(basename "${packed}")" in "${name%%-*}"*) cp "${packed}" "${sources}/" ;; esac
  done
done
{
  echo "QEMU set ${set_id}: ${system} and qemu-img for ${os} on ${arch}, built by"
  echo "tools/workflows/qemu/build.sh of https://github.com/intar-dev/intar-dev with"
  echo "$(cc --version | head -n 1), SDK $(xcrun --show-sdk-version), for macOS ${MACOSX_DEPLOYMENT_TARGET} and later."
  echo
  echo "Built from exactly these sources (name, URL, SHA-256):"
  grep -E '^(qemu|glib|libslirp) ' "${here}/sources.txt"
  echo "and, as glib's own source pins them: ${used[*]}"
  echo
  echo "The sources themselves, with the build script, are the file intar-qemu_sources.tar of"
  echo "https://github.com/intar-dev/intar-dev/releases/tag/qemu%2Fv${set_id}"
} > "${out}/SOURCES"

file="intar-qemu_${os}_${arch}.tar.gz"
tar -C "${work}/out" -czf "${dist}/${file}" qemu
tar -C "${work}/out" -cf "${dist}/intar-qemu_sources.tar" intar-qemu_sources
cat "${out}/SOURCES"
ls "${out}/licenses"
echo "set=${set_id}"
echo "file=${file}"
echo "sha256=$(sha256 "${dist}/${file}")"
echo "bytes=$(wc -c < "${dist}/${file}" | tr -d ' ')"
du -sh "${bin}"/* | sed "s|${bin}/||"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'set=%s\ntag=qemu/v%s\n' "${set_id}" "${set_id}" >> "${GITHUB_OUTPUT}"
  printf '### QEMU for %s %s\n\n- set: %s\n- file: %s\n- sha256: %s\n' "${os}" "${arch}" "${set_id}" "${file}" "$(sha256 "${dist}/${file}")" >> "${GITHUB_STEP_SUMMARY}"
fi
