---
title: Builder Host Onboarding
---

`intar-builder` runs on a dedicated Linux VM and receives image build assignments
from the control plane over the bridge. Builder hosts are separate from scenario
agent hosts; they do not run user scenarios.

## Host Requirements

- Ubuntu 24.04 or Debian 12/13 on x86_64.
- KVM enabled and visible as `/dev/kvm`.
- QEMU 10 or later.
- 8 vCPU, 16 GiB RAM, and at least 100 GiB disk for working directories and caches.
- Outbound HTTPS access to `intar.dev`, GitHub release downloads, and Debian package
  mirrors.

Install the common runtime packages:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  e2fsprogs \
  kmod \
  openssh-client \
  qemu-system-x86 \
  qemu-utils \
  zstd
```

Install `buildctl`, `buildkitd`, and `umoci` from your approved package source.
The builder uses the OCI rootfs and QEMU VM stages for every image.
Use a package source that supplies QEMU 10 or later.
The current builder uses `/usr/bin/qemu-storage-daemon` version 10.0.11. It
exports the finished disk through a private Unix NBD socket.
The released builder links libnbd statically. The host does not need a libnbd
package or shared library.
Before a build starts, builder doctor requires the configured storage daemon to
show `--nbd-server` and the `--export [type=]nbd` form in its `--help` output.

Verify KVM before installing the daemon:

```bash
test -c /dev/kvm
test -x /usr/bin/qemu-storage-daemon
groups
```

The service user must be able to open `/dev/kvm`. On Debian/Ubuntu that usually
means adding it to the `kvm` group.

## Create The Host

In the admin UI, open Hosts and create a host with role `builder`. Copy the
generated `host_id` and bootstrap token. Builder hosts are created with scenario
scheduling disabled.

## Install The Binary

Download the `intar-builder_<version>_linux_amd64.tar.gz` release artifact for
the target version, then install it. Guest tools are published separately and
are not downloaded or baked by the image builder.
Keep the artifact's `third-party/libnbd` directory with the release record. It
contains the libnbd source, license, verification record, and relink material.
It is not a host runtime dependency.

```bash
sudo install -d /usr/local/bin /etc/intar-builder /var/lib/intar-builder/work /var/cache/intar-builder
sudo install -m 0755 ./intar-builder /usr/local/bin/intar-builder
```

Create `/etc/intar-builder/config.toml`:

```toml
[bridge]
base_url = "https://intar.dev"
host_id = "builder_HOST_ID_FROM_ADMIN"
bootstrap_token = "BOOTSTRAP_TOKEN_FROM_ADMIN"
heartbeat_interval_seconds = 20

[builder]
work_root = "/var/lib/intar-builder/work"
cache_root = "/var/cache/intar-builder"
state_db = "/var/lib/intar-builder/state.sqlite3"

[qemu]
qemu_binary = "qemu-system-x86_64"
qemu_storage_daemon_binary = "/usr/bin/qemu-storage-daemon"
mke2fs_binary = "mke2fs"
e2fsck_binary = "e2fsck"
resize2fs_binary = "resize2fs"
ssh_wait_timeout_seconds = 1200
provision_timeout_seconds = 2400
qemu_exit_timeout_seconds = 300
raw_view_read_timeout_seconds = 1200
accelerator = "kvm"
build_cpus = 4
build_memory_mb = 4096

[qemu.layered]
qemu_img_binary = "qemu-img"
buildctl_binary = "/var/lib/intar-builder/layered-tools/bin/buildctl"
umoci_binary = "/var/lib/intar-builder/layered-tools/bin/umoci"
debian_image = "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f"
oci_cache_root = "/var/cache/intar-builder/candidate/oci"
checkpoint_cache_root = "/var/cache/intar-builder/candidate/checkpoints"
use_cache = true
oci_cache_bytes = 8589934592
checkpoint_cache_bytes = 42949672960
minimum_free_bytes = 21474836480

