#!/usr/bin/env bash
# release.yml, job release, step "Build release artifacts".
set -euo pipefail
dist_dir="${PWD}/dist"
mkdir -p "${dist_dir}"
# Values are supplied by the step's reviewed env contract.
# shellcheck disable=SC2153
build_archive() {
  local arch="$1"
  local target="$2"
  local archive="${BINARY}_${VERSION}_linux_${arch}"
  local target_dir="${PWD}/target/${target}"
  local binary="${target_dir}/${target}/release/${BINARY}"
  local workdir
  if [ "${PACKAGE}" = "intar-builder" ] || [ "${PACKAGE}" = "intar-image-cli" ]; then
    CARGO_TARGET_DIR="${target_dir}" LIBNBD_BUILD_ROOT="${target_dir}/libnbd" \
      tools/image-build/with-libnbd-env.sh --target "${target}" \
        cargo zigbuild --locked --release -p "${PACKAGE}" --bin "${BINARY}" --target "${target}"
  else
    # This package does not link libnbd, but Cargo still has to
    # resolve the workspace path dependency, so prepare first.
    CARGO_TARGET_DIR="${target_dir}" \
      tools/image-build/with-libnbd-env.sh --rust-only \
        cargo zigbuild --locked --release -p "${PACKAGE}" --bin "${BINARY}" --target "${target}"
  fi
  file "${binary}"
  workdir="$(mktemp -d)"
  cp "${binary}" "${workdir}/${BINARY}"
  chmod +x "${workdir}/${BINARY}"
  if [ "${PACKAGE}" = "intar-builder" ] || [ "${PACKAGE}" = "intar-image-cli" ]; then
    tools/image-build/package-libnbd-static-artifacts.sh \
      --prefix "${target_dir}/libnbd/${target}/prefix" \
      --destination "${workdir}/third-party/libnbd"
    (
      cd "${workdir}/third-party/libnbd"
      sha256sum --check --strict SHA256SUMS
    )
    dynamic_section="$(readelf -d "${binary}" 2>/dev/null)"
    if grep -Fq '(NEEDED)' <<<"${dynamic_section}"; then
      echo "${binary} retained a dynamic shared-library dependency" >&2
      exit 1
    fi
  fi
  if [ "${PACKAGE}" = "intar-image-cli" ]; then
    cp content/scenarios/base-images.hcl "${workdir}/"
  fi
  if [ "${PACKAGE}" = "intar-agent" ]; then
    if [ "${arch}" != "amd64" ]; then
      echo "Jailed scenario hosts currently support x86_64 only." >&2
      exit 1
    fi
    CARGO_TARGET_DIR="${target_dir}" \
      tools/image-build/with-libnbd-env.sh --rust-only \
        cargo zigbuild --locked --release -p intar-jailer --bin intar-jailer --target "${target}"
    CARGO_TARGET_DIR="${target_dir}" \
      tools/image-build/with-libnbd-env.sh --rust-only \
        cargo zigbuild --locked --release -p intar-jailerd --bin intar-jailerd --target "${target}"
    cp "${target_dir}/${target}/release/intar-jailer" "${workdir}/intar-jailer"
    cp "${target_dir}/${target}/release/intar-jailerd" "${workdir}/intar-jailerd"
    chmod +x "${workdir}/intar-jailer" "${workdir}/intar-jailerd"
    curl --fail --location --retry 3 \
      --output "${workdir}/cloud-hypervisor-v53.0" \
      "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v53.0/cloud-hypervisor-static"
    echo "448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc  ${workdir}/cloud-hypervisor-v53.0" | sha256sum --check --strict
    chmod 0555 "${workdir}/cloud-hypervisor-v53.0"
    cp -R crates/intar-jailerd/deploy "${workdir}/deploy"
    cp crates/intar-agent/deploy/intar-agent.service "${workdir}/deploy/intar-agent.service"
    cp crates/intar-agent/deploy/config.example.toml "${workdir}/deploy/intar-agent.config.example.toml"
    sudo apt-get update
    sh deploy/personal-metal/package.sh "${workdir}" "${VERSION}"
    cp deploy/personal-metal/intar-host "${dist_dir}/intar-agent_${VERSION}_intar-host"

    # Bundle the exact upstream license set corresponding to the
    # pinned v53.0 source commit used for the static runtime.
    ch_source="${workdir}/cloud-hypervisor-source.tar.gz"
    curl --fail --location --retry 3 \
      --output "${ch_source}" \
      "https://github.com/cloud-hypervisor/cloud-hypervisor/archive/9ed824d6d08df3e96f7d5f50795d9449ac99f431.tar.gz"
    echo "03c2c4d80bb68567835020b2be42dd23177f14d32660a1ce15dd175e2dfdcbbf  ${ch_source}" | sha256sum --check --strict
    license_extract="$(mktemp -d)"
    tar -tzf "${ch_source}" | while IFS= read -r entry; do
      case "${entry}" in
        /*|../*|*/../*|*/..) echo "unsafe Cloud Hypervisor source path: ${entry}" >&2; exit 1 ;;
      esac
    done
    tar -xzf "${ch_source}" -C "${license_extract}" --no-same-owner
    cp -R \
      "${license_extract}/cloud-hypervisor-9ed824d6d08df3e96f7d5f50795d9449ac99f431/LICENSES" \
      "${workdir}/deploy/cloud-hypervisor-LICENSES"
    rm -rf "${license_extract}" "${ch_source}"

    metadata="$(mktemp)"
    tools/image-build/with-libnbd-env.sh --rust-only -- cargo metadata --locked --format-version 1 > "${metadata}"
    python3 crates/intar-jailerd/scripts/generate-dependency-inventory.py \
      "${metadata}" \
      "${workdir}/deploy/intar-rust-dependencies.json"
    rm -f "${metadata}"
    chmod +x \
      "${workdir}/deploy/install.sh" \
      "${workdir}/deploy/intar-jailerd-self-test.sh" \
      "${workdir}/deploy/uninstall.sh"
    (
      cd "${workdir}"
      find . -type f ! -path './deploy/SHA256SUMS' -print0 \
        | LC_ALL=C sort -z \
        | xargs -0 sha256sum > deploy/SHA256SUMS
    )
  fi
  tar -C "${workdir}" -czf "${dist_dir}/${archive}.tar.gz" .
  rm -rf "${workdir}"
}
build_archive amd64 x86_64-unknown-linux-musl
if [ "${PACKAGE}" = "intar-builder" ] || [ "${PACKAGE}" = "intar-agent" ]; then
  echo "Skipping arm64 ${PACKAGE} artifact; the current KVM host baseline is x86_64 only."
else
  build_archive arm64 aarch64-unknown-linux-musl
fi
cd "${dist_dir}"
sha256sum "${BINARY}_${VERSION}_"* > "${BINARY}_${VERSION}_checksums.txt"
