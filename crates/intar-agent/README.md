# intar-agent

The agent runs on a scenario host as an unprivileged user and makes the host
match what the control plane wants: it holds a WebSocket to the website (the
bridge), receives the host's desired state, pulls the machine images a run
needs, and asks `intar-jailerd` for the machines. It never starts Cloud
Hypervisor itself and never touches host networking, namespaces, cgroups or
devices; that is jailerd's job, over a local `SOCK_SEQPACKET` socket.

It runs on Linux x86_64 only. For installing it on a host, see
[`RELEASING.md`](../../RELEASING.md) (platform hosts) and
[`deploy/personal-metal`](../../deploy/personal-metal/README.md) (your own
server).

## Commands

```bash
intar-agent --config /etc/intar-agent/config.toml            # run the service
intar-agent --config /etc/intar-agent/config.toml --doctor   # check the host, then exit
intar-agent --config /etc/intar-agent/config.toml --status   # drain state and every tracked VM's phase
intar-agent --config /etc/intar-agent/config.toml --drain    # refuse new work; survives a restart
intar-agent --config /etc/intar-agent/config.toml --resume   # accept work again
```

The config file is required and is TOML.
[`deploy/config.example.toml`](deploy/config.example.toml) lists every section
with comments. `[bridge]` connects the agent to the control plane; with
`enabled = false` it only serves its local API.

## Checking a host before it takes work

Two checks must pass. Doctor covers the unprivileged side and changes nothing:
Linux x86_64 and the kernel baseline, the required devices, unified cgroup v2
with its CPU controller, the jailerd socket, nftables, the cache and work
roots, the bridge configuration, and the image registry. Run it as the agent's
own user, so its XDG paths and its identity on the jailerd socket are the
service's:

```sh
sudo -u intar-agent env \
  XDG_CACHE_HOME=/var/cache/intar-agent \
  XDG_STATE_HOME=/var/cache/intar-agent/state \
  /usr/local/bin/intar-agent --doctor --config /etc/intar-agent/config.toml
```

Doctor starts no unit, cgroup, jail or network namespace. The privileged proof
does, with real VMs:

```bash
sudo /usr/lib/intar/intar-jailerd-self-test
```

A failed jailerd handshake, a runtime hash mismatch, or missing hard-quota,
seccomp, Landlock, cgroup-v2, namespace or network support keeps the host
unschedulable. There is no direct-spawn fallback.

## Local API

The agent listens on `[server].bind`, `127.0.0.1:8080` in the example. It is
for the operator on the host; the control plane never calls it.

```bash
curl -fsS http://127.0.0.1:8080/ping
curl -fsS http://127.0.0.1:8080/status
curl -fsS http://127.0.0.1:8080/vms
curl -fsS http://127.0.0.1:8080/vms/demo-1
curl -fsS -X POST http://127.0.0.1:8080/vms/prune
curl -fsS -X DELETE http://127.0.0.1:8080/runs/<run-id>
```

## How a VM is made

VMs are created from the desired state, not through the local API. The agent
allocates addresses from `[vm_defaults.network]` and sends the complete
topology in one typed jailerd request. Only jailerd creates the per-run
network namespace, bridge, TAPs, routes and nftables rules.

The runtime disk passes the network settings, the hostname and Kino's vsock
configuration into the guest's bootstrap. Narrow ACLs let the agent reach the
jailed API, vsock and log paths it needs, without access to the VM's identity
or the rest of the jail.

A VM's lease starts counting when it reaches `running`. When it expires, the
agent shuts the VM down, deletes it and removes its record.

### Lifecycle

A tracked VM moves through these states and never backwards:

- create: `queued -> caching_image -> preparing_disks -> creating_vm -> booting_vm -> running`
- delete: `running -> deleting_vm -> archiving_artifacts -> removed`
- failure: `failed` for create and startup failures, `delete_failed` for
  teardown and archive failures

`vm.delete` may keep running past its deadline so cleanup and the archive
upload can finish, but the command's timeout stays canonical: the command can
end in `timed_out`, the archive begin and complete requests are the stable
completion facts, and a late delete success does not rewrite the command's
status.

### Images

The agent pulls images from the OCI `/v2` API at the origin of
`[image_registry].url` (its path is ignored), with the bridge's agent JWT. An
image is named by its manifest digest. The agent refuses a machine config of
another guest contract or image format, keeps the manifest, config, kernel,
initrd and disk chunks in a digest-addressed blob store, and passes them to
jailerd, which builds the template. It keeps no full raw image of its own.
Desired-state changes wake the cache immediately; the 15-minute poll is only a
repair scan.

The Cloud Hypervisor path and SHA-256 belong only in the root-owned
`/etc/intar-jailerd/config.toml`.

## Scenario CPU resources

A scenario gives each machine one CPU limit:

```hcl
cpu = 1        # one CPU, 1000 millicores
cpu = "500m"   # half a CPU
```

Intar keeps the limit in exact millicores (`cpu_millis`) and derives the
guest's CPU count as `ceil(cpu)`, at least one.

Jailerd applies one hard limit to the complete VMM process group before VM
boot. With a 100 ms period, `cpu = "500m"` gives `cpu.max = 50000 100000` and
`cpu.max.burst = 0`. The same limit applies until shutdown. There is no extra
boot CPU allocation. Two 500-millicore VMs reserve 1000 millicores, including
while both boot. Linux shares host CPU time; guest vCPU count does not reserve
host cores. A limit is a ceiling, not a minimum-service guarantee.

Jailerd retains the global 1000-millicore host reserve. Both local and control
plane admission charge the declared limit before launch and retain it until
VM removal is proven. Additional CPU overcommit is disabled. Production units
have no CPU pinning; Cloud Hypervisor retains per-VM core scheduling isolation.

The contracts with the control plane are in
[`crates/intar-contracts`](../intar-contracts) (the bridge is
`src/bridge_v9.rs`), and the jailer protocol is in
[`crates/intar-jailer-protocol`](../intar-jailer-protocol). A host on an older
bridge must be drained and upgraded before it is scheduled again.
