# intar-jailerd

`intar-jailerd` is the only part of a scenario host that runs as root. The
unprivileged [agent](../intar-agent) decides which machines a host runs;
jailerd is what creates their networks and starts them, each as a Cloud
Hypervisor VM in its own jail, and it does nothing else the agent asks for.

Three crates make up the boundary: `intar-jailerd` (the daemon),
`intar-jailer` (the one-shot program that sets up a jail and then runs the
VMM in it), and `intar-jailer-protocol` (the messages between the agent and
the daemon).

## The protocol

The agent speaks a versioned JSON protocol over an AF_UNIX `SOCK_SEQPACKET` socket;
the daemon authenticates the exact configured agent UID with `SO_PEERCRED`,
rejects unknown fields, and caps every packet at 64 KiB. The protocol exposes
typed capability, run-network, launch, inspect, stop, and destroy operations;
it accepts no arbitrary command, host path, cgroup file, or systemd property.

The shared core enforces exact millicore admission, trusted-source resolution,
exclusive jail staging, root-only handoff specs, and lifecycle reservation
semantics. The Linux backend creates the per-run network namespace and
per-generation transient systemd service through typed operations; it never
falls back to a raw root child process or invokes a shell.

## Configuration

The root-owned configuration lives at `/etc/intar-jailerd/config.toml`; start
from `deploy/config.example.toml`. It pins Cloud Hypervisor v54.1 at
`/usr/lib/intar/cloud-hypervisor-v54.1` with SHA-256
`f9ffb9646783233d1f0fb09e77db1fca66499d1041e63bc011b90683c0d49933`,
reserves 1000 host millicores by default, and allocates per-generation
identities from `200000..=265535`. Audit that range for local/directory identity
collisions before deployment.

The root-owned network policy reserves `10.77.0.0/16` for canonical per-run
`/28`s and `22000..=22999` for SSH DNAT by default. Keep the agent values in
sync; doctor compares them with jailerd's advertised effective policy. Jailerd
never replaces an unrelated host route and rejects SSH ports outside its range
or already reserved by any active/recovered VM.

## CPU limits

VM CPU declarations apply from startup to shutdown. Jailerd charges the
exact `cpu_millis` value before launch and sets the corresponding systemd CPU
quota. Cloud Hypervisor retains its own integer guest CPU count, derived from
the limit. No host core is reserved for a guest vCPU.

For 125 millicores the VM unit uses a fixed 100 ms period and must expose
`cpu.max = 12500 100000` with `cpu.max.burst = 0`. This hard ceiling covers the
whole VMM cgroup. CPU weight, affinity, and cpusets are not substitutes.

## SSH ingress

Public SSH ports are reserved at launch. DNAT remains absent until
`FinalizeVmBoot` verifies the declared quota and `cpu.max.burst = 0`, persists
the generation-bound proof, and activates ingress. The same cgroup quota
continues to apply if jailerd exits. A periodic recovery worker retries
unresolved cleanup and retains reservations until cgroup drain is proven.
Background image work uses a separate bounded 45-second boot window.

## Privileges

The daemon service keeps `CAP_SYS_PTRACE` only for strong cross-UID executable
identity checks against `/proc/<pid>/exe`. The privileged self-test and daemon
startup both reject a missing effective or bounding capability instead of
silently treating `EACCES` as a process race. VM units do not inherit it and
the VMM capability sets remain empty.

The one-shot `intar-jailer` performs namespace, pivot-root, procfs, rlimit,
credential, capability, `no_new_privs`, Landlock, and seccomp setup. Privileged
KVM integration tests must be run on the pinned production host baseline. The
package smoke test must boot the pinned runtime with only the explicitly
verified minimal device allowlist.

## Checking a host

Run the installed artifact-backed privileged proof and then doctor before
enabling scheduling. The wrapper downloads immutable publisher artifacts into
a root-only cache, builds fresh disk fixtures, safely freezes/restores socket
activation, and supplies their exact hashes to the binary:

