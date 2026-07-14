# Scenario Host Jailer

Scenario hosts use a privileged `intar-jailerd` supervisor and a one-shot
`intar-jailer`. `intar-agent` remains unprivileged: it reconciles desired state
and sends typed requests over `/run/intar-jailerd/control.sock`, but it neither
spawns Cloud Hypervisor nor creates TAPs, bridges, routes, nftables rules,
namespaces, or cgroups. Do not grant the agent `CAP_NET_ADMIN`, `CAP_NET_RAW`,
membership in `kvm` or `netdev`, or access to a host Cloud Hypervisor binary.

## Scenario CPU contract

Scenario HCL expresses an aggregate hard CPU ceiling separately from the guest
CPU topology:

```hcl
cpu = 0.125
# Optional. Defaults to ceil(cpu), with a minimum of one.
vcpus = 1
```

`cpu` is parsed as exact fixed-point millicores. A positive integer or ordinary
decimal literal with at most three fractional digits is accepted. Therefore
`0.125` is 125 millicores and the existing `cpu = 2` spelling is 2000
millicores. Zero, negative values, exponent notation, and more than three
fractional digits are rejected. `vcpus` must be positive and
`cpu_millis <= vcpus * 1000`.

The ceiling covers the complete VMM process tree. With the fixed 100 ms cgroup
period, 125 millicores maps to `cpu.max = 12500 100000` and
`cpu.max.burst = 0`; it is not represented with CPU weight, affinity, or a
cpuset. This is also an admission reservation, not a minimum-service guarantee.

Catalog manifests are V3 and carry `cpu_millis` plus `vcpu_count`. The
coordinated bridge is V6; its V2 desired-state, capacity, resource, and report
documents carry millicore totals and per-VM quota/accounting state. There is no
V2-catalog or V5-bridge compatibility shim.

## Root-owned runtime boundary

Install the scenario-host package before starting the agent. The privileged
configuration is `/etc/intar-jailerd/config.toml`; it must be a root-owned
regular file that is not writable by group or other. The checked-in example is
`crates/intar-jailerd/deploy/config.example.toml`.

The production defaults are:

- jail root: `/var/lib/intar/jails`
- agent socket: `/run/intar-jailerd/control.sock`
- runtime: `/usr/lib/intar/cloud-hypervisor-v53.0`
- runtime SHA-256: `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc`
- host CPU reserve: 1000 millicores
- VM UID/GID range: `200000..=265535`

Audit the UID/GID range against local and directory identities before enabling
the host. Changing it is an explicit operator override, not an automatic
collision workaround. With the default reserve, a one-CPU host advertises zero
schedulable millicores.

`intar-jailerd.socket` owns the `SOCK_SEQPACKET` endpoint. The daemon
authenticates the configured agent UID with `SO_PEERCRED`, rejects unknown
fields and packets larger than 64 KiB, and accepts only versioned typed
operations. Requests cannot inject commands, host paths, cgroup files, or
systemd properties.

The root supervisor retains `CAP_SYS_PTRACE` solely so it can open and hash
`/proc/<pid>/exe` after the VMM becomes a nondumpable process under its unique
UID. Startup fails closed when that capability is absent or cross-UID process
inspection is denied. The capability is never passed to the transient VM
unit: Cloud Hypervisor still has empty effective, permitted, inheritable,
ambient, and bounding capability sets.

