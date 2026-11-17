#!/usr/bin/env bash
# release.yml, job build, step "Build release artifacts".
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
  # Kino runs inside guest VMs, so its release is the size-optimised guest
  # build that run hosts put on each VM's run disk.
  local profile=release
  if [ "${PACKAGE}" = "kino" ]; then
    profile=guest
  fi
  local binary="${target_dir}/${target}/${profile}/${BINARY}"
  local workdir
  CARGO_TARGET_DIR="${target_dir}" \
    cargo zigbuild --locked --profile "${profile}" -p "${PACKAGE}" --bin "${BINARY}" --target "${target}"
  file "${binary}"
  workdir="$(mktemp -d)"
  cp "${binary}" "${workdir}/${BINARY}"
  chmod +x "${workdir}/${BINARY}"
  if [ "${PACKAGE}" = "intar-builder" ]; then
    mkdir -p "${workdir}/deploy"
    # The builder rollout drops retired keys from the host's config with it.
    cp crates/intar-jailerd/deploy/migrate-epoch-config.py "${workdir}/deploy/migrate-epoch-config.py"
  fi
  if [ "${PACKAGE}" = "intar-builder" ] || [ "${PACKAGE}" = "intar-image-cli" ]; then
    dynamic_section="$(readelf -d "${binary}" 2>/dev/null)"
    if grep -Fq '(NEEDED)' <<<"${dynamic_section}"; then
      echo "${binary} retained a dynamic shared-library dependency" >&2
      exit 1
    fi
  fi
  if [ "${PACKAGE}" = "intar-agent" ]; then
    if [ "${arch}" != "amd64" ]; then
      echo "Jailed scenario hosts currently support x86_64 only." >&2
      exit 1
    fi
    CARGO_TARGET_DIR="${target_dir}" \
      cargo zigbuild --locked --release -p intar-jailer --bin intar-jailer --target "${target}"
    CARGO_TARGET_DIR="${target_dir}" \
      cargo zigbuild --locked --release -p intar-jailerd --bin intar-jailerd --target "${target}"
    cp "${target_dir}/${target}/release/intar-jailer" "${workdir}/intar-jailer"
    cp "${target_dir}/${target}/release/intar-jailerd" "${workdir}/intar-jailerd"
    chmod +x "${workdir}/intar-jailer" "${workdir}/intar-jailerd"
    curl --fail --location --retry 3 \
      --output "${workdir}/cloud-hypervisor-v54.1" \
      "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/v54.1/cloud-hypervisor-static"
    echo "f9ffb9646783233d1f0fb09e77db1fca66499d1041e63bc011b90683c0d49933  ${workdir}/cloud-hypervisor-v54.1" | sha256sum --check --strict
    chmod 0555 "${workdir}/cloud-hypervisor-v54.1"
    cp -R crates/intar-jailerd/deploy "${workdir}/deploy"
    cp crates/intar-agent/deploy/intar-agent.service "${workdir}/deploy/intar-agent.service"
    cp crates/intar-agent/deploy/config.example.toml "${workdir}/deploy/intar-agent.config.example.toml"
    sudo apt-get update
    sh deploy/personal-metal/package.sh "${workdir}" "${VERSION}"
    cp deploy/personal-metal/intar-host "${dist_dir}/intar-agent_${VERSION}_intar-host"

    # Bundle the exact upstream license set corresponding to the
    # pinned v54.1 source commit used for the static runtime.
    ch_source="${workdir}/cloud-hypervisor-source.tar.gz"
    curl --fail --location --retry 3 \
      --output "${ch_source}" \
      "https://github.com/cloud-hypervisor/cloud-hypervisor/archive/74aeae19cb1ee2c44d33796b0e4e95e1a68e94dd.tar.gz"
    echo "ced34b5191a16fde8be923682199ff65b984bba10d710b0e9d26ccb7c540d2cb  ${ch_source}" | sha256sum --check --strict
    license_extract="$(mktemp -d)"
    tar -tzf "${ch_source}" | while IFS= read -r entry; do
      case "${entry}" in
        /*|../*|*/../*|*/..) echo "unsafe Cloud Hypervisor source path: ${entry}" >&2; exit 1 ;;
      esac
    done
    tar -xzf "${ch_source}" -C "${license_extract}" --no-same-owner
    cp -R \
      "${license_extract}/cloud-hypervisor-74aeae19cb1ee2c44d33796b0e4e95e1a68e94dd/LICENSES" \
      "${workdir}/deploy/cloud-hypervisor-LICENSES"
    rm -rf "${license_extract}" "${ch_source}"

    metadata="$(mktemp)"
    cargo metadata --locked --format-version 1 > "${metadata}"
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
