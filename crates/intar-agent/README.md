# intar-agent

`intar-agent` is the unprivileged scenario-host reconciler. It prepares typed VM
resources and talks to the root-owned `intar-jailerd` supervisor over a local
`SOCK_SEQPACKET` socket. The agent does not spawn Cloud Hypervisor or mutate
host networking, namespaces, cgroups, or devices directly.

## Usage

```bash
cargo run -p intar-agent -- --config path/to/config.toml
```

Before enabling a deployed scenario host, run the preflight checker:

```sh
sudo -u intar-agent env \
  XDG_CACHE_HOME=/var/cache/intar-agent \
  XDG_STATE_HOME=/var/cache/intar-agent/state \
  /usr/local/bin/intar-agent --doctor --config /etc/intar-agent/config.toml
```

`--doctor` loads the normal config and exits without starting the HTTP service.
It is a read-only readiness gate for the unprivileged side: Linux x86_64 and
kernel baseline, required device presence, unified cgroup v2 with its CPU
controller, the jailerd socket, nftables, trusted cache/work roots, bridge
configuration, and the image registry. Run the installed command as the
configured agent identity so its XDG paths and jailerd peer credentials match
the service.

Doctor does not create a disposable systemd unit, cgroup, jail, or network
namespace. Before enabling a host, also run the distinct privileged proof:

```bash
sudo /usr/lib/intar/intar-jailerd-self-test
```

Both checks must pass. A failed jailerd handshake, runtime hash mismatch, or
missing hard-quota, seccomp, Landlock, cgroup-v2, namespace, or network support
keeps the host unschedulable; there is no direct-spawn fallback.

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

VM creation is expected to happen via desired-state commands from the control
plane. The agent allocates addresses from `[vm_defaults.network]` and sends the
complete topology in a typed jailerd request. Only jailerd creates the per-run
network namespace, bridge, TAPs, routes, and nftables rules.

`lease_duration_seconds` starts counting when the VM reaches `running`. After the timer expires, `intar-agent` will shut down/delete the VM and remove its record.

The runtime disk passes network settings, the hostname, and Kino vsock
configuration into the guest bootstrap path. Narrow ACLs let `intar-agent`
reach the jailed API/vsock/log paths that it needs without granting access to
the VM identity or the rest of the jail.

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

## Configuration

The config file is required and must be TOML.

Example config: `crates/intar-agent/deploy/config.example.toml`

```toml
[server]
bind = "127.0.0.1:8080"

[jailer]
socket = "/run/intar-jailerd/control.sock"
request_timeout_seconds = 10

[bridge]
enabled = false
base_url = "https://intar.dev"
host_id = "my-dedicated-host-1"
bootstrap_token = ""
heartbeat_interval_seconds = 30

[vm_defaults]
tap = "tap"
work_dir = "/var/cache/intar-agent"

[vm_defaults.resources]
# Fallback topology for local requests. Scenario manifests carry their own
# cpu_millis and vcpu_count values.
vcpus = 1
memory_mib = 512

[vm_defaults.network]
guest_cidr = "10.77.0.0/16"
dns = ["1.1.1.1", "8.8.8.8"]

[image_registry]
url = "https://intar.dev/agent/registry/images"
refresh_interval_minutes = 15
# Optional HTTP basic auth used for local/dev registries. Production agents use bridge JWT auth.
# username = ""
# password = ""
```

The image registry is expected to expose a JSON index at `url` with `image_key`,
`image_id`, `image_format = "raw_chunks_v1"`, the 4 MiB chunk manifest, virtual
size, exact guest-tools pin, boot artifact hashes, and immutable download URLs.
Desired-state changes wake the cache immediately; the 15-minute poll is only a
repair scan. The agent downloads up to 16 chunks concurrently, verifies encoded
objects, and passes the bounded manifest plus cache roots to jailerd. It does not
keep a full unprivileged raw-image cache. The pinned
Cloud Hypervisor v53.0 path and SHA-256 belong only in the root-owned
`/etc/intar-jailerd/config.toml`.

## Scenario CPU resources

Scenario HCL separates its aggregate CPU ceiling from guest topology:

```hcl
cpu = 0.125
# Optional; defaults to ceil(cpu), minimum 1.
vcpus = 1
```

`cpu` is exact fixed-point millicores: positive integer or decimal literals
with at most three fractional digits are accepted. Thus `0.125` becomes 125
millicores and `2` remains 2000 millicores. Zero, exponent notation, excess
precision, and values greater than `vcpus * 1000` millicores are rejected.
Catalog manifests use V4 (`cpu_millis`, `vcpu_count`) and the coordinated bridge
uses V6 with V2 desired-state/resource/report documents. No old-version shim is
provided. Jailerd capacity-accounts `max(2000m, steady_cpu_millis)` and applies
that aggregate VMM quota for at most 45 seconds without changing guest vCPU
topology, then a root-owned generation-bound guardian seals the VM to steady
CPU without exposing ingress. Separately, agent runtime readiness scales its
wall-clock timeout inversely from the steady CPU contract, capped at 360
seconds. A `cpu = 0.125` VM may therefore wait 360 seconds for Kino, but it uses
the 2000-millicore boot allocation only for the first 45 seconds and then runs
at 125 millicores. Later finalization requires an attested steady quota before
ingress can open. See
[Scenario Host Jailer](../../docs/src/content/docs/operations/scenario-host-jailer.md) for the privileged
configuration and drain-first host operations.