```sh
sudo /usr/lib/intar/intar-jailerd-self-test
sudo -u intar-agent env \
  XDG_CACHE_HOME=/var/cache/intar-agent \
  XDG_STATE_HOME=/var/cache/intar-agent/state \
  /usr/local/bin/intar-agent --doctor --config /etc/intar-agent/config.toml
```

Doctor must run as the configured agent identity so its cache paths and
`SO_PEERCRED` identity match the service that will consume the result.

Agent doctor is read-only. The root-only self-test runs under the same
private-mount/filesystem sandbox as the installed service and uses an isolated
in-memory 1000-millicore authority. The daemon resolves each root-owned nsfs
handle through PID 1's root, while transient VM units prove the same inode at
the configured `/run/netns` path. The test then creates two
concurrent VMs on the pinned Cloud Hypervisor,
each with its own unit, cgroup, jail, identity, and TAP in one shared run
network namespace. It requires the third 500-millicore request to fail local
admission, proves every API/Landlock lifecycle and KVM task tree, measures both
busy cgroups during one 30-second window, and exhaustively removes them.
Only that complete artifact-backed run writes the boot-bound readiness
attestation.

For an offline host, pre-seed the two files listed in the wrapper/notices under
`/var/lib/intar/self-test-assets/downloads/`, then pass `--offline`. The
self-test boots through the same image path as the agent: it splits the fresh
root disk into 4 MiB chunks, skips the all-zero ones, zstd-encodes the rest and
writes a machine image (OCI manifest, machine config, kernel and chunk blobs,
each named by its SHA-256) into a blob cache inside its disposable jail
directory, then sends `PrepareChunkedImageV3` and `LaunchVmV3`. The production
`allowed_source_roots` remains agent-cache-only: the binary adds the fixture
root and that blob cache's root solely to its isolated in-memory self-test
configuration.

## The check at every boot

Every later boot re-runs the proof through `intar-jailerd-boot-check.service`,
which the installer enables: `intar-jailerd-self-test --boot` runs before
jailerd and the agent start, refuses if either is active, stops and restores
nothing, and uses only the cached assets (implying `--offline`). The socket may
already listen; an activation only queues jailerd behind the check. Only
`multi-user.target` pulls the check in, and jailerd is just ordered after it,
so later jailerd starts never re-run it. When the check fails, jailerd still
starts and contains the previous boot's VMs, but stays unschedulable: an
attestation of another boot counts as absent whatever else changed (a kernel
upgrade, a lagging clock), while a stale attestation of this boot is still a
startup error. A recovery whose unclean
records all belong to a known earlier boot, and were all fully contained,
keeps the readiness the boot check proved; every other unclean recovery
withdraws it. `journalctl -u intar-jailerd-boot-check.service` shows the
result. The installer disables (and keeps) a hand-written
`intar-platform-check.service`, since it would run the proof a second time.

## Storage

Fast-host readiness creates root-owned anonymous probes in the template store
and every configured source filesystem, then exact-reflinks each probe into the
root-owned generation store. One failed route withdraws v3 and fast-template
capability for the host; launch never degrades to copying.

The store GC removes every template directory that is not of the current
schema, unless a live VM was booted from it. `deploy/install.sh` drops the
retired `legacy_template_retention_seconds` key from an existing
`/etc/intar-jailerd/config.toml` (`deploy/migrate-epoch-config.py`), keeping
the previous file as `config.toml.pre-epoch`. It checks the config before it
stops anything, so a config the migration refuses leaves the host running.

## Installing and upgrading

Install or upgrade the package only while the agent is stopped and the host is
fully drained. The installer rejects live VM units, populated Intar cgroups,
and lingering VMM/helper processes, and leaves the agent stopped. Run the
privileged self-test and agent doctor before enabling scheduling.
