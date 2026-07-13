#!/bin/sh
set -eu

CLOUD_HYPERVISOR_SHA256=448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc

die() {
  echo "intar package smoke: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || die "usage: $0 INTAR_AGENT_LINUX_AMD64_ARCHIVE"
[ "$(id -u)" -eq 0 ] || die "must run as root"
[ "$(uname -s)" = Linux ] || die "requires Linux"
[ "$(uname -m)" = x86_64 ] || die "requires x86_64"
[ -c /dev/kvm ] || die "/dev/kvm is unavailable"

archive=$1
case "${archive}" in
  /*) ;;
  *) archive=$(CDPATH='' cd -- "$(dirname -- "${archive}")" && pwd)/$(basename -- "${archive}") ;;
esac
[ -f "${archive}" ] || die "archive does not exist: ${archive}"

for command in awk file find getfacl ip nft python3 readelf readlink setfacl sha256sum stat sysctl systemctl tar; do
  command -v "${command}" >/dev/null 2>&1 || die "required command is missing: ${command}"
done
id intar-agent >/dev/null 2>&1 || die "the intar-agent system user does not exist"
[ -d /run/systemd/system ] || die "systemd is not the active service manager"
systemctl show --property=Version >/dev/null 2>&1 || die "cannot communicate with systemd"

# This destructive test is intentionally limited to a disposable release VM.
for path in \
  /etc/intar-jailerd \
  /etc/intar-agent \
  /usr/lib/intar \
  /usr/local/bin/intar-agent \
  /etc/systemd/system/intar-jailerd.service \
  /etc/systemd/system/intar-jailerd.socket \
  /etc/systemd/system/intar-agent.service \
  /etc/systemd/system/intar-vms.slice \
  /etc/tmpfiles.d/intar-jailerd.conf \
  /etc/sysctl.d/90-intar-jailerd.conf \
  /run/intar-jailerd \
  /usr/share/doc/intar-jailerd \
  /var/cache/intar-agent \
  /var/lib/intar; do
  [ ! -e "${path}" ] && [ ! -L "${path}" ] || \
    die "refusing to overwrite existing state: ${path}"
done

work_root=$(mktemp -d /var/lib/intar-package-smoke.XXXXXX)
package_root=${work_root}/package
installed=0
cleanup_failed=0

cleanup() {
  status=$?
  trap - 0 HUP INT TERM
  if [ "${installed}" -eq 1 ] && ! "${package_root}/deploy/uninstall.sh"; then
    echo "intar package smoke: uninstall refused or failed" >&2
    cleanup_failed=1
  fi

  if live_units=$(systemctl list-units --all --type=service --no-legend --plain 'intar-vm-*.service'); then
    if [ -n "${live_units}" ]; then
      echo "intar package smoke: VM units leaked:" >&2
      echo "${live_units}" >&2
      cleanup_failed=1
    fi
  else
    echo "intar package smoke: could not audit VM units" >&2
    cleanup_failed=1
  fi
  if [ -f /sys/fs/cgroup/intar-vms.slice/cgroup.events ] && \
     [ "$(awk '$1 == "populated" { print $2 }' /sys/fs/cgroup/intar-vms.slice/cgroup.events)" != 0 ]; then
    echo "intar package smoke: VM cgroup descendants leaked" >&2
    cleanup_failed=1
  fi
  if netns_state=$(ip netns list); then
    if echo "${netns_state}" | grep -q '^intar-ns-'; then
      echo "intar package smoke: run network namespace leaked" >&2
      cleanup_failed=1
    fi
  else
    echo "intar package smoke: could not audit network namespaces" >&2
    cleanup_failed=1
  fi
  if nft_state=$(nft list tables); then
    if echo "${nft_state}" | grep -q '^table inet intar_'; then
      echo "intar package smoke: nftables state leaked" >&2
      cleanup_failed=1
    fi
  else
    echo "intar package smoke: could not audit nftables state" >&2
    cleanup_failed=1
  fi
  if grep -Fq '/var/lib/intar/jails/' /proc/self/mountinfo; then
    echo "intar package smoke: jail mount leaked" >&2
    cleanup_failed=1
  fi
  for executable in /proc/[0-9]*/exe; do
    if target=$(readlink "${executable}" 2>/dev/null); then
      case "${target##*/}" in
        cloud-hypervisor|cloud-hypervisor-*)
          echo "intar package smoke: Cloud Hypervisor process leaked: ${executable}" >&2
          cleanup_failed=1
          ;;
      esac
    fi
  done

  rm -rf -- \
    "${work_root}" \
    /etc/intar-agent \
    /etc/intar-jailerd \
    /var/cache/intar-agent \
    /var/lib/intar \
    /run/intar-jailerd \
    /usr/share/doc/intar-jailerd \
    /usr/lib/intar

  for path in \
    /etc/systemd/system/intar-agent.service \
    /etc/systemd/system/intar-jailerd.service \
    /etc/systemd/system/intar-jailerd.socket \
    /etc/systemd/system/intar-vms.slice \
    /etc/tmpfiles.d/intar-jailerd.conf \
    /etc/sysctl.d/90-intar-jailerd.conf \
    /usr/local/bin/intar-agent; do
    if [ -e "${path}" ] || [ -L "${path}" ]; then
      echo "intar package smoke: disposable state leaked: ${path}" >&2
      cleanup_failed=1
    fi
  done
  if [ "${status}" -eq 0 ] && [ "${cleanup_failed}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup 0
trap 'exit 130' HUP INT TERM

mkdir -p "${package_root}"
chmod 0700 "${work_root}" "${package_root}"

# Reject path traversal before extracting even though CI just built the tar.
tar -tzf "${archive}" | while IFS= read -r entry; do
  case "${entry}" in
    /*|../*|*/../*|*/..) die "archive contains an unsafe path: ${entry}" ;;
  esac
