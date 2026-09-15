---
title: Scenario Host Jailer
---

Scenario hosts use a privileged `intar-jailerd` supervisor and a one-shot
`intar-jailer`. `intar-agent` remains unprivileged: it reconciles desired state
and sends typed requests over `/run/intar-jailerd/control.sock`, but it neither
spawns Cloud Hypervisor nor creates TAPs, bridges, routes, nftables rules,
namespaces, or cgroups. Do not grant the agent `CAP_NET_ADMIN`, `CAP_NET_RAW`,
membership in `kvm` or `netdev`, or access to a host Cloud Hypervisor binary.

## Scenario CPU contract

Scenario authors set one CPU-time limit:

```hcl
cpu = 0.5
```

`cpu` uses exact fixed-point millicores. Positive integer or ordinary decimal
literals with up to three fractional digits are accepted; `0.5` means 500
millicores. The former `vcpus` setting is rejected. Intar derives the guest CPU
count as `ceil(cpu)`, with a minimum of one. For limits up to one CPU, the
Cloud Hypervisor API configuration omits `cpus` and uses its one-vCPU default.
Larger limits set the derived guest CPU count internally.

Jailerd applies one hard limit to the complete VMM process group before VM
boot. With a 100 ms period, `cpu = 0.5` gives `cpu.max = 50000 100000` and
`cpu.max.burst = 0`. The same limit applies until shutdown. There is no extra
boot CPU allocation. Two 500-millicore VMs reserve 1000 millicores, including
while both boot. Linux shares host CPU time; guest vCPU count does not reserve
host cores. A limit is a ceiling, not a minimum-service guarantee.

Jailerd retains the global 1000-millicore host reserve. Both local and control
plane admission charge the declared limit before launch and retain it until
VM removal is proven. Additional CPU overcommit is disabled. Production units
have no CPU pinning; Cloud Hypervisor retains per-VM core scheduling isolation.

Catalog manifests are V5 and carry `cpu_millis`. The bridge envelope is V8;
desired-state, host-state-report, and VM-report schemas are V5, V6, and V5.
VM resource objects are V3 and runtime quota evidence is V2. The local jailer
protocol is V4. Older hosts must be drained and upgraded before scheduling.

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

Background prewarm imports each raw root image, kernel, initrd, pinned VMM,
jailer, and blank recording disk into a root-owned, content-addressed template
store on the jail filesystem. Host readiness proves exact template-to-generation
reflinks; a performance-ready host never copies and syncs the 4 GiB root image
on launch. Immutable template identity is verified during preparation and
rechecked by inode and digest-bound descriptors at v2 launch. A missing or
malformed ready marker fails closed and makes that image ineligible.

Each launch receives a fresh systemd unit/cgroup, jail generation, UID/GID, and
root filesystem. The one-shot jailer enters the prepared run network namespace,
constructs the remaining namespaces and minimal root, drops every capability,
and execs the reflinked, hash-verified Cloud Hypervisor v53.0 runtime with seccomp
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

Image preparation and VM launch remain separate typed operations. A launch
reserves its SSH port but installs no external DNAT. The cgroup has the declared
CPU limit before the VMM starts, and jailerd reads back the quota before it
returns the launch result. Kino readiness triggers generation-fenced
`FinalizeVmBoot`: jailerd verifies `cpu.max` and zero burst credit again,
persists the proof, and then activates DNAT. The agent verifies the Kino SSH
host key and TCP/22 before publishing terminal readiness. Failed verification
contains the VM and keeps ingress closed.

The cgroup continues to enforce the same quota if jailerd exits. The daemon's
recovery worker retries unresolved cleanup independently. Background image
preparation pauses during a separate bounded 45-second boot window, which
closes early when the VM becomes ready or its launch fails.

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
requires the daemon to resolve each root-owned nsfs handle through PID 1's
root, while transient VM units prove the same inode at the configured
`/run/netns` path before launch. An isolated
in-memory jailerd authority
advertises exactly 1000 schedulable millicores without changing production
configuration. It boots two concurrent 500-millicore v53.0 VMs on one shared host CPU in separate
units, cgroups, jails, identities, and TAPs under one run network namespace;
requires a third launch to return `cpu_capacity_exhausted`; proves
Landlock/seccomp and KVM task accounting for every VM; samples both busy
guests for 30 seconds; and exhaustively removes the VMs and network before
restoring the socket. A runtime hash mismatch, missing isolation feature,
incomplete accounting, admission mismatch, or cleanup failure is a hard
failure. Only the complete artifact-backed run writes the readiness
attestation.

## Install and upgrade

The installer requires Python 3.11 or newer. After drain checks, it removes
the obsolete jailerd boot-CPU settings and converts the agent fallback from
`vcpus` to `cpu_millis`. It preserves other values and saves root-only copies
in `/var/lib/intar/config-backups/cpu-v4-*` before replacing configuration.

1. Disable scenario scheduling for the host and drain every run. Confirm desired
   state contains no non-absent VM, actual state contains no VM, and artifact
   archival and teardown have completed.
2. Stop `intar-agent`. Keep the host disabled while the package is changing.
3. Run `sudo deploy/install.sh`. The installer holds the maintenance lock,
   rejects live VM units, populated Intar cgroups, and lingering VMM/helper
   processes, publishes the pinned runtime and systemd definitions, and leaves
   the agent stopped.
4. Run the root-only self-test and the agent doctor. Require the exact
   startup CPU limit, shared-CPU proof, generation-fenced quota verification, template-backed
   launch, every source-to-jail reflink path, and each required image in
   `Ready` state.
5. Start the agent, confirm its desired and actual revisions converge, then
   re-enable scheduling.

Keep the host unschedulable on any hash, seccomp, Landlock, cgroup, accounting,
template, or helper failure. Preserve current state and capacity accounting
while preparing a forward fix; never enable a reduced-isolation,
copy-based, or direct-spawn launch path.

The `intar-agent 0.12.11` package includes the jailerd traversal ACL fix from
[PR 160](https://github.com/intar-dev/intar-dev/pull/160).
When image preparation validates an existing shared lifecycle directory,
jailerd preserves the agent traversal ACL. It still rejects writable lifecycle
directories and does not grant broad directory access.
