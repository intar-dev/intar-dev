# intar-agent

`intar-agent` is a small HTTP service that proxies Cloud Hypervisor operations (over the local unix socket) and launches scenario VMs via an Intar runtime disk.

## Usage

```bash
cargo run -p intar-agent -- --config path/to/config.toml
```

Then:

```bash
curl -fsS http://127.0.0.1:8080/ping
```

Optional: enable the Cloudflare bridge (`[bridge]` config section) to open an outbound websocket to the control plane and respond to heartbeat/ping commands.

List tracked VMs:

```bash
curl -fsS http://127.0.0.1:8080/vms
```

Get one VM:

```bash
curl -fsS http://127.0.0.1:8080/vms/demo-1
```

VM creation is expected to happen via control-plane commands (`vm.create_scenario`). Network settings are allocated by the agent from `[vm_defaults.network]`.
If the configured bridge does not exist, `intar-agent` will create it, assign the configured gateway/prefix, and bring it up automatically.

`lease_duration_seconds` starts counting when the VM reaches `running`. After the timer expires, `intar-agent` will shut down/delete the VM and remove its record.

The runtime disk passes the NetBird setup key, network settings, hostname, and Kino vsock configuration into the guest bootstrap path. `intar-agent` exposes a host-side Unix socket at `<work_dir>/vms/<vm>/kino.host.sock` that proxies to Kino.

Prune tracked VMs:

```bash
curl -fsS -X POST http://127.0.0.1:8080/vms/prune
```

## Lifecycle model

Tracked VMs now use an explicit monotonic local lifecycle:

- create path: `queued -> caching_image -> preparing_disks -> creating_vm -> booting_vm -> running`
- delete path: `running -> deleting_vm -> archiving_artifacts -> removed`
- failure states: `failed` for create/startup failures, `delete_failed` for teardown/archive failures

`vm.delete` is allowed to keep running after its deadline so cleanup and archive upload can finish, but the command timeout remains canonical. In other words:

- the command can end in `timed_out`
- archive begin/complete requests are the stable completion facts
- a late delete success does not rewrite the canonical command status

This is a clean break from the old local sqlite state model. If you still have persisted agent rows with legacy VM states, remove the agent sqlite db and let it rebuild.

## Configuration

The config file is required and must be TOML.

Example config: `crates/intar-agent/deploy/config.example.toml`

```toml
[server]
bind = "127.0.0.1:8080"

[cloud_hypervisor]
binary = "cloud-hypervisor"
spawn_timeout_seconds = 10

[bridge]
enabled = false
base_url = "https://intar.dev"
host_id = "my-dedicated-host-1"
bootstrap_token = ""
heartbeat_interval_seconds = 30

[tools]
qemu_img = "qemu-img"

[vm_defaults]
firmware = "cloudhv"
tap = "tap"
work_dir = "/var/cache/intar-agent"

[vm_defaults.resources]
vcpus = 1
memory_mib = 512

[vm_defaults.network]
guest_cidr = "10.77.0.0/16"
dns = ["1.1.1.1", "8.8.8.8"]

[image_registry]
url = "https://intar.dev/agent/registry/images"
refresh_interval_minutes = 15
# Optional HTTP basic auth used for the registry index and qcow2 image downloads.
# username = ""
# password = ""

[firmwares.cloudhv]
url = "https://github.com/cloud-hypervisor/edk2/releases/download/ch-a54f262b09/CLOUDHV.fd"
sha256 = "0624c06c5d07cb8efe38806890ce7076c41c0902f2fcd5b2376f107033e3222b"
```

The image registry is expected to expose a JSON index at `url` with `image_key`,
`image_sha256`, and `download_url` entries. `intar-agent` polls the registry
every `refresh_interval_minutes`, caches discovered `.qcow2` images, and rejects
missing or mismatched SHA-256 values.
