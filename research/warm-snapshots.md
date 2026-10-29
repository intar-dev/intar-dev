# Warm snapshots: can a run restore a formed cluster instead of cold-booting it?

Research for [#279](https://github.com/intar-dev/intar-dev/issues/279), part of the
[Talos cluster scenarios map (#267)](https://github.com/intar-dev/intar-dev/issues/267).
Read on 2026-10-29. Every claim links to the primary source it comes from. Text marked
**Inference** goes beyond what the source says. **Silent** means the sources read say
nothing on the point. **Measured** means the 2026-10-29 spike on an Intar platform host,
summarised below; nothing was run for this document.

## Versions read

- **Cloud Hypervisor v53.0**, the version Intar pins (`CLOUD_HYPERVISOR_VERSION` in
  `crates/intar-jailer-protocol/src/lib.rs` L53). Links are pinned to tag `v53.0`
  (commit `9ed824d6`).
- **Linux v6.18** mainline. Talos v1.14.5 builds kernel 6.18.58 from `siderolabs/pkgs`
  `f4bda77bb9f8` ("feat: update Linux to 6.18.58"; pinned as `PKGS ?= v1.14.0-48-gf4bda77`
  in [Talos `Makefile`](https://github.com/siderolabs/talos/blob/v1.14.5/Makefile#L31)).
  The stable patches between 6.18 and 6.18.58 were not read.
- **Talos kernel config**: [`kernel/build/config-amd64` at `f4bda77`](https://github.com/siderolabs/pkgs/blob/f4bda77bb9f8202cac8443a7284ce1c7aa129f38/kernel/build/config-amd64).
- **Talos v1.14.5** and **client-go v0.37.1** (Talos v1.14.5 defaults to Kubernetes 1.37.1,
  [`constants.go#L381`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/constants/constants.go#L381)).
- **Firecracker v1.17.0** snapshot docs, **as a comparison only**. Firecracker is not a
  candidate VMM here; its docs are the most explicit primary write-up of clone hazards.
- **Intar** at `origin/main` `11e43cb0`. Intar paths below are repo-relative with line numbers
  at that commit.

## Verdicts

| Question | Verdict | Why, in one line |
| --- | --- | --- |
| Portability across hosts | **Feasible only within a CPU class** | v53.0 restores with the snapshot host's own CPUID and TSC rate, refuses a host missing any checked feature bit, and offers no CPU model but `host`. |
| Portability across Cloud Hypervisor releases | **Not feasible across majors** | "Snapshot/restore support is not compatible across `MAJOR` versions"; within a major the docs are silent. |
| Many runs from one snapshot on one host | **Feasible, with Intar changes** | `vm.restore` overrides only `net_fds`; the guest MAC and vsock CID are frozen device state, so jailerd's host-wide uniqueness checks must become per-run. Paths already line up because every jail uses the same in-jail paths. |
| Lazy restore and prefault | **Exists, but it does not save memory** | `memory_restore_mode=ondemand` (userfaultfd) and `prefault` exist; on-demand restore still prefaults every page in the background. |
| Host memory per restore | **About 2x guest RAM, transiently** | The copy path reads the memory file through the page cache into anonymous memory; the measured 4.1 GiB fits that. No shared, copy-on-write mapping exists in v53.0. |
| Artifact size and compressibility | **Size known, compressibility unknown** | The memory file is dense and equals guest RAM for Intar's anonymous memory; restore honours file holes; compressibility needs a measurement. |
| Clock after restore | **Works for short gaps; long gaps unknown** | kvmclock is advanced to wall time but vCPU TSCs are not; the guest wall clock lags until PTP steps it (measured: 10 min corrected at once). |
| RNG and uniqueness | **Not solved by the VMM** | Cloud Hypervisor has no VM Generation ID device. The Talos kernel has the driver as a module, unused. The kernel CRNG stays identical across clones until its next reseed (60 s interval). |
| Kubernetes leases and etcd | **Unknown, likely fine** | client-go leader election judges leases by its own observation time, not the stored wall time. etcd was not read. |
| Who takes the snapshot | **Needs a new Cloud Hypervisor stage** | Cloud Hypervisor reads only its own snapshot directory. The QEMU builder cannot produce one. |

## Measured on 2026-10-29

Given for context, not re-run: Cloud Hypervisor v53.0, Talos v1.14.5, 3 control-plane nodes at
2 vCPU / 2048 MiB, direct kernel boot, one virtio-net tap and one raw disk per VM,
`--seccomp true`, each VM in a systemd unit with `CPUQuota=200%`.

- Pausing all three nodes, then `vm.snapshot` with `destination_url=file://...`, wrote
  `config.json`, `memory-ranges` (2 GiB) and `state.json` (about 62 KB) per VM.
- `--restore source_url=file://...` came up paused in 2.2 s from a cold page cache. After
  `vm.resume`, kube-apiserver answered 0.3 s later. A cold boot takes 45 to 51 s
  ([#270](https://github.com/intar-dev/intar-dev/issues/270)).
- Each restored VM's cgroup `memory.current` was about 4.1 GiB, against about 1.5 GiB cold-booted.
- Restores used the same host, tap names, MACs and disk paths as the snapshot.
- Talos time sync over PTP (`TimeSyncConfig` with `/dev/ptp_kvm`) corrected a 10-minute
  clock gap at once.

## 1. Portability

**Answer.** A snapshot restores only on a host whose CPU offers every feature bit the
snapshot host offered, across a fixed list of CPUID leaves. Cloud Hypervisor v53.0 has no
CPU model to restrict the guest to a baseline. A guest also keeps the snapshot host's TSC
frequency, which a host with a different rate must scale. Snapshots never cross a Cloud
Hypervisor major release. Intar's platform, organization and personal hosts differ, so one
build-time snapshot cannot serve every host. Fall back to a cold boot when restore fails, or
keep snapshots per CPU class or per host.

### What Cloud Hypervisor checks on restore

- **Restore needs a fresh VMM.** `vm_restore` fails with `VmAlreadyCreated` when a VM
  config already exists
  ([`vmm/src/lib.rs#L2338-L2345`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2338-L2345)).
  `docs/api.md` lists the prerequisite as "The VM is created but not booted"
  ([`docs/api.md#L86`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/api.md?plain=1#L86)).
  The code wins: restore replaces `vm.create`, it does not follow it.
- **It parses both JSON files with serde. Neither carries a version.** `recv_vm_config` and
  `recv_vm_state` read `config.json` and `state.json` and deserialise them
  ([`vmm/src/migration/mod.rs#L53-L91`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/migration/mod.rs#L53-L91)).
  `Snapshot` is a tree of component snapshots with no version field
  ([`vm-migration/src/lib.rs#L174-L181`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vm-migration/src/lib.rs#L174-L181)).
  The versioned migration protocol is separate: "Migration protocol versioning is separate
  from snapshot state compatibility" and that compatibility "is Cloud Hypervisor version
  dependent"
  ([`docs/live_migration.md#L416-L420`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/live_migration.md?plain=1#L416-L420)).
- **It validates the restore options.** `ondemand` with `prefault` is rejected. Every
  FD-backed net device needs matching `net_fds`
  ([`vmm/src/config.rs#L2882-L2927`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/config.rs#L2882-L2927)).
- **It checks CPUID compatibility (KVM, x86_64).** Before building the VM, restore calls
  `vm_check_cpuid_compatibility` with the snapshot's `common_cpuid`
  ([`vmm/src/lib.rs#L1914-L1918`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L1914-L1918)).
  That function generates the destination host's CPUID from the snapshot's CPU settings and
  compares the two
  ([`vmm/src/lib.rs#L1853-L1898`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L1853-L1898)).
  The compared registers are
  ([`arch/src/x86_64/mod.rs#L381-L495`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/arch/src/x86_64/mod.rs#L381-L495)):
  - leaf 0x1 ECX/EDX, leaf 0x7.0 EBX/ECX/EDX, leaf 0x7.1 EAX, leaf 0x8000_0001 ECX/EDX and
    the KVM feature leaf 0x4000_0001: the snapshot's bits must be a subset of the host's;
  - leaf 0x7.0 EAX and 0x4000_0000 EAX (highest subleaf or leaf): not greater than the host's;
  - the KVM signature in 0x4000_0000 EBX/ECX/EDX: equal.

  Any mismatch logs "Detected incompatible CPUID entry" and fails the restore
  ([`arch/src/x86_64/mod.rs#L530-L599`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/arch/src/x86_64/mod.rs#L530-L599)).
- **No CPU model exists to lower the floor.** `CpuProfile` "is a mechanism for ensuring live
  migration compatibility between hosts with potentially different CPU models", but its only
  variant is `Host`. `Host` returns the host CPUID unchanged, with a TODO to add
  profiles later
  ([`arch/src/x86_64/cpu_profile/mod.rs#L20-L66`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/arch/src/x86_64/cpu_profile/mod.rs#L20-L66)).
  The guest also sees the host's CPU brand string
  ([`arch/src/x86_64/mod.rs#L649-L662`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/arch/src/x86_64/mod.rs#L649-L662)).
- **The snapshot's own CPUID and TSC rate are applied, not the destination's.** Each vCPU's
  saved state holds `cpuid`, `msrs`, `xsave` and `tsc_khz`
  ([`hypervisor/src/kvm/x86_64/mod.rs#L73-L90`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/x86_64/mod.rs#L73-L90)).
  `set_state` writes them back with `set_cpuid2(&state.cpuid)` and `set_tsc_khz(freq)`
  ([`hypervisor/src/kvm/mod.rs#L3304-L3367`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L3304-L3367)).
  An MSR the host rejects is skipped with a warning
  ([`L3332-L3360`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L3332-L3360)).
  A `KVM_SET_TSC_KHZ` error fails the restore unless it is `EIO`
  ([`L3571-L3585`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L3571-L3585)).
- **What KVM does with a foreign TSC rate.** Within ±250 ppm of the host rate, nothing.
  Otherwise KVM scales the TSC when the CPU supports TSC scaling. Without scaling, it
  falls back to a "catch-up" mode when the requested rate is higher than the host's and
  fails with "user requested TSC rate below hardware speed" when it is lower
  ([`arch/x86/kvm/x86.c#L166`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kvm/x86.c#L166),
  [`L2516-L2584`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kvm/x86.c#L2516-L2584)).
  In catch-up mode KVM refuses the PTP clock pairing hypercall
  ([`L10185-L10201`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kvm/x86.c#L10185-L10201)),
  so `/dev/ptp_kvm` stops working (see section 4).

### What it does not check

Silent or absent in v53.0: no check of the host kernel version, Cloud Hypervisor version,
microcode, or CPU brand. No check of the leaves outside the list above, among them
0x8000_0008 (physical address bits) and 0xD (XSAVE layout). **Inference:** a restore that
passes the CPUID check can still fail inside KVM, for example on `KVM_SET_XSAVE` with a larger
saved XSAVE area, or behave differently when the host has fewer physical address bits. Setting
`cpus.max_phys_bits` to the fleet minimum at snapshot time would remove one of those
variables. That needs testing.

### Across Cloud Hypervisor releases

- "Snapshot/restore support is not compatible across `MAJOR` versions"
  ([`docs/releases.md#L77-L80`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/releases.md?plain=1#L77-L80)).
  A major release ships about every 6 weeks and gets fixes for about 12 weeks
  ([`L55-L60`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/releases.md?plain=1#L55-L60)).
- Within a major (v53.0 to v53.x): silent.
- **Inference:** a warm snapshot is bound to the fleet's Cloud Hypervisor major. Every pin bump
  in `intar-jailer-protocol` invalidates every warm snapshot, so either all cluster builds
  are rebuilt at the bump, or runs fall back to cold boots until they are.

### Comparison: Firecracker

Firecracker states the stricter rule outright: "Snapshots must be resumed on an software and
hardware configuration which is identical to what they were generated on". It only reports
some instance types restoring from host kernel 5.10 to 6.1, "but not vice versa"
([`snapshot-support.md#L691-L708`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/snapshot-support.md?plain=1#L691-L708)).
Cloud Hypervisor's docs make no equivalent statement.

## 2. Many runs from one snapshot on one host

**Answer.** The VMM side works: restore only reads the snapshot files, so many restores can
share one snapshot. Every path in `config.json` is an in-jail path that is identical in every
Intar jail. The blockers are Intar's own identity rules. The guest MAC and the vsock CID are
frozen in the snapshot. Jailerd refuses a second VM anywhere on the host with the same tap
name, MAC or CID. The agent also draws a fresh random MAC, tap name and CID for every launch.

### What `vm.restore` can override in v53.0

`RestoreConfig` has exactly five fields: `source_url`, `prefault`, `memory_restore_mode`,
`net_fds` and `resume`
([`vmm/src/config.rs#L2805-L2827`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/config.rs#L2805-L2827)).
The OpenAPI schema lists only four; it omits `net_fds`
([`cloud-hypervisor.yaml#L1490-L1502`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/api/openapi/cloud-hypervisor.yaml#L1490-L1502)).
The HTTP handler still accepts `net_fds` and attaches file descriptors sent with
`SCM_RIGHTS`
([`http_endpoint.rs#L551-L575`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/api/http/http_endpoint.rs#L551-L575)).

- `net_fds` replaces the FDs only of net devices that were created with FDs. Restore
  updates a device "only if the net dev is backed by FDs"
  ([`vmm/src/lib.rs#L2361-L2374`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2361-L2374);
  [`docs/snapshot_restore.md#L130-L143`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L130-L143)).
  Intar creates its NIC from a tap name (`NetConfig { tap, mac, .. }`,
  `crates/intar-agent/src/vm/manager/launch.rs` L104-L109), so `net_fds` does not apply today.
- Nothing else is overridable through the API: disk paths, tap names, MACs, serial and
  console files, vsock socket and CID, kernel and initramfs paths all come from the snapshot.

### What comes from `config.json` and what from `state.json`

- **`config.json` is the editable half.** It "is stored in a human readable format so that it
  could be modified between the snapshot and restore phases to achieve some very special use
  cases"
  ([`docs/snapshot_restore.md#L51-L56`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L51-L56)).
  Restore builds the VM from it (`recv_vm_config`, then `Vm::new` with that config;
  [`vmm/src/lib.rs#L2353-L2396`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2353-L2396)).
  It reopens the serial and console files from the new config
  ([`L1922-L1924`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L1922-L1924))
  and opens the initramfs path again
  ([`vmm/src/vm.rs#L695-L703`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/vm.rs#L695-L703)).
  Upstream's own migration guide requires the kernel and initramfs "in the _same directory_
  on both machines"
  ([`docs/live_migration.md#L66-L69`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/live_migration.md?plain=1#L66-L69)).
  A tap name in `config.json` can therefore be rewritten per run.
- **`state.json` holds device state, including the MAC.** A restored virtio-net device takes
  its features and its config space (where the MAC lives) from the saved `NetState`, not from
  the new config
  ([`virtio-devices/src/net.rs#L519-L524`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/virtio-devices/src/net.rs#L519-L524),
  [`L555-L567`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/virtio-devices/src/net.rs#L555-L567)).
  **Inference:** the guest kernel read the MAC at probe time and keeps it in guest memory.
  Editing `config.json`'s MAC changes nothing the guest uses, so every run of a build has the
  build's MACs. The vsock CID is guest-visible device state in the same way.
- **The API socket** is a VMM command-line argument (Intar passes
  `--api-socket /run/cloud-hypervisor.sock`, `crates/intar-jailer/src/lib.rs` L24-L29),
  not part of the snapshot, so it never collides.
- **The memory file is opened read-only** by both restore paths
  ([`vmm/src/memory_manager.rs#L838-L842`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L838-L842),
  [`L944`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L944)).
  **Inference:** concurrent restores can share one `memory-ranges`. The disk cannot be
  shared: the snapshot does not contain the disk (only the three files above,
  [`docs/snapshot_restore.md#L38-L61`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L38-L61)),
  so each run needs its own copy of the disk as it was at the snapshot instant, at the same
  size.

### How Intar's layout fits

- **Paths line up already.** Every jail exposes the same in-jail paths: `/boot/kernel`,
  `/boot/initrd`, `/disks/root.raw`, `/disks/runtime.raw`, `/disks/recordings.vfat`,
  `/disks/tools.ext4`, `/logs/serial.log`, `/logs/console.log`, `/run/kino.vsock`,
  `/run/cloud-hypervisor.sock` (`jail_paths`, `crates/intar-jailerd/src/lifecycle_fs.rs`
  L148-L174). The agent writes those paths into `VmConfig`
  (`crates/intar-agent/src/vm/manager/launch.rs` L42-L119). A `config.json` taken inside
  one jail is valid in any other jail without edits.
- **Duplicate taps and MACs are legal in the kernel, but jailerd forbids them.** Each run has
  its own network namespace and its own bridge inside it
  (`crates/intar-jailerd/src/network.rs` L539-L559). Taps are created inside that namespace
  (`ip -n <ns> tuntap add`, L688-L722). Cloud Hypervisor joins it before it starts
  (`join_network_namespace`, `crates/intar-jailer/src/lib.rs` L209). Yet `ensure_vm`
  compares every run's attachments and fails with "TAP, MAC, vsock CID, or SSH public port is
  already allocated" (`network.rs` L243-L259; `recover_vm` repeats it at L350-L368). The host
  TAP MAC is derived from the guest MAC (`derived_tap_mac`,
  `crates/intar-jailerd/src/network/topology.rs` L31-L42), so it repeats too. The
  rule came from "assign disjoint MAC identities to guest NICs, host TAPs, and run bridges"
  (commit `a7c95113`, #47). Those identities only meet on one run's bridge.
- **Upstream precedent.** Firecracker's guide for clones does exactly this: one network
  namespace per clone, the same tap name and guest IP inside each, NAT outside
  ([`network-for-clones.md#L13-L23`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/network-for-clones.md?plain=1#L13-L23)).
  The fixed per-run cluster network decided in
  [#271](https://github.com/intar-dev/intar-dev/issues/271) already has this shape. A warm
  snapshot adds identical MACs and CIDs on top of the identical addresses.
- After any restore, Cloud Hypervisor sets `VIRTIO_NET_S_ANNOUNCE` and sends RARP on the tap
  ([`docs/live_migration.md#L138-L148`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/live_migration.md?plain=1#L138-L148)).
  That is harmless inside a per-run bridge.

## 3. Size and memory

**Answer.** Each node ships a memory file equal to its guest RAM (2 GiB), a state file of
tens of KB, and its disk. Restore can skip file holes, so a sparse memory file restores
faster and allocates less. Compressibility is not documented and needs a measurement. A
copy restore costs about guest RAM in anonymous memory plus guest RAM in page cache, charged
to the restoring VM's cgroup. That page cache is reclaimable, and it can be shared between
runs of the same snapshot. The lazy `ondemand` mode shortens time to resume. It does not
lower the final memory footprint, and inside Intar's jail it needs userfaultfd access.

### Artifact size

- **The memory file is dense for Intar's VMs.** The snapshot writer writes holes only when
  guest RAM is a shared file mapping. For anonymous memory it takes the "Dense fallback" and
  writes every byte
  ([`vmm/src/memory_manager.rs#L3222-L3320`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L3222-L3320)).
  Intar's `MemoryConfig` sets only `size`
  (`crates/intar-agent/src/vm/manager/launch.rs` L78-L80), so guest RAM is anonymous. That
  matches the measured 2 GiB file.
- **Restore honours holes.** `fill_saved_regions` walks the file with
  `SEEK_DATA`/`SEEK_HOLE` and copies only data extents
  ([`L829-L909`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L829-L909);
  helper in [`vmm/src/sparse.rs#L1-L60`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/sparse.rs#L1-L60)).
  **Inference:** punching holes into the zero pages of a dense file after the snapshot
  (`fallocate --dig-holes`) is restore-compatible. The guest pages behind a hole are never
  written, so they are never allocated on the host.
- **Free page reporting could create more zeros.** Cloud Hypervisor's balloon has
  `free_page_reporting`: the guest reports free pages and "the VMM can advise the host that it
  doesn't need these pages anymore"
  ([`docs/balloon.md#L60-L75`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/balloon.md?plain=1#L60-L75)).
  The Talos kernel has `CONFIG_PAGE_REPORTING=y` and `CONFIG_VIRTIO_BALLOON=m`
  ([config L1195, L6151](https://github.com/siderolabs/pkgs/blob/f4bda77bb9f8202cac8443a7284ce1c7aa129f38/kernel/build/config-amd64#L1195)).
  It sets `CONFIG_INIT_ON_ALLOC_DEFAULT_ON=y` but not `INIT_ON_FREE`
  ([L7012-L7013](https://github.com/siderolabs/pkgs/blob/f4bda77bb9f8202cac8443a7284ce1c7aa129f38/kernel/build/config-amd64#L7012-L7013)),
  so freed guest pages keep their old contents. **Inference:** without reporting, a formed node
  has few zero pages.
- **Compressibility: silent.** Measure it.

### Host memory a restore costs

- **Copy mode (the default)** reads the file into guest RAM before the VM resumes
  ([`docs/snapshot_restore.md#L108-L117`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L108-L117);
  plain `read` into guest memory at
  [`memory_manager.rs#L829-L909`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L829-L909)).
  cgroup v2: "A memory area is charged to the cgroup which instantiated it", and for files that
  other cgroups re-read, "it may make sense to use POSIX_FADV_DONTNEED"
  ([`cgroup-v2.rst#L1938-L1954`](https://github.com/torvalds/linux/blob/v6.18/Documentation/admin-guide/cgroup-v2.rst?plain=1#L1938-L1954)).
  **Inference:** the measured 4.1 GiB per VM is about 2 GiB of anonymous guest RAM plus
  about 2 GiB of page cache for that VM's own `memory-ranges`, which it was first to read.
  The page cache is reclaimable. Intar's VM units set no memory limit (properties in
  `crates/intar-jailerd/src/systemd_backend.rs` L232-L260), so nothing reclaims it before host
  pressure does. When several runs restore the same file on one host, the page cache exists
  once (it stays charged to whichever cgroup faulted it), so the second and later restores read
  from memory.
- **`prefault`** "controls eager prefaulting for the copy-based restore path (disabled by
  default)"
  ([`config.rs#L2819-L2827`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/config.rs#L2819-L2827)).
  It is passed down as the guest RAM mapping's prefault flag
  ([`memory_manager.rs#L1880-L1925`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L1880-L1925),
  [`L760-L800`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L760-L800)).
  **Inference:** it allocates all of guest RAM up front, including pages behind holes.
  It never lowers memory.
- **`memory_restore_mode=ondemand`** "uses `userfaultfd` to fault snapshot pages in on first
  access". It is strict ("restore fails instead of falling back"), rejects `prefault=on`, and
  needs page-aligned ranges
  ([`docs/snapshot_restore.md#L108-L128`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L108-L128)).
  Costs read from source:
  - A handler thread serves faults with `pread` plus `UFFDIO_COPY`. The snapshot file must
    stay available while the VM runs
    ([`memory_manager.rs#L912-L949`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L912-L949),
    [`vmm/src/uffd.rs#L248-L277`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/uffd.rs#L248-L277)).
  - It is not lazy forever. Between faults the handler prefaults one page per idle
    iteration until every page is in
    ([`memory_manager.rs#L1162-L1200`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L1162-L1200),
    [`L1326-L1391`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/memory_manager.rs#L1326-L1391)).
    **Inference:** the end state equals copy mode, all of guest RAM resident. It also reads
    holes as zero pages, so it loses the sparse-file saving.
  - Permissions: Cloud Hypervisor opens `/dev/userfaultfd` first and falls back to the
    `userfaultfd(2)` syscall without `UFFD_USER_MODE_ONLY`
    ([`vmm/src/uffd.rs#L98-L115`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/uffd.rs#L98-L115)).
    The syscall form needs `CAP_SYS_PTRACE` or `vm.unprivileged_userfaultfd=1`;
    `/dev/userfaultfd` is governed by file permissions
    ([`userfaultfd.rst#L55-L81`](https://github.com/torvalds/linux/blob/v6.18/Documentation/admin-guide/mm/userfaultfd.rst?plain=1#L55-L81)).
    Seccomp is no obstacle: the v53 filters allow the syscall and its ioctls
    ([`vmm/src/seccomp_filters.rs#L437-L441`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/seccomp_filters.rs#L437-L441),
    [`L777`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/seccomp_filters.rs#L777)).
    Intar's jail grants neither: the unit's `DeviceAllow` holds only `/dev/kvm`,
    `/dev/net/tun`, `/dev/urandom` and `/dev/null` (`crates/intar-jailerd/src/lib.rs` L77-L82),
    and the jailer clears every capability (`AmbientCapabilities=0`,
    `systemd_backend.rs` L259; jailer comment in `crates/intar-jailerd/src/core_lifecycle.rs`
    L121-L126).
- **The offload daemon path** (`vm.send-migration`/`vm.receive-migration` with `local=on`,
  including an on-demand `postcopy` variant) needs shared-memory backing. Its
  limitations section says "Anonymous memory is rejected" and that `net_fds` "are not plumbed
  through `vm.receive-migration`"
  ([`docs/snapshot_restore.md#L153-L177`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L153-L177),
  [`L273-L281`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/snapshot_restore.md?plain=1#L273-L281)).
  It would need `shared=on` guest memory.
- **No copy-on-write sharing of the memory file.** The userfaultfd module says "Unlike an
  mmap(MAP_PRIVATE) overlay approach, UFFD does not replace the original memory mapping"
  ([`vmm/src/uffd.rs#L12-L14`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/uffd.rs#L12-L14)).
  Every restored VM ends with a private, fully populated copy of guest RAM. *Comparison:*
  Firecracker resumes microVMs that "load memory on-demand from the snapshot and copy-on-write
  to anonymous memory"
  ([`snapshot-support.md#L141-L143`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/snapshot-support.md?plain=1#L141-L143)).
  Cloud Hypervisor v53.0 has no such mode.

## 4. Guest correctness after restore

### Clock

**Answer.** On x86 restore, Cloud Hypervisor moves kvmclock forward to the current wall time.
It does not move the vCPUs' TSCs, which restart at their saved values. The kernel's own
migration recipe adjusts both, and warns about timeouts unless the gap is short. The guest's
wall clock lags by the gap until time sync steps it. Talos over `/dev/ptp_kvm` did that at
once in the spike. Long gaps are untested.

- On pause, Cloud Hypervisor captures kvmclock with the host's `CLOCK_REALTIME` filled in
  ([`hypervisor/src/lib.rs#L216-L224`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/lib.rs#L216-L224),
  [`hypervisor/src/kvm/mod.rs#L1324-L1328`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L1324-L1328)).
  On resume after a restore it sets it back with `KVM_SET_CLOCK`
  ([`L1351-L1360`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L1351-L1360);
  restore marks the clock "must catch up to wall time",
  [`vmm/src/vm.rs#L705-L715`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/vm.rs#L705-L715)).
  With `KVM_CLOCK_REALTIME` set, KVM adds the elapsed host wall time to kvmclock
  ([`arch/x86/kvm/x86.c#L7196-L7240`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kvm/x86.c#L7196-L7240)).
- The vCPU TSCs come back from the saved MSRs. `MSR_IA32_TSC` is in KVM's save list
  ([`x86.c#L329-L335`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kvm/x86.c#L329-L335))
  and Cloud Hypervisor saves the KVM-reported list
  ([`hypervisor/src/kvm/mod.rs#L1746-L1759`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/hypervisor/src/kvm/mod.rs#L1746-L1759)).
  After restore, Cloud Hypervisor only copies vCPU 0's TSC offset to the others
  ([`vmm/src/cpu.rs#L1122-L1150`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/cpu.rs#L1122-L1150)),
  the only caller of `set_tsc_offset`.
- The kernel's recipe for this is in `KVM_VCPU_TSC_OFFSET`: set kvmclock (step 4), then shift
  every vCPU's TSC offset by the elapsed time (steps 6 and 7). Step 4 alone "will cause problems
  in the guest (e.g., timeouts) unless CLOCK_REALTIME is synchronized between the source and
  destination, and a reasonably short time passes"
  ([`devices/vcpu.rst#L230-L293`](https://github.com/torvalds/linux/blob/v6.18/Documentation/virt/kvm/devices/vcpu.rst?plain=1#L230-L293)).
  Cloud Hypervisor does step 4 but not step 6.
- When the host exposes an invariant TSC, the Linux guest lowers kvm-clock's rating so the
  TSC becomes its clocksource
  ([`arch/x86/kernel/kvmclock.c#L334-L345`](https://github.com/torvalds/linux/blob/v6.18/arch/x86/kernel/kvmclock.c#L334-L345)).
  Cloud Hypervisor publishes the TSC frequency leaf only on invariant-TSC hosts
  ([`arch/src/x86_64/mod.rs#L982-L997`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/arch/src/x86_64/mod.rs#L982-L997)).
  **Inference:** a Talos guest on such a host keeps time from a TSC that resumed at the
  snapshot instant. `CLOCK_MONOTONIC` does not see the gap, and `CLOCK_REALTIME` lags by it.
  That matches the measured 10-minute gap. The clocksource Talos actually picks on Cloud
  Hypervisor was not checked.
- PTP: `ptp_kvm` on x86 asks the host for (wall time, guest TSC) pairs through the
  `KVM_HC_CLOCK_PAIRING` hypercall
  ([`drivers/ptp/ptp_kvm_x86.c#L23-L66`](https://github.com/torvalds/linux/blob/v6.18/drivers/ptp/ptp_kvm_x86.c#L23-L66)).
  The hypercall returns `KVM_EOPNOTSUPP` "if the host does not use TSC clocksource"
  ([`hypercalls.rst#L103-L138`](https://github.com/torvalds/linux/blob/v6.18/Documentation/virt/kvm/x86/hypercalls.rst?plain=1#L103-L138)),
  and also in TSC catch-up mode (section 1). The Talos kernel has
  `CONFIG_PTP_1588_CLOCK_KVM=y`
  ([config L3608-L3615](https://github.com/siderolabs/pkgs/blob/f4bda77bb9f8202cac8443a7284ce1c7aa129f38/kernel/build/config-amd64#L3608-L3615)).
  Talos `TimeSyncConfig` takes `ptp.devices` (for example `/dev/ptp_kvm`) as the alternative
  to NTP
  ([`time_sync.go#L69-L102`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/types/network/time_sync.go#L69-L102)).
  Two host conditions therefore matter for PTP: a TSC host clocksource, and a TSC rate that
  is equal or scalable.

### Kernel RNG and other duplicated state

**Answer.** Cloud Hypervisor v53.0 implements no VM Generation ID. The Talos kernel would
reseed on one, but has nothing to bind to. Every clone starts with the same kernel CRNG key
and keeps producing the same stream until the next scheduled reseed. That reseed mixes in
RDSEED/RDRAND, interrupt timing and virtio-rng input, and comes at most 60 s later. In-process
state such as Go PRNG seeds, TLS keys, TCP sequence-number secrets and `boot_id` stays
duplicated.

- **No VMGenID in Cloud Hypervisor.** A case-insensitive search of the whole v53.0 tree for
  `genid`, `vmgen`, `vm_gen` and `generation id` returns nothing. `docs/device_model.md`
  lists no such device
  ([`L5-L24`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/device_model.md?plain=1#L5-L24)).
  The always-on virtio-rng draws from host `/dev/urandom`
  ([`L145-L154`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/device_model.md?plain=1#L145-L154)).
  Cloud Hypervisor has no VMClock device either (the same search for `vmclock` is empty).
- **The Talos kernel would use it.** `CONFIG_VMGENID=m`
  ([config L6135](https://github.com/siderolabs/pkgs/blob/f4bda77bb9f8202cac8443a7284ce1c7aa129f38/kernel/build/config-amd64#L6135)).
  The driver binds ACPI `VMGENCTR`/`VM_GEN_COUNTER` and, when the ID changes, calls
  `add_vmfork_randomness`
  ([`drivers/virt/vmgenid.c#L26-L36`](https://github.com/torvalds/linux/blob/v6.18/drivers/virt/vmgenid.c#L26-L36),
  [`L161-L166`](https://github.com/torvalds/linux/blob/v6.18/drivers/virt/vmgenid.c#L161-L166)).
  That function forces an immediate reseed ("crng reseeded due to virtual machine fork")
  ([`drivers/char/random.c#L986-L1003`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L986-L1003)).
  `CONFIG_PTP_1588_CLOCK_VMCLOCK=y` is also set (config L3615).
- **Without it, reseeding is periodic.** `CRNG_RESEED_INTERVAL = 60 * HZ`, shorter only in
  the first two minutes of uptime
  ([`random.c#L206-L248`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L206-L248)).
  The hwrng feed (virtio-rng is `CONFIG_HW_RANDOM_VIRTIO=m`, config L3466) is throttled to
  "once every reseed interval"
  ([`random.c#L955-L971`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L955-L971)).
  In 6.18, RDSEED/RDRAND enter only in `extract_entropy`, which runs at reseed
  ([`L673-L690`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L673-L690)).
  The per-call path `crng_make_state` uses none
  ([`L338-L394`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L338-L394)).
  The vDSO `getrandom` state is invalidated through the same generation counter at reseed
  ([`L254-L293`](https://github.com/torvalds/linux/blob/v6.18/drivers/char/random.c#L254-L293);
  `CONFIG_VDSO_GETRANDOM=y`, config L7415).
  **Inference:** clones of one snapshot can return identical `getrandom` bytes for up to
  about 60 s of guest time after resume.
- *Comparison:* Firecracker's clone guide says outputs differ across clones because "output
  from `CPU HWRNG` instructions ... [is] mixed with each result"
  ([`random-for-clones.md#L51-L70`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/random-for-clones.md?plain=1#L51-L70)).
  That reasoning cites a pre-5.18 analysis and does not hold for the 6.18 code above.
  Firecracker always enables VMGenID and still warns that a race window remains, and that
  "identifiers, cached random numbers, cryptographic tokens, etc **will** still be replicated"
  ([`snapshot-support.md#L597-L621`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/snapshot-support.md?plain=1#L597-L621)).
  Every clone also reads the same `/proc/sys/kernel/random/boot_id`
  ([`random-for-clones.md#L144-L155`](https://github.com/firecracker-microvm/firecracker/blob/v1.17.0/docs/snapshotting/random-for-clones.md?plain=1#L144-L155)).
  Its mitigation, `RNDADDENTROPY` plus `RNDRESEEDCRNG` from inside the guest after resume
  (L157-L185), needs an agent in the guest. Intar never talks to a node (opaque VM,
  [#272](https://github.com/intar-dev/intar-dev/issues/272)).
- **Inference on what this means for Intar.** The runs of one build already share the
  cluster CA and admin credentials by design (#267 settled notes), and the cold-boot design
  already duplicates everything on disk. A warm snapshot adds the in-memory duplicates: CRNG
  output for the first minute, Go runtime and TLS state in long-lived processes (etcd,
  kube-apiserver, kubelet), TCP sequence secrets, `boot_id`. Runs are isolated clusters, so a
  duplicate matters only where it crosses a run boundary. The one crossing found is outbound
  TLS to the internet early after resume (for example image pulls). Two runs could then use
  identical ephemeral keys or nonces. Nobody can exploit that without capturing another
  run's traffic, but it is a real reuse.

### Kubernetes leases and etcd

- client-go leader election (kube-controller-manager, kube-scheduler) decides validity from
  `observedTime`, set from its own clock when it last saw the record change, plus
  `LeaseDurationSeconds`. It does not read the stored `RenewTime`
  ([`leaderelection.go#L548-L563`](https://github.com/kubernetes/client-go/blob/v0.37.1/tools/leaderelection/leaderelection.go#L548-L563)).
  **Inference:** Go's `time.Now()` carries a monotonic reading, and the guest's monotonic
  clock does not jump across the restore (see Clock), so the PTP step of the wall clock alone
  should not expire leases. Controllers that compare stored wall-clock timestamps would see
  them as old. Node leases and the node lifecycle controller were not read.
- etcd: not read for this ticket. The three members resume from one consistent pause, like
  a brief whole-cluster partition. **Inference:** this is safe as long as all three are paused
  before any is snapshotted (the spike did that) and each disk is captured at its VM's
  pause instant.

### How long a gap stays safe

The sources give upper bounds, not a safe number:

- **Cloud Hypervisor major:** no restore across majors (section 1). At about one major every
  6 weeks, the gap is bounded by how long the fleet stays on v53.
- **Certificates:** the `talosconfig` client certificate and the downloaded kubeconfig are
  valid for 1 year; CAs for 10 years; "the kubelet needs to be restarted at least once a
  year" (#268 findings, `research/talos-on-cloud-hypervisor-and-qemu.md` on branch
  `research/talos-on-cloud-hypervisor-and-qemu`, citing the
  [certificate management doc](https://docs.siderolabs.com/talos/v1.14/security/cert-management)).
  **Inference:** with cold boots every run restarts the kubelet. With warm snapshots the
  kubelet process from build time keeps running, so its age counts from the snapshot, not
  from the run.
- **Clock:** the kernel recipe's "a reasonably short time passes" (above). For weeks or months:
  silent; it needs an experiment.

## 5. Production: who takes the snapshot

**Answer.** It has to be Cloud Hypervisor v53.x running the same device model, config and
jail layout that runs use. Cloud Hypervisor restores only its own `config.json`, `state.json`
and `memory-ranges` directory (section 1). The QEMU builder cannot produce one.

- **The builder today** runs unprivileged QEMU, `q35,accel=kvm`, `-cpu host`, with user-mode
  networking and QMP (`render_direct_boot_qemu_command`,
  `crates/intar-image-build/src/qemu.rs` L32-L80). It has KVM, but no taps, no network
  namespace, no jail and no Cloud Hypervisor.
- **Three placements, in rising order of portability:**
  1. **The builder takes it.** After the existing QEMU stage forms the cluster and powers off,
     a new stage cold-boots the baked disks under Cloud Hypervisor; #270 showed baked disks
     survive that. The stage waits for a healthy cluster, pauses all nodes, snapshots each
     and copies each disk while paused. The snapshot's CPUID is the builder host's, so every
     run host must be a superset of it (section 1). That means a deliberately low-end builder
     CPU, or one build per CPU class.
  2. **Each agent host takes its own, on first use.** The first run of a build on a host
     cold-boots (45 to 51 s), and the agent snapshots it once the cluster is healthy. Later
     runs on that host restore. The snapshot never leaves the host, so CPU, TSC and host
     kernel always match, and nothing needs shipping. That first run's learner would see the
     snapshot pause, and its disks must not change between pause and copy. Snapshotting a
     separate warm-up run before any learner arrives avoids both problems.
  3. **Per CPU class, published.** Like 1, keyed by a CPU-feature signature. The agent picks
     the matching snapshot and cold-boots when none matches.
- **What a Cloud Hypervisor stage needs**, from the points above: the fleet's pinned binary;
  KVM; a network namespace with the run's cluster network (10.5.0.0/24, its gateway and DNS
  forwarding, per #271), because the guest keeps whatever it saw at snapshot time; taps
  inside it, which needs `CAP_NET_ADMIN`; the run's in-jail paths and exact device set
  (CPU count, memory size, disks, sizes, serial, vsock); and room for a memory file per node.
  Running it through jailerd on the builder host gives the path and network parity for free.
  Jailerd caps file size per jail (`file_size_limit` in `JailSpecV1`,
  `crates/intar-jailer-protocol/src/lib.rs` L980-L990), which a 2 GiB memory file must fit.

## What Intar would have to change

None of this is decided; it is the list of touch points the sources imply.

### Agent: `crates/intar-agent/src/vm/manager/launch.rs` and neighbours

- **Restore instead of create and boot.** `run_create` builds a `VmConfig`, then calls
  `vm.create` and `vm.boot` (L992-L1043). A warm launch skips the config, since
  `config.json` is the config, and calls `vm.restore` on a fresh VMM followed by `vm.resume`
  (or `resume: true`). The `cloud-hypervisor-client` crate has `ping`, `vm_info`,
  `vm_create`, `vm_boot`, `vm_add_disk`, `vm_shutdown` and `vm_delete` only
  (`crates/cloud-hypervisor-client/src/lib.rs` L374-L505). It needs `vm_restore` and
  `vm_resume`, plus `vm_pause` and `vm_snapshot` for whoever takes the snapshot.
- **Fixed network identity per node.** The agent draws a random MAC per launch
  (`mac::generate_local_unicast_mac()`, `api.rs` L536; `crates/intar-agent/src/vm/mac.rs`
  L5-L13), a random tap name (`allocate_tap_name`, `jailer_network.rs` L278-L301) and a vsock
  CID (`allocate_kino_vsock_cid`, `state.rs` L350). For a warm node, the MAC and CID must be
  the build's. The tap name either stays the build's, or the agent rewrites
  `net[].tap` in `config.json` per run.
- **Fixed device set and disk.** The restored VM must have exactly the snapshot's devices,
  disk sizes included. The root disk must be the copy taken at the snapshot instant, not the
  image, and `disk_mib` resizing (L313-L316, L896-L908) cannot apply. A per-run runtime disk
  (L927-L946) is never re-read by a guest that is already booted, so per-run data cannot
  reach a warm node that way. #272's opaque-VM shape should settle which disks a node has
  at all.
- **Fallback.** A restore can fail on CPUID, TSC or version (section 1). The agent then needs
  to cold-boot the same node from its baked disk.
- **Capacity.** Count about twice guest RAM per restoring node until the page cache is
  reclaimed, or drop the memory file's page cache after restore.

### jailerd and jailer

- **Uniqueness scope.** `NetworkManager::ensure_vm` and `recover_vm` refuse a tap name, guest
  MAC, tap MAC or vsock CID used by any VM of any run
  (`crates/intar-jailerd/src/network.rs` L243-L259, L350-L368). For nodes on the per-run
  cluster network, the scope becomes the run. Within the run, the checks against the run
  bridge's derived MAC (`derived_bridge_mac`, `topology.rs` L44-L47) and between the nodes
  stay. #271's fixed cluster network also needs the run-CIDR overlap check (`network.rs`
  L138-L151) relaxed; that is not specific to warm snapshots.
- **Snapshot files in the jail.** The jail's Landlock allowlist covers only the kernel,
  initrd, the four disks, logs, `/run`, four device nodes and `/proc`
  (`prepare_landlock_rules`, `crates/intar-jailer/src/lib.rs` L284-L430). A restore needs a
  read-only snapshot directory staged into the jail, alongside a per-run copy of the snapshot
  disk at `/disks/root.raw`. Today root disks are reflinked from templates
  (`crates/intar-jailerd/src/staging.rs` L449-L502). **Inference:** a hard link of
  `memory-ranges` shares one page cache across runs, but a reflink is a separate inode with
  its own page cache. Hard links are the better fit for the memory file.
- **On-demand restore** additionally needs `/dev/userfaultfd` in the jail, in `DeviceAllow`
  (`crates/intar-jailerd/src/lib.rs` L77-L82) and in the Landlock rules. The alternative,
  `vm.unprivileged_userfaultfd=1`, is a host-wide security setting.
- **Protocol.** `LaunchVmV3Request` describes a fresh boot (`build_jailer_launch_operation`,
  `launch.rs` L263-L275). A restore launch needs its own artifact set (snapshot directory plus
  disk) in `intar-jailer-protocol`. Under the AGENTS.md rules that is a contract change.

## What an experiment still has to prove

1. **Cross-host restore** between each pair of host CPU classes in the fleet. Record whether
   the CPUID check passes, whether TSC scaling is in use, guest `dmesg` clocksource and
   watchdog lines, and whether `/dev/ptp_kvm` still works.
2. **Concurrent restores of one snapshot on one host,** each in its own run namespace with
   identical tap names and MACs, and jailerd's checks relaxed in a throwaway spike. Measure
   time to kube-apiserver with cold and warm page cache, `memory.current` per VM, and total
   host memory.
3. **Memory file shrinkage:** zstd ratio of `memory-ranges`; restore time and resident memory
   after `fallocate --dig-holes`; the same with balloon `free_page_reporting=on` before the
   snapshot.
4. **`ondemand` inside the jail** with `/dev/userfaultfd`: time to first API answer, time
   until the background prefault completes, and the CPU it costs under `CPUQuota=200%`.
5. **Long gaps:** restore a snapshot days or weeks old. Measure how long PTP takes to step the
   clock, check leader elections, node conditions, pod evictions and etcd health, and see
   whether anything else relies on wall-clock timestamps. Also check which clocksource Talos
   uses on Cloud Hypervisor.
6. **RNG overlap:** compare early `getrandom` output and `boot_id` across two clones (for
   example from a pod started from the snapshot), before and after the first 60 s.
7. **Point-release compatibility:** restore a v53.0 snapshot on v53.x, once such a release
   exists.

## Where the sources are silent

- Snapshot compatibility within a Cloud Hypervisor major release.
- Any host-kernel-version requirement for Cloud Hypervisor restore.
- Compressibility of the memory file.
- Kubernetes node leases and etcd behaviour after a wall-clock step (not read here).
- Whether Talos loads `vmgenid` from udev modaliases; moot while Cloud Hypervisor has no such
  device.