Each launch receives a fresh systemd unit/cgroup, jail generation, UID/GID, and
root filesystem. The one-shot jailer enters the prepared run network namespace,
constructs the remaining namespaces and minimal root, drops every capability,
and execs the copied, hash-verified Cloud Hypervisor v53.0 runtime with seccomp
and Landlock enabled. The pinned v53.0 CLI cannot combine its `--landlock` flag
with Intar's API-only startup: [v53 classifies that flag as VM
configuration](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/cloud-hypervisor/src/main.rs#L327-L339),
which requires a kernel or firmware payload, and [a CLI payload makes v53
create and boot the VM
itself](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/cloud-hypervisor/src/main.rs#L757-L781).
Intar therefore omits the incompatible CLI flag. After
pivoting and dropping the VM identity and capabilities, `intar-jailer` installs
a hard-required Landlock ABI-v3 filesystem ruleset immediately before `exec`,
so every Cloud Hypervisor thread inherits the outer boundary. Intar still sends
`landlock_enable: true` in each typed `VmConfig`, adding v53's VM-specific path
rules on the VMM thread. Either layer failing is fatal; this is not a
reduced-isolation fallback. Only the explicitly verified minimal device set is
exposed, and a host is not eligible if the pinned runtime cannot pass that
package smoke test.

## Readiness gates

Run both checks before enabling scheduling:

```sh
sudo /usr/lib/intar/intar-jailerd-self-test
sudo -u intar-agent env \
  XDG_CACHE_HOME=/var/cache/intar-agent \
  XDG_STATE_HOME=/var/cache/intar-agent/state \
  /usr/local/bin/intar-agent --doctor --config /etc/intar-agent/config.toml
```

Agent doctor is deliberately read-only. It validates the unprivileged host view
and jailerd handshake, including the Linux/x86_64 baseline, kernel, device
presence, unified cgroup-v2 CPU controller, socket, nftables command, trusted
`nsenter` helper, working roots, bridge configuration, and registry
configuration. It does not
create a unit, cgroup, jail, or network namespace and therefore cannot prove
privileged isolation or cleanup. Run it as the configured agent identity so
the XDG paths and `SO_PEERCRED` identity match the deployed service.

The installed root-only wrapper is the operational proof. It downloads
hash-pinned boot fixtures directly from their publishers into a root-only
cache (or uses a pre-seeded cache with `--offline`), freezes socket activation,
and invokes the artifact-backed test in a transient service with the same
private-mount and filesystem hardening as `intar-jailerd.service`. The test
requires each named run namespace to be an nsfs mount with the same inode in
the daemon and PID-1 mount namespaces before a VM can launch. An isolated
in-memory jailerd authority
advertises exactly 1000 schedulable millicores without changing production
configuration. It boots eight concurrent 125-millicore v53.0 VMs in separate
units, cgroups, jails, identities, and TAPs under one run network namespace;
requires a ninth launch to return `cpu_capacity_exhausted`; proves
Landlock/seccomp and KVM task accounting for every VM; samples all eight busy
guests for 30 seconds; and exhaustively removes the VMs and network before
restoring the socket. A runtime hash mismatch, missing isolation feature,
incomplete accounting, admission mismatch, or cleanup failure is a hard
failure. Bare `intar-jailerd self-test` is diagnostic only and deliberately
cannot publish the readiness attestation.

## Breaking rollout

This cutover cannot adopt existing unsandboxed VMs:

1. Enter maintenance and disable scenario scheduling.
2. Drain every run, confirm desired state is absent, and confirm old units and
   processes have stopped before stopping the old agents.
3. On a host with V5 agent state, install the package with
   `sudo deploy/install.sh --breaking-v6-cutover`. The installer holds the
   maintenance lock, rejects live units/cgroups/processes, persisted VM rows,
   probes, archive jobs, desired builds, and any malformed or non-absent
   desired VM. Well-formed `desired_phase = "absent"` tombstones are safe
   drained deletion facts and may be archived. The installer then creates a
   root-only consistent config/SQLite archive under
   `/var/lib/intar/cutover-archives/`. It removes only the obsolete
   `cloud_hypervisor.binary` config key and resets the incompatible drained V5
   database. Without the explicit flag, legacy state is reported but never
   modified. Fresh and already-V6 hosts use `sudo deploy/install.sh`.
4. The same package publishes `intar-jailerd`, `intar-jailer`, the pinned v53.0
   runtime, checksums, notices, and systemd socket/service/slice definitions
   while the agent remains stopped.
5. Apply `0001_host_cpu_reservations.sql`, deploy the V6 Worker, and republish
   every scenario as a V3 catalog manifest.
6. Start only agents whose doctor and privileged self-test both pass.
7. Prove a real `cpu = 0.125` run and eight concurrent 125-millicore VMs per
   schedulable CPU before re-enabling starts.

Keep the host unschedulable on any hash, seccomp, Landlock, cgroup, accounting,
or helper failure. There is no reduced-isolation fallback.
