# intar-jailerd

`intar-jailerd` is the narrow root boundary for scenario VMs. The unprivileged
agent speaks a versioned JSON protocol over an AF_UNIX `SOCK_SEQPACKET` socket;
the daemon authenticates the exact configured agent UID with `SO_PEERCRED`,
rejects unknown fields, and caps every packet at 64 KiB. The protocol exposes
typed capability, run-network, launch, inspect, stop, and destroy operations;
it accepts no arbitrary command, host path, cgroup file, or systemd property.

The root-owned configuration lives at `/etc/intar-jailerd/config.toml`; start
from `deploy/config.example.toml`. It pins Cloud Hypervisor v53.0 at
`/usr/lib/intar/cloud-hypervisor-v53.0` with SHA-256
`448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc`,
reserves 1000 host millicores by default, and allocates per-generation
identities from `200000..=265535`. Audit that range for local/directory identity
collisions before deployment.

The root-owned network policy reserves `10.77.0.0/16` for canonical per-run
`/28`s and `22000..=22999` for SSH DNAT by default. Keep the agent values in
sync; doctor compares them with jailerd's advertised effective policy. Jailerd
never replaces an unrelated host route and rejects SSH ports outside its range
or already reserved by any active/recovered VM.

The shared core enforces exact millicore admission, trusted-source resolution,
exclusive jail staging, root-only handoff specs, and lifecycle reservation
semantics. The Linux backend creates the per-run network namespace and
per-generation transient systemd service through typed operations; it never
falls back to a raw root child process or invokes a shell.

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

For 125 millicores the VM unit uses a fixed 100 ms period and must expose
`cpu.max = 12500 100000` with `cpu.max.burst = 0`. This hard ceiling covers the
whole VMM cgroup. CPU weight, affinity, and cpusets are not substitutes.

Run the installed artifact-backed privileged proof and then doctor before
enabling scheduling. The wrapper downloads immutable publisher artifacts into
a root-only cache, builds fresh disk fixtures, safely freezes/restores socket
activation, and supplies their exact hashes to the binary:

```sh
sudo /usr/lib/intar/intar-jailerd-self-test
intar-agent --config /etc/intar-agent/config.toml --doctor
```

For an offline host, pre-seed the two files listed in the wrapper/notices under
`/var/lib/intar/self-test-assets/downloads/`, then pass `--offline`. The
production `allowed_source_roots` remains agent-cache-only: the binary adds the
fresh fixture root solely to its isolated in-memory self-test configuration.
Advanced/manual artifact flags remain available on `intar-jailerd self-test`,
but bare mode without artifacts is non-attesting diagnostics.

Agent doctor is read-only. The root-only self-test uses an isolated in-memory
1000-millicore authority to create eight concurrent Cloud Hypervisor v53 VMs,
each with its own unit, cgroup, jail, identity, and TAP in one shared run
network namespace. It requires the ninth 125-millicore request to fail local
admission, proves every API/Landlock lifecycle and KVM task tree, measures all
eight busy cgroups during one 30-second window, and exhaustively removes them.
Only that complete artifact-backed run writes the boot-bound readiness
attestation. Running `self-test` without artifacts is useful diagnostics, but
deliberately writes no attestation and cannot make a host schedulable.

This is a breaking rollout: drain all unsandboxed VMs and stop old agents,
then run `deploy/install.sh --breaking-v6-cutover` on V5 hosts. The explicit
mode refuses active or malformed workload state, permits only well-formed
absent VM tombstones, archives the legacy config and a consistent SQLite
snapshot under `/var/lib/intar/cutover-archives/`, removes only
`cloud_hypervisor.binary`, and resets the incompatible drained database.
Fresh or already-V6 hosts use `deploy/install.sh` without the flag. Next apply
the CPU-reservation D1 migration, deploy bridge V6, republish catalog V3
manifests, and start only hosts that pass both gates. The complete sequence and
exact HCL CPU semantics are in
[Scenario Host Jailer](../../docs/scenario-host-jailer.md).