[jobs]
max_attempts = 3
max_concurrent_builds = 2
```

Default settings are in `crates/intar-builder/deploy/config.example.toml`.
The paths above use the existing builder host's tools and cache.

## OCI VM Build

Every build uses the OCI rootfs and QEMU VM stages. QEMU 10 or later is
required for its QMP structured exec channels. `intar-builder doctor` rejects
an older or malformed QEMU version. The checkpoint proof uses QEMU 10.0.11.
Repeat that proof before changing the QEMU version or device configuration.

The defaults set an 8 GiB OCI cache, a 40 GiB checkpoint cache, and a 20 GiB
free-disk floor. Set `use_cache = false` to make a cold service build. For one
local build, use `intar-image-cli build --no-cache` or
`intar-image-cli build-all --no-cache`. The clean-base proof also makes a cold
OCI build.

The OCI unpack and ext4 proof passed 44 checks for ownership, permissions,
capabilities, links, and layer deletions.

### Direct NBD reader

During chunk scanning, QEMU storage daemon exports the finished QCOW2 work disk
through a transient, read-only NBD server on a private Unix socket. The builder
reads it through libnbd, then closes the socket and storage daemon. This does
not change `RawChunksV1`. Do not rely on a physical `work/root.raw` after a
build; that file is not a compatibility contract.

`raw_view_read_timeout_seconds` is a 1,200-second watchdog for the NBD scan,
chunk lookup, and encoding. It does not change guest-step or provisioning
timeouts.

For a local `build --no-upload` proof, reconstruct the final local chunks into
a new temporary raw disk before running the published-image check. For example:

```bash
readonly OUTPUT_ROOT=dist
readonly STEM=broken-nginx-webserver-amd64
readonly RAW_VIEW="/tmp/${STEM}.raw"

intar-image-cli reconstruct \
  --chunk-manifest "${OUTPUT_ROOT}/${STEM}.chunks.json" \
  --chunks-dir "${OUTPUT_ROOT}/${STEM}.chunks" \
  --output "${RAW_VIEW}"
sudo python3 tools/image-build/verify-published-image.py \
  --disk "${RAW_VIEW}" \
  --initrd "${OUTPUT_ROOT}/${STEM}.chunks.initrd" \
  --manifest "${OUTPUT_ROOT}/${STEM}.manifest.json" \
  --source-dir .work/qemu/broken-nginx/webserver
```

### BuildKit daemon

BuildKit uses the root-only TOML file
`/etc/intar-builder/buildkitd.toml`. Copy the verified file there with owner
`root`, group `root`, and mode `0600` before enabling the service. The installed
service must not depend on a benchmark directory after a reboot. Use this
configuration:

```toml
[worker.oci]
  enabled = true
  gc = true
  binary = "/var/lib/intar-builder/layered-tools/bin/buildkit-runc"
  max-parallelism = 2
  maxUsedSpace = 6442450944
  minFreeSpace = 21474836480

[worker.containerd]
  enabled = false
```

The TOML sets garbage collection, two parallel tasks, a 6 GiB worker limit,
and a 20 GiB free-space floor. The remaining 2 GiB of the OCI budget holds
converted ext4 disks. Do not add `--oci-worker-gc`,
`--oci-worker-gc-keepstorage`, or `--oci-max-parallelism` to `ExecStart`.

Use absolute paths for `buildkitd`, `buildkit-runc`, and `buildctl`. The OCI
cache root is `/var/cache/intar-builder/candidate/oci`. Keep its root and
socket paired as `<oci_cache_root>/buildkitd` and
`unix://<oci_cache_root>/buildkitd.sock`. Do not create another daemon root or
socket.

Create this systemd unit:

