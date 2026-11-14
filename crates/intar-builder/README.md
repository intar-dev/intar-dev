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
RAM; a pack is no delta to another image's. A pack's machine may not use
`packages`.

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
enough for its sockets. Nothing is kept there between builds: an image's
`wake.booted_at_unix_ms` is its own boot, and run hosts stop waking guests
booted 330 days ago, so an image that old must be rebuilt.

A guest that must keep its address across wakes cannot use the run's address:
every run gets a new one. k3s, for example, should be pinned to a fixed node
address in the base image: a unit before k3s runs
`ip addr replace 10.255.255.1/32 dev <first NIC> scope host`, and the k3s
config sets `node-ip: 10.255.255.1`.
