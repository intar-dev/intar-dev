# intar-builder

Builds the machine images the Worker asks for and pushes them to the registry.
`intar-builder doctor --config /etc/intar-builder/config.toml` checks the host;
`deploy/config.example.toml` lists every setting.

## Wake images

An image with `wake = true`, and every machine `from` one (a pack), is
published with its guest suspended, so a run host can wake it instead of
booting it. Each is built as a plain image is: its whole setup runs in the
QEMU build VM and the disk is finalized. The builder then cold-boots that disk
in cloud-hypervisor the way a run host boots it (same kernel, initrd, command
line, devices, memory layout and CPU profile), waits for Kino's READY and a
quiet guest, and suspends it. So setup that takes effect only at boot (a unit
it disabled, an fstab, a service reading its config at start) has taken
effect in the suspended guest, as on a cold boot. The image carries its whole
RAM; a pack is no delta to another image's.

```toml
[wake]
enabled = true
vmm_binary = "/usr/local/lib/intar-builder/cloud-hypervisor"
vmm_sha256 = "<sha256 of that binary>"
vmm_version = "v55.0.0"
cpu_profile = "/etc/intar-builder/cpu-profile.json"
kino = "/usr/local/lib/intar-builder/kino"
```

- `vmm_binary` is the static cloud-hypervisor the builder's release ships at
  its archive root (`cloud-hypervisor-v55.0.0`, its SHA-256 in `deploy/`), as
  the agent's does; the build refuses a binary of another hash. `vmm_version` is what
  the image records as built with.
- `cpu_profile` is the CPU profile every wake image is suspended under. Its
  digest is the image's `wake.cpu_profile`, which a run host must pin to wake
  it. The build key does not include it, so images built before a change
  keep the old digest until they are rebuilt.
- `kino` is the guest Kino the build VM reports READY with.

The builder runs the VMM unprivileged: it re-runs itself under
`unshare --user --map-root-user --net`, creates the build VM's TAP (no
uplink) in that namespace and talks to the guest over SSH and vsock. The host
needs `/dev/kvm` and `/dev/net/tun` usable by the builder's user, `unshare`,
and unprivileged user namespaces (on Ubuntu,
`kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile for the
builder). When any of these is missing, `doctor` warns and every wake target
fails with the reason until it is fixed; plain targets still build. With
`enabled = false`, wake targets build as plain images and their logs say so.

The VMM runs in a directory under `cache_root/wake`, whose path is short
enough for its sockets. Nothing is kept there between builds; the builder
empties it, and removes the suspended-base cache of earlier releases
(`cache_root/wake-bases`), when it starts. A wake image's
`wake.booted_at_unix_ms` is its own boot, and run hosts stop waking guests
booted 330 days ago, so an image that old must be rebuilt.

A woken guest starts with the image's machine id. Before SSH is up, Kino
gives the run its own, as it gives it its own host key: it writes
`/etc/machine-id` in place (and `/var/lib/dbus/machine-id` when that is a
file), restarts journald and, when it runs, hostnamed, and removes every other
id's volatile journal (a woken guest's file is empty, so the old id is known
only by its journal). The id is 128 bits of the guest's RNG, which the kernel
reseeds on the resume, hashed with the run's `boot.json` digest. So from the
learner's first login the file, the journal's `_MACHINE_ID` and `hostnamectl`
show the run's id. A cold boot keeps the id systemd generates.

PID 1 takes the id by re-executing, which costs 1 to 3 s right after a wake,
so it runs after `SSH_READY`, in the background. Until it is done, PID 1's
`%m` and its own `GetMachineId` are still the image's, and a learner's
`systemctl` fails instead of waiting: the old manager closes its private
socket and the new one binds it again, so a call in between is refused. The
lab release, and with it every ready script and task check, waits for the
re-exec; one that fails or runs past 30 s fails the lab
(`machine_id_reexec_done` in the report's timings when it finishes).

Anything else that read the id before the suspend keeps the image's until it
restarts. That includes the system bus (its own `GetMachineId` answer; a bus
restart is unsupported), logind, networkd (its DHCPv6 DUID) and whatever the
image already runs at the suspend, the `defer` units among them, since the
build's lab release starts them. A service that must see the run's id has to
read it again or be restarted by the scenario. The kernel's `boot_id` is the
build boot's in every run woken from one image; the kernel sets it once per
boot and offers no way to change it.

A guest that must keep its address across wakes cannot use the run's address:
every run gets a new one. k3s, for example, should be pinned to a fixed node
address in the base image: a unit before k3s runs
`ip addr replace 10.255.255.1/32 dev <first NIC> scope host`, and the k3s
config sets `node-ip: 10.255.255.1`.