done
tar -xzf "${archive}" -C "${package_root}" --no-same-owner
unsafe_entry=$(find "${package_root}" -mindepth 1 ! -type d ! -type f -print -quit)
[ -z "${unsafe_entry}" ] || die "archive extracted a non-regular entry: ${unsafe_entry}"
linked_file=$(find "${package_root}" -type f -links +1 -print -quit)
[ -z "${linked_file}" ] || die "archive extracted a multiply-linked file: ${linked_file}"

for relative in \
  intar-agent \
  intar-jailer \
  intar-jailerd \
  cloud-hypervisor-v53.0 \
  deploy/SHA256SUMS \
  deploy/THIRD_PARTY_NOTICES.md \
  deploy/intar-rust-dependencies.json \
  deploy/cloud-hypervisor-LICENSES/Apache-2.0.txt \
  deploy/cloud-hypervisor-LICENSES/BSD-3-Clause.txt \
  deploy/cloud-hypervisor-LICENSES/CC-BY-4.0.txt \
  deploy/cloud-hypervisor-v53.0.sha256 \
  deploy/config.example.toml \
  deploy/install.sh \
  deploy/intar-jailerd-self-test.sh \
  deploy/uninstall.sh \
  deploy/prepare-v6-cutover.py \
  deploy/intar-agent.service \
  deploy/intar-agent.config.example.toml \
  deploy/intar-jailerd.service \
  deploy/intar-jailerd.socket \
  deploy/intar-jailerd.sysctl.conf \
  deploy/intar-jailerd.tmpfiles \
  deploy/intar-vms.slice; do
  [ -f "${package_root}/${relative}" ] && [ ! -L "${package_root}/${relative}" ] || \
    die "archive is missing a regular ${relative}"
done
(cd "${package_root}" && sha256sum --check --strict deploy/SHA256SUMS)

for binary in intar-agent intar-jailer intar-jailerd cloud-hypervisor-v53.0; do
  [ -x "${package_root}/${binary}" ] || die "archive binary is not executable: ${binary}"
done
[ -x "${package_root}/deploy/prepare-v6-cutover.py" ] || \
  die "archive V6 cutover helper is not executable"
cloud_hypervisor=${package_root}/cloud-hypervisor-v53.0
echo "${CLOUD_HYPERVISOR_SHA256}  ${cloud_hypervisor}" | sha256sum --check --strict
file_output=$(file --brief "${cloud_hypervisor}")
case "${file_output}" in
  *ELF*64-bit*x86-64*statically\ linked*|*ELF*64-bit*x86-64*static-pie\ linked*) ;;
  *) die "Cloud Hypervisor is not a static x86_64 ELF: ${file_output}" ;;
esac
if readelf --program-headers "${cloud_hypervisor}" | grep -q 'Requesting program interpreter'; then
  die "Cloud Hypervisor contains a dynamic program interpreter"
fi
if readelf --dynamic "${cloud_hypervisor}" 2>/dev/null | grep -q '(NEEDED)'; then
  die "Cloud Hypervisor contains a dynamic shared-library dependency"
fi
version_output=$("${cloud_hypervisor}" --version 2>&1)
case "${version_output}" in
  *cloud-hypervisor*v53.0*) ;;
  *) die "unexpected Cloud Hypervisor version: ${version_output}" ;;
esac