```ini
[Unit]
Description=Intar image build OCI cache
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
UMask=0077
ExecStart=/var/lib/intar-builder/layered-tools/bin/buildkitd --config /etc/intar-builder/buildkitd.toml --root /var/cache/intar-builder/candidate/oci/buildkitd --addr unix:///var/cache/intar-builder/candidate/oci/buildkitd.sock
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

If a native BuildKit process already uses this socket, wait for all build tasks
to finish, verify its process identity and configuration, then stop it before
starting the service. Reuse its cache root.

Save the unit as `/etc/systemd/system/intar-buildkitd.service`, then run:

```bash
sudo install -d -m 0755 /var/cache/intar-builder/candidate/oci
sudo systemctl daemon-reload
sudo systemctl enable --now intar-buildkitd
sudo timeout -s KILL 30s bash -c '
  buildctl=$1
  socket=$2
  while :; do
    if systemctl is-active --quiet intar-buildkitd >/dev/null 2>&1 \
      && "$buildctl" --addr "unix://${socket}" debug workers >/dev/null 2>&1; then
      exit 0
    fi
    sleep 1
  done
' _ \
  /var/lib/intar-builder/layered-tools/bin/buildctl \
  /var/cache/intar-builder/candidate/oci/buildkitd.sock
```

The GNU `timeout` limits the complete wait, including a blocked workers query.
If it expires, do not start `intar-builder`.

Keep the installed builder binary as a measurement reference. Do not use it
alone for rollback: an older builder recomputes the v11 content hash and rejects
a v12 desired hash. A rollback requires matched previous builder, image CLI, and
control-plane releases. The source has one build backend and no backend selector.
Published image contracts do not change.

## Cache, Publication, and Proof

Checkpoint cache v3 is private to the builder root account. Cache payloads use
BLAKE3 integrity checks. A private per-scenario role index retains the
before-last and expensive-prefix checkpoints without changing payload files.
Older checkpoint entries are rebuilt. Public image hashes and manifests still
use SHA-256. Keep cache entries and their leases private. Do not upload cache
files.

Keep the checkpoint before the last authored step. Keep a checkpoint after the
last authored step only when that step takes at least 30 seconds. Do not keep
earlier intermediate checkpoints.

Publication output is durable across retries. Keep the state database, work
directory, and cache directory until publication succeeds. Do not remove a
completed output after a retryable publication failure.

Before installing a new builder, drain the host and stop the builder. Remove
only old directories in `bundles-unpacked` that lack
`.intar-bundle-v1.complete`. Keep marked bundle revisions. The builder has no
backend selector. Remove old configuration keys such as `mmdebstrap_binary`,
`backend`, `qemuargs`, `base_cache_root`, and `umount_binary` before restart.
`umount_binary` is obsolete because the builder reads the finished disk through
NBD.

### Benchmark gate

The warm full-catalog median must be at least 2 times as fast. A cold run must
not exceed the baseline by more than 20%.

The cold numerical gate passed: the median was `1,491,536 ms`, compared with
the `1,265,784 ms` baseline. It is 17.8% slower and stays within the 20%
limit.

The cold samples used builder `0.10.1`, image CLI `0.6.1`, frozen source
`64d4f6932b75790681c1d6f8d7f412906e5d8e66`, and resource profile
`candidate-v0101-4cpu`: [cold 1](https://github.com/intar-dev/scenarios/actions/runs/34413598335),
[cold 2](https://github.com/intar-dev/scenarios/actions/runs/34416248124), and
[cold 3](https://github.com/intar-dev/scenarios/actions/runs/34418475024).

The warm numerical gate passed: the median was `449,299 ms`, compared with the
`1,191,256 ms` baseline. It is 2.65 times as fast and exceeds the 2
times target.

The warm samples used the same releases, source, and resource profile:
[warm 1](https://github.com/intar-dev/scenarios/actions/runs/34420429855),
[warm 2](https://github.com/intar-dev/scenarios/actions/runs/34421121711), and
[warm 3](https://github.com/intar-dev/scenarios/actions/runs/34421854845).

The raw full-fingerprint comparison remains `passed=false` and is classified as
cross-harness. The only verified change is archive extraction before the timer.
The timing workflow and helper are frozen and unchanged. Do not describe the
raw cross-harness result as passed.

The old one-fault-edit series has `l1 = 249,312 ms`. The old
[late 2](https://github.com/intar-dev/scenarios/actions/runs/34458106719) run
was cancelled as an infrastructure failure at `2026-09-10T09:30:32Z`. Its
artifact is retained, but it has no complete measurement. `l3` was not
dispatched. Do not calculate a median for this old series.

The request-local positive R2 HEAD memo and four-worker dynamic index patch
merged in [PR 158](https://github.com/intar-dev/intar-dev/pull/158) at
`042e2125282ade8982764ce7d1ecf087c728ccad`. The
[website deployment](https://github.com/intar-dev/intar-dev/actions/runs/34462582925)
succeeded. Worker `2d8b3dbf-e653-4a0a-bb8e-60056ccef993` returned HTTP 200
from `/api/health`.

A normal learner `MissingOnly` refresh started at `09:50:55 UTC`, listed 382
images, reused 381, prepared the missing image, and finished at `09:51:07 UTC`.
This is recovery evidence only. It is not a new authenticated probe and does
not provide an index-latency measurement.

The separate `candidate-v12n4-registry-late` cohort completed. It has a changed
web identity and uses a new controller root, but it keeps the existing v12n3
BuildKit process, configuration, and shared cache. Do not mix it with the
frozen cold and warm results.

| Sample | Workflow                                                                       | Full duration | Host preparation | Artifact SHA-256                                                   |
| ------ | ------------------------------------------------------------------------------ | ------------: | ---------------: | ------------------------------------------------------------------ |
| `lr1`  | [34464270821](https://github.com/intar-dev/scenarios/actions/runs/34464270821) |    236,361 ms |        16,178 ms | `991c6936b6f03977b266df72278a8a65b2c4b5e3e73611960433b766aad710ec` |
| `lr2`  | [34464951777](https://github.com/intar-dev/scenarios/actions/runs/34464951777) |    238,939 ms |        16,995 ms | `36198ee995470223dcf19a239a7e86af488628b2f1c81badd6f75e1eb486959b` |
| `lr3`  | [34465521327](https://github.com/intar-dev/scenarios/actions/runs/34465521327) |    245,946 ms |        32,444 ms | `c79273f7d36df0e3814439e460608b32fbc9e56756744907237409a776983c0b` |

The separate late-step median is `238,939 ms`, compared with the `314,852 ms`
baseline. It uses 24.1107% less time, or is 1.3177 times as fast. It is not a
cold or warm full-catalog gate.

No comparable before-and-after boot measurement exists for this cohort. Do not
claim faster boots.

Final verification of the third empty-cache candidate build (C3) passed all
26 work-order and published-solution comparisons. All seven build credential
paths were absent from each of its 13 published image root disks. A fresh drain
completed at `2026-09-10T14:31:46Z` with zero desired VMs.

All 13 candidate scenarios completed fresh Cloud Hypervisor starts, initial
fault checks, published solutions, final checks, main-run replay, reset checks,
and deletion.

The OCI layer and VM checkpoint builder is installed as `intar-builder 0.10.1`
with `intar-image-cli 0.6.1`. [Canonical catalog promotion](https://github.com/intar-dev/intar-dev/actions/runs/34492053933)
succeeded at `2026-09-10T14:54:04Z` with `main` revision
`a6812ca8b0ac7f51ebe08bace909e22b2d8f3f67`. It selected
`scenarios-aa057325eff8c2701e4a8957c52cffd3171b8f85`.

[A normal republish](https://github.com/intar-dev/scenarios/actions/runs/34491886645)
completed with all 13 images in `Ready`. It reused the existing canonical image
IDs and guest tool pins. These image IDs differ from the C3 candidate IDs.
The `intar-agent 0.12.12` package is installed. It protects required guest-tools
disks from cache eviction and prepares them before scenario image refresh.
Its offline self-test, doctor, running process hashes, service health, and stable
tools checks passed. [Scenario scheduling was enabled](https://github.com/intar-dev/intar-dev/actions/runs/34497076945)
at `2026-09-10T15:40:43Z`.

A normal Broken Nginx learner run then passed the expected initial faults,
published solution, all four final checks, HTTP, and the runtime credential
check. Its recording was verified and the test run was deleted. The learner
host had zero VM rows and archive jobs at `2026-09-10T15:46:11Z`.

Some candidate rollout and HTTP checks needed a repeat after convergence. One
fresh candidate run lacks raw terminal recording despite an acknowledged
archive and a passed main replay.

Run the deployed private workflow
`intar-dev/scenarios/.github/workflows/image-build-benchmark.yml` with these
cases:

- `no-cache-prepared` and `unchanged`: an externally prepared empty cache.
- `warm` and `runtime`: a forced full rebuild.
- `warm` and `late-step`: one fault edit.

For each comparable cohort, record three baseline samples and three candidate
samples. Keep the same scenario SHA and build resource profile within that
cohort. Do not combine results after a web identity change with older results.
Pause normal builder work. Include host preparation in each measured duration.
The baseline is a benchmark reference only; it is not a runtime backend.

Keep the JSON records from the workflow. Compare them with
`tools/image-build/benchmark-release.py compare`, with exactly three
`--baseline` records and three `--candidate` records, then retain its JSON
report. An observer run that resumes after recovery is preliminary. It has
observer provenance and cannot satisfy the benchmark gate.

Two isolated workers share an eight-slot CPU gate. Each QEMU provision or chunk
compression stage takes four slots. Upload work takes no CPU slots, so one build
can upload while the next build provisions.

Protect the config because the bootstrap token remains a credential used to mint
short-lived builder JWTs until it is rotated, revoked, or expires:

```bash
sudo chown root:root /etc/intar-builder/config.toml
sudo chmod 0600 /etc/intar-builder/config.toml
```

## systemd Service

Create `/etc/systemd/system/intar-builder.service`:

```ini
[Unit]
Description=Intar image builder
Requires=intar-buildkitd.service
After=network-online.target intar-buildkitd.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/intar-builder run --config /etc/intar-builder/config.toml
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now intar-builder
sudo systemctl status intar-builder
```

## Validation

Run the built-in preflight before starting the daemon:

```bash
sudo intar-builder doctor --config /etc/intar-builder/config.toml
```

The command exits nonzero if required image-build prerequisites are missing:
`/dev/kvm`, `accelerator = "kvm"`, the configured QEMU/e2fsprogs binaries,
QEMU 10 or later, `qemu-img`, `qemu-storage-daemon` with Unix NBD export,
`buildctl`, `umoci`, `zstd`, an immutable Debian digest, the BuildKit socket,
required work/cache/state directories, a nonzero raw-view read timeout, or
bridge credentials. Builder doctor covers the QEMU/SSH image-build path only;
it is not a substitute for agent doctor or the privileged jailerd self-test on
a scenario host.

Watch the logs:

```bash
sudo journalctl -u intar-builder -f
```

The host should appear connected in the admin Hosts page with role `builder`. After
a scenario bundle is uploaded, the Builds page should show queued builds moving to
that host when its reported architecture matches the bundle metadata.

Useful checks when builds do not start:

```bash
test -c /dev/kvm
qemu-system-x86_64 --version
qemu-img --version
/usr/bin/qemu-storage-daemon --version
buildctl --version
umoci --version
zstd --version
sudo systemctl status intar-buildkitd
mke2fs -V
modprobe --version
ssh -V
df -h /var/lib/intar-builder /var/cache/intar-builder
```

If the host is connected but builds stay unassigned, confirm the host role is
`builder`, it is not disabled, and its architecture matches the build row.
