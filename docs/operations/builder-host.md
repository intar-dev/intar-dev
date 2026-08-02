# Builder Host Onboarding

`intar-builder` runs on a dedicated Linux VM and receives image build assignments
from the control plane over the bridge. Builder hosts are separate from scenario
agent hosts; they do not run user scenarios.

## Host Requirements

- Ubuntu 24.04 or Debian 12/13 on x86_64.
- KVM enabled and visible as `/dev/kvm`.
- 8 vCPU, 16 GiB RAM, and at least 100 GiB disk for working directories and caches.
- Outbound HTTPS access to `intar.dev`, GitHub release downloads, and Debian package
  mirrors.

Install the runtime packages:

```bash
sudo apt-get update
sudo apt-get install -y \
  ca-certificates \
  curl \
  e2fsprogs \
  kmod \
  mmdebstrap \
  openssh-client \
  qemu-system-x86 \
  zstd
```

Verify KVM before installing the daemon:

```bash
test -c /dev/kvm
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
the target version, then install it. The builder downloads the pinned `kino`
release from `content/scenarios/build-tools.hcl` into its cache before each build assignment,
verifying the release checksum before use.

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
kino_release_base_url = "https://github.com/intar-dev/intar-dev/releases/download"

[qemu]
qemu_binary = "qemu-system-x86_64"
mmdebstrap_binary = "mmdebstrap"
mke2fs_binary = "mke2fs"
e2fsck_binary = "e2fsck"
resize2fs_binary = "resize2fs"
ssh_wait_timeout_seconds = 1200
provision_timeout_seconds = 2400
qemu_exit_timeout_seconds = 300
accelerator = "kvm"
build_cpus = 4
build_memory_mb = 4096

[jobs]
max_attempts = 3
max_concurrent_builds = 1
```

The same template is checked into
`crates/intar-builder/deploy/config.example.toml`.

`max_concurrent_builds` must remain `1` in this release. Multiple builder hosts
are supported by creating additional hosts; per-host parallel builds need separate
workspace/cache locking before they are safe.

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
After=network-online.target
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
`/dev/kvm`, `accelerator = "kvm"`, the configured QEMU/mmdebstrap/e2fsprogs
binaries, required work/cache/state directories, bridge credentials, or the
single-worker limit. Builder doctor covers the QEMU/SSH image-build path only;
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
mmdebstrap --version
mke2fs -V
modprobe --version
ssh -V
df -h /var/lib/intar-builder /var/cache/intar-builder
```

If the host is connected but builds stay unassigned, confirm the host role is
`builder`, it is not disabled, and its architecture matches the build row.

For local development or an air-gapped builder, set `builder.kino_binary` to a
preinstalled binary path. When that override is present, the daemon skips release
download and uses the configured file with the pinned version recorded in the
build metadata.
