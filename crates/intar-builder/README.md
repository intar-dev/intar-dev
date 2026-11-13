# intar-builder

Builds the machine images the Worker asks for and pushes them to the registry.
`intar-builder doctor --config /etc/intar-builder/config.toml` checks the host;
`deploy/config.example.toml` lists every setting.

## Wake images

An image with `wake = true` is published with its guest suspended, so a run
host can wake it instead of booting it. A machine `from` such an image is a
pack: its own setup runs in the woken base, and it is published as a RAM delta
on the base's RAM. A pack's machine may not use `packages`; it has no network.

```toml
[wake]
enabled = true
vmm_binary = "/usr/local/lib/intar-builder/cloud-hypervisor"
vmm_sha256 = "<sha256 of that binary>"
vmm_version = "v55.0.0"
cpu_profile = "/etc/intar-builder/cpu-profile.json"
kino = "/usr/local/lib/intar-builder/kino"
```

- `vmm_binary` is the static cloud-hypervisor the builder's release ships in
  `deploy/`; the build refuses a binary of another hash. `vmm_version` is what
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
builder). When any of these is missing, `doctor` warns and wake targets build
as plain images; each such build log says why.

A wake base is cached under `work_root/wake-bases`, keyed by the image's build
key and the profile's digest, so the packs of one image share one base.

A guest that must keep its address across wakes cannot use the run's address:
every run gets a new one. k3s, for example, should be pinned to a fixed node
address in the base image: a unit before k3s runs
`ip addr replace 10.255.255.1/32 dev <first NIC> scope host`, and the k3s
config sets `node-ip: 10.255.255.1`. In a pack instead, the k3s restart makes
the delta about 100 MB.
