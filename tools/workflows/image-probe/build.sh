#!/usr/bin/env bash
# image-probe.yml, job build, step "Build a lab image".
# A measurement, not a pipeline: reports whether this runner has KVM and which
# processor, then builds the repository's own lab for the runner's
# own architecture with the same code the builder runs, cold, and writes the
# times to the job summary. Nothing is uploaded.
set -euo pipefail
arch="${PROBE_ARCH}"
case "$(uname -m)/${arch}" in
  x86_64/amd64) qemu=qemu-system-x86_64; qemu_package=qemu-system-x86 ;;
  aarch64/arm64) qemu=qemu-system-aarch64; qemu_package=qemu-system-arm ;;
  *) echo "This $(uname -m) runner cannot build ${arch} images natively." >&2; exit 1 ;;
esac
buildkit_version=v0.30.0
umoci_version=v0.6.0
case "${arch}" in
  amd64)
    buildkit_sha256=2da148c50540409988c837e62b72176e4a9ad7855548a2dd6ea1cd0c0d2d360d
    umoci_sha256=b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71 ;;
  arm64)
    buildkit_sha256=d0c9601e49f441dcc5c6493c884275a5470dcc9c188c96573c4dd503f2fde97d
    umoci_sha256=5cfd17f2e7a4bcf9ed67ea1b955ca893d200349b9ce6a3d3707dba415f458a1f ;;
esac

work="${RUNNER_TEMP}/probe"
tools="${work}/tools"
oci="${work}/oci"
mkdir -p "${tools}/bin" "${oci}" "${work}/logs"

kvm=missing
[ -c /dev/kvm ] && kvm=present
{
  printf '### %s runner\n\n' "${arch}"
  printf -- '- processor: %s\n' "$(lscpu | sed -n 's/^Model name: *//p; s/^Vendor ID: *//p' | paste -sd ' ' -)"
  printf -- '- threads: %s, memory: %s MiB, free disk: %s\n' "$(nproc)" "$(free -m | awk '/^Mem:/ {print $2}')" "$(df -h --output=avail "${RUNNER_TEMP}" | tail -1 | tr -d ' ')"
  printf -- '- /dev/kvm: %s\n' "${kvm}"
} | tee -a "${GITHUB_STEP_SUMMARY}"
lscpu
if [ "${kvm}" != present ]; then
  echo "No /dev/kvm on this runner: a native ${arch} build VM cannot run here." | tee -a "${GITHUB_STEP_SUMMARY}" >&2
  exit 1
fi

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${qemu_package}" qemu-utils qemu-system-common e2fsprogs zstd jq > "${work}/logs/apt.log"
"${qemu}" --version | head -1

fetch() { curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --silent --show-error --output "$2" "$1"; }
fetch "https://github.com/moby/buildkit/releases/download/${buildkit_version}/buildkit-${buildkit_version}.linux-${arch}.tar.gz" "${tools}/buildkit.tar.gz"
fetch "https://github.com/opencontainers/umoci/releases/download/${umoci_version}/umoci.linux.${arch}" "${tools}/bin/umoci"
printf '%s  %s\n%s  %s\n' "${buildkit_sha256}" "${tools}/buildkit.tar.gz" "${umoci_sha256}" "${tools}/bin/umoci" | sha256sum --check
tar -xzf "${tools}/buildkit.tar.gz" -C "${tools}"
chmod 0755 "${tools}/bin/umoci"

# A private BuildKit whose socket is in the OCI cache root, as on the builder.
# It runs in a privileged container: the runner's own cgroup tree is read-only,
# so a daemon started on it directly cannot run a build step.
sudo docker run --detach --privileged --name intar-probe-buildkitd --volume "${oci}:${oci}" \
  "moby/buildkit:${buildkit_version}" --addr "unix://${oci}/buildkitd.sock" > /dev/null
for _ in $(seq 1 30); do
  sudo "${tools}/bin/buildctl" --addr "unix://${oci}/buildkitd.sock" debug workers > /dev/null 2>&1 && break
  sleep 1
done
sudo "${tools}/bin/buildctl" --addr "unix://${oci}/buildkitd.sock" debug workers

cargo build --locked --release --quiet -p intar-image-build --example build_machine
target_dir="$(cargo metadata --format-version 1 --no-deps | jq -er .target_directory)"
cargo run --locked --release --quiet -p intar-image-cli -- bundle --root content --rev probe --no-upload --output "${work}/bundle.json.gz"

jq -n --arg arch "${arch}" --arg qemu "$(command -v "${qemu}")" --arg work "${work}" --arg tools "${tools}" --arg oci "${oci}" --argjson cpus "$(( $(nproc) < 4 ? $(nproc) : 4 ))" '{
  target_arch: $arch, qemu_binary: $qemu, accelerator: "kvm",
  provision_timeout_seconds: 2400, qemu_exit_timeout_seconds: 300,
  build_cpus: $cpus, build_memory_mb: 4096,
  output_root: ($work + "/dist"), work_root: ($work + "/work"),
  layered: {
    qemu_img_binary: "qemu-img", buildctl_binary: ($tools + "/bin/buildctl"), umoci_binary: ($tools + "/bin/umoci"),
    oci_cache_root: $oci, checkpoint_cache_root: ($work + "/checkpoints"), use_cache: true
  }
}' > "${work}/qemu.json"
cat "${work}/qemu.json"

printf '\n| target | result | wall | base | build | output |\n|---|---|---|---|---|---|\n' >> "${GITHUB_STEP_SUMMARY}"
failed=0
n=0
# The repository's own lab; the Kubernetes labs are in a private repository.
for target in broken-nginx/webserver; do
  n=$((n + 1))
  started="$(date +%s)"
  result=built
  sudo "${target_dir}/release/examples/build_machine" build "${work}/bundle.json.gz" "${target}" "${work}/out-${n}" "${work}/qemu.json" \
    > "${work}/logs/${n}.out" 2> "${work}/logs/${n}.err" || result=failed
  wall="$(( $(date +%s) - started ))"
  cat "${work}/logs/${n}.out"
  times="$(sed -n 's/^base_s=\([0-9.]*\) build_s=\([0-9.]*\) output_s=\([0-9.]*\) .*/\1 s | \2 s | \3 s/p' "${work}/logs/${n}.out")"
  printf '| %s | %s | %s s | %s |\n' "${target}" "${result}" "${wall}" "${times:-- | - | -}" >> "${GITHUB_STEP_SUMMARY}"
  sudo sh -c "grep -ah 'intar-machine' '${work}'/work/*.build.log" || true
  if [ "${result}" = failed ]; then
    failed=1
    tail -n 60 "${work}/logs/${n}.err" >&2
    sudo sh -c "tail -n 80 '${work}'/work/*.build.log '${work}'/work/*.serial.log" >&2 || true
  fi
done
exit "${failed}"