cutover_helper=${package_root}/deploy/prepare-v6-cutover.py
agent_uid=$(id -u intar-agent)
agent_gid=$(id -g intar-agent)
agent_config=/etc/intar-agent/config.toml
agent_database=/var/cache/intar-agent/state/intar-agent/intar-agent.sqlite3

# Exercise the exact destructive upgrade path used by the first V6 rollout.
# The fake credential is never printed; semantic comparison after install
# proves that every value except cloud_hypervisor.binary survived unchanged.
fresh_state=$(python3 "${cutover_helper}" \
  --mode inspect \
  --config "${agent_config}" \
  --database "${agent_database}" \
  --agent-uid "${agent_uid}" \
  --agent-gid "${agent_gid}")
[ "${fresh_state}" = fresh ] || die "cutover helper did not recognize fresh state"

install -d -o root -g root -m 0755 /etc/intar-agent
install -d -o "${agent_uid}" -g "${agent_gid}" -m 0700 \
  /var/cache/intar-agent \
  /var/cache/intar-agent/state \
  /var/cache/intar-agent/state/intar-agent
python3 - \
  "${package_root}/deploy/intar-agent.config.example.toml" \
  "${agent_config}" \
  "${agent_database}" \
  "${agent_uid}" \
  "${agent_gid}" <<'PY'
import json
import os
import sqlite3
import sys
from pathlib import Path

source, config_path, database_path = map(Path, sys.argv[1:4])
agent_uid = int(sys.argv[4])
agent_gid = int(sys.argv[5])
text = source.read_text()
marker = "[jailer]\n"
if text.count(marker) != 1:
    raise SystemExit("agent fixture lacks one jailer table")
legacy = text.replace(
    marker,
    '[cloud_hypervisor]\nbinary = "/usr/local/bin/cloud-hypervisor-legacy"\nspawn_timeout_seconds = 10\n\n[jailer]\n',
    1,
)
legacy = legacy.replace('bootstrap_token = ""', 'bootstrap_token = "cutover-test-secret"', 1)
config_path.write_text(legacy)
os.chown(config_path, 0, agent_gid)
os.chmod(config_path, 0o640)

connection = sqlite3.connect(database_path)
connection.executescript(
    """
CREATE TABLE vms (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  image_key TEXT,
  image_sha256 TEXT,
  created_at_s INTEGER NOT NULL,
  updated_at_s INTEGER NOT NULL,
  running_at_s INTEGER,
  error TEXT,
  root_disk_path TEXT,
  seed_disk_path TEXT,
  mac TEXT,
  lease_duration_seconds INTEGER,
  guest_ip TEXT,
  guest_ip_cidr TEXT,
  gateway TEXT,
  bridge_name TEXT,
  ssh_public_port INTEGER,
  tap_name TEXT,
  ch_socket_path TEXT,
  ch_pid INTEGER,
  kino_vsock_cid INTEGER,
  kino_vsock_port INTEGER,
  kino_vsock_path TEXT,
  ssh_host_keys_openssh_json TEXT,
  run_id TEXT,
  recording_disk_path TEXT,
  spool_dir TEXT
);
CREATE TABLE vm_probe_state (
  vm_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_state TEXT NOT NULL,
  collection_error TEXT,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE archive_jobs (
  run_id TEXT NOT NULL,
  vm_name TEXT NOT NULL,
  vm_created_at_ms INTEGER NOT NULL,
  delete_requested_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  artifacts_dir TEXT NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, vm_name)
);
CREATE TABLE desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE image_cache_access (
  image_sha256 TEXT PRIMARY KEY,
  image_key TEXT NOT NULL,
  kernel_sha256 TEXT NOT NULL,
  initrd_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL
);
"""
)
desired = {
    "schema_version": 2,
    "host_id": "cutover-smoke",
    "version": 1,
    "generated_at_unix_ms": 1,
    "cached_images": [],
    "vms": [
        {
            "run_id": f"absent-run-{index}",
            "vm_name": f"absent-vm-{index}",
            "desired_phase": "absent",
            "image_key": {
                "scenario": "cutover-smoke",
                "vm": f"absent-vm-{index}",
                "arch": "x86_64",
            },
            "image_sha256": "a" * 64,
            "resources": {"cpu_count": 1, "memory_mib": 512, "disk_mib": 4096},
            "ssh_authorized_keys_openssh": [],
            "lease_expires_at_unix_ms": 1,
        }
        for index in range(2)
    ],
    "builds": [],
}
connection.execute(
    "INSERT INTO desired_state (id, host_id, version, doc_json, updated_at_ms) VALUES (1, ?, 1, ?, 1)",
    ("cutover-smoke", json.dumps(desired)),
)
connection.commit()
connection.close()
os.chown(database_path, agent_uid, agent_gid)
os.chmod(database_path, 0o600)
PY

