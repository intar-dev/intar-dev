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
buildctl_binary = "buildctl"
umoci_binary = "umoci"
debian_image = "docker.io/library/debian@sha256:abc9cb88a5587630d7f915f47b23b0668fe250fbfc6457aa4d52b534c1bbf73f"
oci_cache_root = "/var/cache/intar-builder/oci"
checkpoint_cache_root = "/var/cache/intar-builder/checkpoints"
use_cache = true
oci_cache_bytes = 8589934592
checkpoint_cache_bytes = 42949672960
minimum_free_bytes = 21474836480

[jobs]
max_attempts = 3
max_concurrent_builds = 2
```

The same template is checked into
`crates/intar-builder/deploy/config.example.toml`.

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

BuildKit must listen at `<oci_cache_root>/buildkitd.sock`. With the default
cache root and OCI budget, create this systemd unit:

```ini
[Unit]
Description=Intar layered-build BuildKit daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=buildkitd --addr unix:///var/cache/intar-builder/oci/buildkitd.sock --root /var/cache/intar-builder/oci/buildkitd --oci-worker-gc --oci-worker-gc-keepstorage 0,21475,6442 --oci-max-parallelism 2
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
```

Save it as `/etc/systemd/system/intar-buildkitd.service`, then run:

```bash
sudo install -d -m 0755 /var/cache/intar-builder/oci
sudo systemctl daemon-reload
sudo systemctl enable --now intar-buildkitd
```

`--oci-worker-gc-keepstorage` uses decimal MB in this order:
reserved space, free-space target, maximum worker use. `0,21475,6442` keeps
the free-space target above 20 GiB and caps the daemon below 6 GiB. The
remaining 2 GiB of the 8 GiB OCI budget holds converted ext4 artifacts.
The decimal 6,442 MB cap plus 2 GiB stays below the 8 GiB total budget.
`--oci-max-parallelism 2` matches the two permitted OCI build steps. Change
all three values together when `oci_cache_bytes` changes.

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
`backend`, `qemuargs`, and `base_cache_root` before restart.

### Benchmark gate

The warm full-catalog median must be at least 2x faster. A cold run must not
exceed the baseline by more than 20%. Neither gate is measured yet. Do not
report either gate as passed.

The 0.9.1 cold median was `1,804,927 ms`, compared with a `1,265,784 ms`
baseline. It failed the cold limit. Measure a new final candidate before any
performance claim.

Run the deployed private workflow
`intar-dev/scenarios/.github/workflows/image-build-benchmark.yml` with these
cases:

- `no-cache-prepared` and `unchanged`: an externally prepared empty cache.
- `warm` and `runtime`: a forced full rebuild.
- `warm` and `late-step`: one fault edit.

For every case, record three baseline samples and three candidate samples. Use
the same exact scenario SHA and build resource profile. Pause normal builder
work. Include host preparation in each measured duration. The baseline is a
benchmark reference only; it is not a runtime backend.

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
