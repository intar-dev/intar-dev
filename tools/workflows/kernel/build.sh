#!/usr/bin/env bash
# kernel.yml, job build, step "Build the kernel".
# Compiles one architecture's guest kernel on a runner of that architecture,
# in the pinned Debian image, with the build script, profile and init script
# intar-image-build renders, and packs the result the same way every time.
# The file's bytes depend only on those inputs, never on the runner.
set -euo pipefail
arch="${KERNEL_ARCH}"
case "$(uname -m)/${arch}" in
  x86_64/amd64 | aarch64/arm64) ;;
  *) echo "This $(uname -m) runner cannot build the ${arch} kernel natively." >&2; exit 1 ;;
esac
work="${RUNNER_TEMP}/kernel"
rm -rf "${work}" dist
mkdir -p "${work}/in" "${work}/out" dist
cargo run --locked --quiet -p intar-image-build --example kernel_inputs -- "${arch}" "${work}/in" > "${work}/inputs.json"
image="$(jq -er .debian_image "${work}/inputs.json")"
file="$(jq -er .file "${work}/inputs.json")"
epoch="$(jq -er .source_date_epoch "${work}/inputs.json")"
pinned="$(jq -r '.pinned_sha256 // empty' "${work}/inputs.json")"
[[ "${file}" =~ ^[A-Za-z0-9._-]+$ && "${epoch}" =~ ^[0-9]+$ ]]

# The image has no CA certificates of its own, so the build starts with a copy
# of the runner's. A copy, not a mount: installing ca-certificates rewrites it.
ca=/etc/ssl/certs/ca-certificates.crt
docker run --rm \
  --volume "${work}/in:/build-in:ro" \
  --volume "${work}/out:/kernel" \
  --volume "${ca}:/build-in-ca.crt:ro" \
  --env INTAR_KERNEL_CONFIG=/build-in/intar-kernel.config \
  --env INTAR_KERNEL_INIT_SOURCE=/build-in/intar-initramfs-init.sh \
  --env "INTAR_APT_CA_INFO=Acquire::https::CaInfo=${ca}" \
  "${image}" sh -c "mkdir -p /etc/ssl/certs && cp /build-in-ca.crt ${ca} && exec sh /build-in/intar-kernel-build.sh /kernel"

# Packed by the same pinned tar and gzip, with nothing of this run in it:
# sorted names, one timestamp, root as owner, no gzip header fields.
docker run --rm \
  --volume "${work}/out:/kernel:ro" \
  --volume "${PWD}/dist:/dist" \
  "${image}" sh -c "tar --sort=name --mtime=@${epoch} --owner=0 --group=0 --numeric-owner -C /kernel -cf - . | gzip -9n > /dist/${file}"
sha256="$(sha256sum "dist/${file}" | cut -d' ' -f1)"

{
  printf '### %s kernel\n\n' "${arch}"
  printf -- '- set: %s\n- file: %s\n- sha256: %s\n' "$(jq -er .set "${work}/inputs.json")" "${file}" "${sha256}"
} >> "${GITHUB_STEP_SUMMARY}"
jq -er '"set=\(.set)\ntag=\(.tag)"' "${work}/inputs.json" >> "${GITHUB_OUTPUT}"

# When this source's set is the pinned one, the build must reproduce the pin:
# that is the proof the pinned file is what this source builds.
if [ -n "${pinned}" ] && [ "${pinned}" != "${sha256}" ]; then
  echo "The ${arch} kernel built as ${sha256}, but kernel.rs pins ${pinned} for this set." >&2
  exit 1
fi