legacy_state=$(python3 "${cutover_helper}" \
  --mode inspect \
  --config "${agent_config}" \
  --database "${agent_database}" \
  --agent-uid "${agent_uid}" \
  --agent-gid "${agent_gid}")
[ "${legacy_state}" = legacy-drained ] || die "cutover helper did not recognize drained V5 state"

# Persisted local VM state, a non-absent desired VM, a malformed absent
# tombstone, and any desired build must each block the cutover without
# modifying inputs or creating an archive. Valid absent tombstones remain
# eligible because they are drained deletion facts, not workload authority.
unsafe_root=${work_root}/unsafe-cutover
install -d -o root -g root -m 0700 "${unsafe_root}"
for unsafe_case in local-vm running-tombstone malformed-tombstone build-workload; do
  install -d -o root -g root -m 0700 \
    "${unsafe_root}/${unsafe_case}" \
    "${unsafe_root}/${unsafe_case}/config" \
    "${unsafe_root}/${unsafe_case}/archives" \
    "${unsafe_root}/${unsafe_case}/archives/attempt"
  install -d -o "${agent_uid}" -g "${agent_gid}" -m 0700 \
    "${unsafe_root}/${unsafe_case}/state"
  install -o root -g "${agent_gid}" -m 0640 \
    "${agent_config}" "${unsafe_root}/${unsafe_case}/config/config.toml"
done
python3 - "${agent_database}" "${unsafe_root}" "${agent_uid}" "${agent_gid}" <<'PY'
import json
import os
import sqlite3
import sys
from pathlib import Path

source_path = Path(sys.argv[1])
unsafe_root = Path(sys.argv[2])
agent_uid = int(sys.argv[3])
agent_gid = int(sys.argv[4])
for case_name in ("local-vm", "running-tombstone", "malformed-tombstone", "build-workload"):
    source = sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)
    destination_path = unsafe_root / case_name / "state" / "intar-agent.sqlite3"
    destination = sqlite3.connect(destination_path)
    source.backup(destination)
    source.close()
    if case_name == "local-vm":
        destination.execute(
            "INSERT INTO vms (name, state, created_at_s, updated_at_s) VALUES ('unsafe-vm', 'running', 1, 1)"
        )
    else:
        row = destination.execute("SELECT id, doc_json FROM desired_state").fetchone()
        if row is None:
            raise SystemExit("unsafe cutover fixture lacks desired state")
        document = json.loads(row[1])
        if case_name == "running-tombstone":
            document["vms"][0]["desired_phase"] = "running"
        elif case_name == "malformed-tombstone":
            del document["vms"][0]["run_id"]
        else:
            document["builds"].append({"build_id": "unsafe-build"})
        destination.execute(
            "UPDATE desired_state SET doc_json = ? WHERE id = ?",
            (json.dumps(document), row[0]),
        )
    destination.commit()
    destination.close()
    os.chown(destination_path, agent_uid, agent_gid)
    os.chmod(destination_path, 0o600)
PY
for unsafe_case in local-vm running-tombstone malformed-tombstone build-workload; do
  unsafe_config=${unsafe_root}/${unsafe_case}/config/config.toml
  unsafe_database=${unsafe_root}/${unsafe_case}/state/intar-agent.sqlite3
  unsafe_archive=${unsafe_root}/${unsafe_case}/archives/attempt
  unsafe_config_before=$(sha256sum "${unsafe_config}" | awk '{print $1}')
  unsafe_database_before=$(sha256sum "${unsafe_database}" | awk '{print $1}')
  if python3 "${cutover_helper}" \
    --mode apply \
    --config "${unsafe_config}" \
    --database "${unsafe_database}" \
    --agent-uid "${agent_uid}" \
    --agent-gid "${agent_gid}" \
    --archive-dir "${unsafe_archive}"; then
    die "cutover helper accepted unsafe ${unsafe_case} state"
  fi
  [ "$(sha256sum "${unsafe_config}" | awk '{print $1}')" = "${unsafe_config_before}" ] || \
    die "refused ${unsafe_case} cutover changed the config"
  [ "$(sha256sum "${unsafe_database}" | awk '{print $1}')" = "${unsafe_database_before}" ] || \
    die "refused ${unsafe_case} cutover changed the database"
  [ -z "$(find "${unsafe_archive}" -mindepth 1 -print -quit)" ] || \
    die "refused ${unsafe_case} cutover wrote an archive"
done
rm -rf -- "${unsafe_root}"

legacy_config_before=$(sha256sum "${agent_config}" | awk '{print $1}')
legacy_database_before=$(sha256sum "${agent_database}" | awk '{print $1}')
if "${package_root}/deploy/install.sh"; then
  die "installer accepted V5 state without --breaking-v6-cutover"
fi
[ "$(sha256sum "${agent_config}" | awk '{print $1}')" = "${legacy_config_before}" ] || \
  die "unflagged installer changed the legacy config"
[ "$(sha256sum "${agent_database}" | awk '{print $1}')" = "${legacy_database_before}" ] || \
  die "unflagged installer changed the legacy database"
[ ! -e /var/lib/intar/cutover-archives ] || \
  die "unflagged installer created a cutover archive"

installed=1
"${package_root}/deploy/install.sh" --breaking-v6-cutover

cutover_archive=$(find /var/lib/intar/cutover-archives -mindepth 1 -maxdepth 1 -type d -print)
[ -n "${cutover_archive}" ] || die "installer did not create the V5 cutover archive"
[ "$(printf '%s\n' "${cutover_archive}" | wc -l)" -eq 1 ] || die "installer created multiple cutover archives"
[ ! -e "${agent_database}" ] && [ ! -L "${agent_database}" ] || die "legacy SQLite database was not reset"
for archived in \
  "${cutover_archive}/intar-agent.config.v5.toml" \
  "${cutover_archive}/intar-agent.v5.sqlite3" \
  "${cutover_archive}/manifest.json"; do
  [ -f "${archived}" ] && [ ! -L "${archived}" ] || die "cutover archive is incomplete"
  [ "$(stat -c '%u:%g:%a:%h' "${archived}")" = 0:0:600:1 ] || \
    die "cutover archive file is not root-only"
done
python3 - "${cutover_archive}" "${agent_config}" <<'PY'
import json
import sqlite3
import sys
import tomllib
from pathlib import Path

archive = Path(sys.argv[1])
current_path = Path(sys.argv[2])
legacy = tomllib.loads((archive / "intar-agent.config.v5.toml").read_text())
current = tomllib.loads(current_path.read_text())
binary = legacy.get("cloud_hypervisor", {}).pop("binary", None)
if binary != "/usr/local/bin/cloud-hypervisor-legacy":
    raise SystemExit("archive did not preserve the legacy runtime path")
if legacy != current:
    raise SystemExit("cutover changed config values other than cloud_hypervisor.binary")
if current.get("bridge", {}).get("bootstrap_token") != "cutover-test-secret":
    raise SystemExit("cutover did not preserve the test credential")
manifest = json.loads((archive / "manifest.json").read_text())
if manifest.get("removed_config_key") != "cloud_hypervisor.binary":
    raise SystemExit("cutover manifest is missing the removed key")
verified_counts = manifest.get("verified_safe_state", {})
if verified_counts.get("desired_vm_tombstones") != 2:
    raise SystemExit("cutover manifest did not record the safe absent tombstones")
with sqlite3.connect(archive / "intar-agent.v5.sqlite3") as database:
    if database.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
        raise SystemExit("cutover database archive failed quick_check")
    if database.execute("SELECT COUNT(*) FROM vms").fetchone()[0] != 0:
        raise SystemExit("cutover database archive contains VM state")
PY
current_state=$(python3 "${cutover_helper}" \
  --mode inspect \
  --config "${agent_config}" \
  --database "${agent_database}" \
  --agent-uid "${agent_uid}" \
  --agent-gid "${agent_gid}")
[ "${current_state}" = current ] || die "cutover helper did not recognize completed V6 state"

# A one-vCPU CI runner needs an explicit zero host reserve for the disposable
# 125-millicore proof. Production keeps the 1000m default.
sed -i 's/^cpu_reserved_millis = .*/cpu_reserved_millis = 0/' /etc/intar-jailerd/config.toml
case "$(stat -c '%u:%g:%a' /etc/intar-jailerd/config.toml)" in
  0:0:400|0:0:600) ;;
  *) die "smoke config lost trusted ownership or mode" ;;
esac

self_test=/usr/lib/intar/intar-jailerd-self-test
[ -x "${self_test}" ] || die "installed self-test wrapper is missing"
help_output=$("${self_test}" --help 2>&1 || true)
echo "${help_output}" | grep -q -- '--offline' || die "self-test wrapper lacks offline mode"
"${self_test}"

/usr/local/bin/intar-agent --doctor --config /etc/intar-agent/config.toml
echo "intar package smoke: installed v53.0 jailed lifecycle, quota and doctor passed"
