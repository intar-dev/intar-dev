# How Talos behaves on Cloud Hypervisor and QEMU

Research for [#268](https://github.com/intar-dev/intar-dev/issues/268), part of the
[Talos cluster scenarios map (#267)](https://github.com/intar-dev/intar-dev/issues/267).
Read on 2026-10-29. Every claim links to the primary source it comes from. Where the
sources leave something open, it says so and lists it for the hands-on spike
([#269](https://github.com/intar-dev/intar-dev/issues/269)).

## Versions read

- **Talos Linux v1.14.5**, the latest stable release
  ([releases](https://github.com/siderolabs/talos/releases/tag/v1.14.5)). Docs are the
  v1.14 set on `docs.siderolabs.com/talos/v1.14/`. Source links are pinned to tag `v1.14.5`.
- **Image Factory**: [`docs/api.md`](https://github.com/siderolabs/image-factory/blob/main/docs/api.md)
  on `main`, plus the live `factory.talos.dev` endpoints.
- **Cloud Hypervisor v53.0**, the version Intar pins (`CLOUD_HYPERVISOR_VERSION` in
  `crates/intar-jailer-protocol/src/lib.rs`). Source links are pinned to tag `v53.0`.
- **QEMU**: docs and source on `master`. The builder's QEMU version isn't pinned in this repo.
- **etcd v3.7** docs. Talos v1.14.5 ships etcd `v3.7.3` by default
  ([`constants.go#L441-L443`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/constants/constants.go#L441-L443)).

## How Intar boots VMs today

This research phrases findings against these code paths:

- **Runs.** `build_cloud_hypervisor_vm_config` in `crates/intar-agent/src/vm/manager/launch.rs`
  creates the VM through the Cloud Hypervisor API. It sets a `kernel`, an optional
  `initramfs` and a `cmdline`, with no firmware. It attaches raw virtio disks for the root,
  runtime (read-only), recordings and optional tools, one virtio-net on a tap with a MAC
  that changes on every launch, a vsock, and serial and console output written to files.
  `intar-jailer` starts Cloud Hypervisor with only `--api-socket` and `--seccomp true`
  (`crates/intar-jailer/src/lib.rs`), so `--no-shutdown` is not set.
- **Stops.** The agent stops a VM with the API's `vm.shutdown`
  (`crates/intar-agent/src/vm/manager/cleanup.rs`). That is a VMM-side stop, not an ACPI request.
- **Builds.** `render_direct_boot_qemu_command` in `crates/intar-image-build/src/qemu.rs`
  boots `-machine q35`, `-kernel/-initrd/-append`, `-no-reboot`, `-nodefaults`, with virtio
  disks and **user-mode (slirp) networking**. The build ends with a QMP `system_powerdown`
  and treats a QEMU exit before that request as a failure (`crates/intar-image-build/src/direct.rs`).
- **Guest IPs.** The agent refuses a guest IP that any VM on the same agent already uses
  (`ensure_guest_ip_available` in `crates/intar-agent/src/vm/manager/state.rs`).

## 1. Direct kernel boot

**Answer.** Yes, on both VMMs. Boot the Image Factory `kernel-amd64` and `initramfs-amd64.xz`
of the exact schematic and version the disk was built with. The kernel command line needs
`talos.platform=metal`, `slab_nomerge` and `pti=on`. Talos then finds the installed disk
and loads its machine config from the STATE partition. Upstream's own QEMU provisioner
already runs exactly this mode.

- **The assets exist.** Image Factory serves `kernel-<arch>` ("raw kernel image"),
  `initramfs-<arch>.xz` and `cmdline-<platform>-<arch>`, plus a raw `metal-<arch>.raw.xz`
  disk image ([`docs/api.md`](https://github.com/siderolabs/image-factory/blob/main/docs/api.md)).
  The default schematic (no customizations) is
  `376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4ba` (same file). For v1.14.5
  the kernel is 19,255,296 bytes, the initramfs 96,536,336 bytes and the raw disk image
  232,462,488 bytes (HTTP `Content-Length` from `factory.talos.dev`, 2026-10-29).
- **Kernel format.** The v1.14.5 `kernel-amd64` starts with `MZ` and carries the `HdrS`
  magic at offset 0x202 (boot protocol 2.15). That makes it an x86 bzImage with an EFI stub
  (header bytes read from `factory.talos.dev`). The Talos kernel config has
  `# CONFIG_PVH is not set` and `CONFIG_EFI_STUB=y`
  ([`siderolabs/pkgs` `kernel/build/config-amd64` at `f4bda77`](https://github.com/siderolabs/pkgs/blob/f4bda77/kernel/build/config-amd64),
  the pkgs revision Talos v1.14.5 builds from per
  [`Makefile#L31`](https://github.com/siderolabs/talos/blob/v1.14.5/Makefile#L31)).
- **Cloud Hypervisor accepts it.** Cloud Hypervisor v53 says "The x86-64 kernel must be built
  with PVH support or be a bzImage", and for direct kernel boot "a `vmlinux` ELF kernel
  (compiled with PVH support) or a regular bzImage are supported"
  ([README](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/README.md#L114-L118),
  [L200](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/README.md#L200)).
  Without PVH, Talos can only take the bzImage path. No firmware is involved.
- **QEMU q35 accepts it.** `-kernel bzImage` "Use bzImage as kernel image", with `-initrd` and `-append`
  ([QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html)). Talos's own
  QEMU provisioner boots `-machine q35,accel=kvm` with `-kernel`, `-initrd` and `-append`
  ([`launch.go#L465-L471`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/provision/providers/qemu/launch.go#L465-L471)).
- **An installed disk works under an external kernel.** The provisioner keeps passing
  `-kernel/-initrd` even when the disk is bootable, unless the bootloader is enabled
  ([`launch.go#L437-L473`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/provision/providers/qemu/launch.go#L437-L473)).
  The flag `--with-bootloader` is described as "enable bootloader to load kernel and
  initramfs from disk image after install"
  ([`cmd_dev.go#L226`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/mgmt/cluster/create/cmd_dev.go#L226)).
  Talos's own e2e script sets `--with-bootloader=false` outside CI
  ([`e2e-qemu.sh#L14-L19`](https://github.com/siderolabs/talos/blob/v1.14.5/hack/test/e2e-qemu.sh#L14-L19)).
  Inside the guest, "installed" means a META volume was found
  ([`v1alpha1_state.go#L225-L251`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_state.go#L225-L251)).
  The config controller tries the disk first: its state machine starts at `stateDisk`, which
  "acquires machine configuration from disk (STATE partition)" and skips the platform and
  cmdline sources when it finds a complete config
  ([`acquire.go#L174`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/config/acquire.go#L174),
  [`L243-L296`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/config/acquire.go#L243-L296)).
  The install sequence only runs when the machine isn't installed yet, or an install is staged
  ([`v1alpha1_sequencer.go#L171-L205`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L171-L205)).
- **Required kernel arguments.**
  - `talos.platform` is mandatory. Without it, machined fails with "failed to determine platform"
    ([`platform.go#L71-L90`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/platform/platform.go#L71-L90)).
    Use `metal`.
  - `slab_nomerge` and `pti=on` are enforced. `EnforceKSPPKernelParameters` fails boot when either
    is missing or wrong
    ([`kspp.go#L19-L50`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/kernel/kspp/kspp.go#L19-L50)).
    It runs first in the initialize sequence
    ([`v1alpha1_sequencer.go#L84-L87`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L84-L87)).
  - The Image Factory default for metal/amd64 v1.14.5 is
    `talos.platform=metal console=tty0 slab_nomerge pti=on consoleblank=0 printk.devkmsg=on selinux=1 module.sig_enforce=1 proc_mem.force_override=never`
    ([`cmdline-metal-amd64`](https://factory.talos.dev/image/376567988ad370138ad8b2698212367b8edcb69b5fd68c80be1f2ec7d603b4ba/v1.14.5/cmdline-metal-amd64)).
    Start from that line.
  - Add `console=ttyS0` so Intar's serial log file captures output. The kernel config has
    `CONFIG_SERIAL_8250_CONSOLE=y`, but virtio-console is only a module (`CONFIG_VIRTIO_CONSOLE=m`),
    so `hvc0` can't be an early console
    ([kernel config](https://github.com/siderolabs/pkgs/blob/f4bda77/kernel/build/config-amd64)).
  - `root=` is irrelevant. Talos runs from its initramfs and mounts its volumes by label.
  - Intar's current Debian cmdlines (`BUILD_BOOT_CMDLINE` and `PUBLISHED_BOOT_CMDLINE` in
    `qemu.rs`) satisfy none of these requirements. A Talos image needs its own cmdline.
- **Recommended extra arguments**, covered below: `sysctl.kernel.kexec_load_disabled=1`
  (section 2), and optionally `ip=` and `talos.hostname=` (section 3). The kernel parameter
  reference is [`reference/kernel`](https://docs.siderolabs.com/talos/v1.14/reference/kernel).
- **Consequence for upgrades.** When the VMM supplies the kernel, the disk's BOOT partition no
  longer decides what boots. A `talosctl upgrade` inside a run would write new boot assets that
  the next cold boot ignores. This is inferred from the `--with-bootloader` description above,
  not stated outright. Treat in-run upgrades as unsupported.

## 2. Power

**Answer.** Talos honours the ACPI power button: it runs a forced shutdown and powers off.
`talosctl shutdown` drains the node (unless forced) and issues `poweroff(2)`.
`talosctl reboot` **kexecs by default**, which the VMM never sees, into the kernel and cmdline
from the disk's bootloader config. `--mode powercycle`, or disabling kexec, turns a reboot into
a real reset. On Cloud Hypervisor a reset reboots the VM inside the same process with the same
kernel, cmdline and devices. A guest power-off ends the process, because Intar doesn't pass
`--no-shutdown`.

- **ACPI.** machined listens on the `acpi_event` generic-netlink family for `button/power`
  ([`acpi.go#L22-L31`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/acpi/acpi.go#L22-L31)).
  It starts the listener on every non-container platform
  ([`v1alpha1_controller.go#L223-L225`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_controller.go#L223-L225)).
  On the event it runs the shutdown sequence with `Force: true`
  ([`v1alpha1_controller.go#L260-L274`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_controller.go#L260-L274)),
  so the node isn't drained
  ([`v1alpha1_sequencer.go#L363-L384`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L363-L384)).
  The ACPI button driver is a module in Talos (`CONFIG_ACPI_BUTTON=m`,
  [kernel config](https://github.com/siderolabs/pkgs/blob/f4bda77/kernel/build/config-amd64)),
  so it has to be auto-loaded for the event to arrive. **Spike item.**
- **Cloud Hypervisor power button.** `vm.power-button` "Trigger power button of the VM"
  ([`docs/api.md#L81`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/docs/api.md#L81)).
  On x86-64 it raises a GED notification for `\_SB_.PWRB`, a `PNP0C0C` power-button device
  ([`device_manager.rs#L5503-L5511`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/device_manager.rs#L5503-L5511),
  [`L5864-L5871`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/device_manager.rs#L5864-L5871)).
  Intar doesn't use it today: it stops VMs with `vm.shutdown`, which tears the VM down from
  the VMM side without telling the guest
  ([`lib.rs#L2414-L2425`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2414-L2425)).
- **QEMU power button.** `system_powerdown` "Requests that a guest perform a powerdown operation"
  ([`qapi/machine.json`](https://github.com/qemu/qemu/blob/master/qapi/machine.json)).
  On q35 it raises the ACPI PM1 power-button event
  ([`hw/acpi/ich9.c` `pm_powerdown_req`](https://github.com/qemu/qemu/blob/master/hw/acpi/ich9.c)).
  The builder's current QMP powerdown handshake should therefore shut a Talos node down
  cleanly, provided the button module loads (spike item above).
- **`talosctl shutdown`.** The shutdown sequence cordons and drains the node unless forced,
  stops pods and services, unmounts, then issues `LINUX_REBOOT_CMD_POWER_OFF`. The kernel
  argument `talos.shutdown=halt` switches that to `HALT`
  ([`v1alpha1_sequencer.go#L363-L384`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L363-L384),
  [`v1alpha1_sequencer_tasks.go#L1305-L1321`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer_tasks.go#L1305-L1321)).
- **`talosctl reboot`.**
  - The reboot sequence prepares kexec once services have stopped
    ([`v1alpha1_sequencer.go#L257-L270`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L257-L270),
    [`L510-L560`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L510-L560)).
  - When kexec is prepared, the reboot uses `LINUX_REBOOT_CMD_KEXEC` instead of `RESTART`
    ([`v1alpha1_sequencer_tasks.go#L1279-L1302`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer_tasks.go#L1279-L1302)).
  - The kexec target is the system disk's bootloader entry. On GRUB that is the default
    entry's kernel, initrd and **cmdline from the disk**
    ([`v1alpha1_sequencer_tasks.go#L1647-L1697`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer_tasks.go#L1647-L1697),
    [`grub.go#L57-L94`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/bootloader/grub/grub.go#L57-L94)).
    Any per-run argument Intar passes, such as `console=ttyS0` or `ip=`, would be lost after a
    learner reboot.
  - `--mode powercycle` "bypasses kexec"
    ([`reboot.go#L150-L154`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/talos/reboot.go#L150-L154),
    [`KexecPrepare`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer_tasks.go#L1647-L1655)).
  - Upstream disables kexec whenever the bootloader is off: its QEMU config maker sets the
    machine sysctl `kernel.kexec_load_disabled: "1"`
    ([`makers/qemu.go#L178-L186`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/mgmt/cluster/create/clusterops/configmaker/internal/makers/qemu.go#L178-L186)).
    The Azure platform does the same with the kernel argument
    `sysctl.kernel.kexec_load_disabled=1`
    ([`azure.go#L246-L248`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/platform/azure/azure.go#L246-L248)).
  - **Recommendation:** do the same, so every learner reboot becomes a VMM reset that
    re-reads Intar's kernel and cmdline.
- **Cloud Hypervisor on guest reset.** The ACPI reset write signals `reset_evt`
  ([`acpi.rs#L63-L74`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/devices/src/acpi.rs#L63-L74)).
  The VMM loop answers with `vm_reboot()` and keeps running
  ([`lib.rs#L2088-L2094`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2088-L2094)).
  `vm_reboot` shuts the VM down, keeps its config, recreates the console devices, builds a new
  VM from the same config and boots it
  ([`lib.rs#L2427-L2490`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2427-L2490)).
  So the kernel, cmdline, MAC, tap and disks stay the same and **the process stays alive**.
  Side effect: the serial and console files are reopened with `File::create`, which truncates
  them, so pre-reboot guest output is lost from those logs
  ([`console_devices.rs#L186-L189`, `L230-L233`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/console_devices.rs#L186-L233)).
- **Cloud Hypervisor on guest power-off.** An ACPI S5 write signals `guest_exit_evt`
  ([`acpi.rs#L76-L92`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/devices/src/acpi.rs#L76-L92)).
  Without `no_shutdown`, the VMM shuts down and **exits**. With `--no-shutdown`, "Do not exit
  the VMM when the guest shuts down", it only shuts the VM down
  ([`lib.rs#L2095-L2104`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/lib.rs#L2095-L2104),
  [`main.rs#L390-L395`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/cloud-hypervisor/src/main.rs#L390-L395)).
  The map settles that "learners may reboot or shut down nodes, and the run keeps going". As
  Intar launches Cloud Hypervisor today, a learner's `talosctl shutdown` ends that node's
  VMM process for the rest of the run, unless Intar adds `--no-shutdown` or relaunches the VM.
- **QEMU builds.** `-no-reboot` means "Exit instead of rebooting"
  ([QEMU invocation](https://www.qemu.org/docs/master/system/invocation.html)). Talos's
  provisioner handles that by relaunching QEMU after each reboot ("every reboot of the VM is a
  relaunch",
  [`launch.go#L503`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/provision/providers/qemu/launch.go#L503)).
  A Talos install ends with kexec and a reboot
  ([`v1alpha1_sequencer.go#L171-L205`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer.go#L171-L205)).
  With kexec disabled, that reboot makes QEMU exit, which `direct.rs` currently treats as a
  failed build. The builder ticket has to account for this.

## 3. Network

**Answer.** Yes. A `LinkAliasConfig` selects the NIC with a CEL expression such as
`link.driver == "virtio_net"`, and the alias can stand in for the link name everywhere in the
network config. Don't key on names or MACs: Talos's default naming falls back to `enx<MAC>`,
and the PCI-based name will likely differ between QEMU and Cloud Hypervisor. `ip=` is honoured
as the low-precedence `cmdline` layer before any machine config exists, so it works in
maintenance mode. With direct kernel boot it is passed on every boot.

- **Link aliases.**
  - A `LinkAliasConfig` names a physical link through a CEL expression over the `LinkStatus`
    spec. The documented `LinkStatus` includes `driver: virtio_net`, `busPath`,
    `hardwareAddr` and `permanentAddr`.
  - The alias "can be used interchangeably with physical link names in all networking
    configuration sections (links, routes, addresses, etc.)".
  - A fixed-name alias must match exactly one physical link, "otherwise the configuration will
    not be applied"
    ([Link Aliases](https://docs.siderolabs.com/talos/v1.14/networking/configuration/aliases)).
  - Examples include `match: link.driver == "e1000"` and the single-NIC `match: true`
    ([LinkAliasConfig reference](https://docs.siderolabs.com/talos/v1.14/reference/configuration/network/linkaliasconfig)).
  - Each Intar VM has exactly one virtio-net (`launch.rs`), so a node can carry
    `name: net0` with `match: link.driver == "virtio_net"` and put its static address on `net0`.
- **Why not names or MACs.**
  - Talos names interfaces "same way as `systemd`": on-board index (`eno`), then hotplug slot
    (`ens`), then PCI path (`enp`), then MAC (`enx<MAC>`)
    ([Predictable Interface Names](https://docs.siderolabs.com/talos/v1.14/networking/predictable-interface-names)).
  - Cloud Hypervisor v53 exposes ACPI hotplug slots with a `_SUN` for each PCI device
    ([`pci_segment.rs#L289-L296`](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/v53.0/vmm/src/pci_segment.rs#L289-L296)).
    So on Cloud Hypervisor the NIC likely gets an `ens<N>` name, where N depends on how many
    devices come before it (Intar adds 3 or 4 disks before the NIC). On QEMU q35 it got
    `enp0s2` in Talos's own example. Both points are inferred. **Spike item:** record the
    actual names on each VMM.
  - `net.ifnames=0` gives `eth0`. Talos says that is "not stable across reboots" with several
    NICs, but Intar has one, so it is an alternative to the alias (same doc).
  - The MAC changes on every launch, so `permanent_addr` or `hardwareAddr` selectors and the
    `enx<MAC>` name are unusable.
- **The older v1alpha1 `deviceSelector`** also has a `driver` qualifier (documented through v1.12,
  [device selector](https://www.talos.dev/v1.12/talos-guides/network/device-selector)). The v1.14
  docs lead with `LinkAliasConfig`; prefer it.
- **`ip=` kernel argument.**
  - The format is `ip=<client-ip>:<server-ip>:<gw-ip>:<netmask>:<hostname>:<device>:<autoconf>:<dns0-ip>:<dns1-ip>:<ntp0-ip>`.
    Talos uses it "as the initial network configuration", for environments "where DHCP doesn't
    provide IP addresses"
    ([kernel reference](https://docs.siderolabs.com/talos/v1.14/reference/kernel)).
  - It applies "before the machine configuration can be fetched". The docs note that "Kernel
    command line parameters are not persisted after Talos installation"
    ([bare-metal network config](https://docs.siderolabs.com/talos/v1.14/platform-specific-installations/bare-metal-platforms/network-config)).
    With direct kernel boot, Intar passes the cmdline on every boot, so the "not persisted"
    caveat only bites if a kexec reboot swaps the cmdline (section 2).
  - With an empty `<device>`, Talos picks the first non-loopback interface by name, which is
    the only NIC on an Intar VM
    ([`cmdline.go#L198-L213`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/network/cmdline.go#L198-L213)).
    Device names, including bond slaves, are resolved through link aliases (same file).
  - Precedence from low to high is `default`, `cmdline`, `platform`, `operator` (DHCP and
    others), `configuration`
    ([network resources](https://docs.siderolabs.com/talos/v1.14/learn-more/networking-resources)).
    Machine config wins over `ip=`.
  - Maintenance mode, where no config has loaded yet, therefore gets its address from `ip=` or
    from DHCP, which Talos runs "on all interfaces which have a link" by default (bare-metal
    network config doc).
- **Builds.** QEMU slirp gives each build VM a private DHCP network with no peer-to-peer
  link, which is not enough to form a 3-node cluster. The cluster has to form on addresses
  identical to the run network (section 6), so the builder needs a shared L2 between the
  three QEMU nodes. This is an Intar constraint, not a Talos source claim.

## 4. Disk and memory

**Answer.** Yes. EPHEMERAL defaults to `grow: true`. On every boot Talos re-reads the GPT
against the current disk size, grows EPHEMERAL into any trailing free space, then grows its
XFS filesystem. The control-plane minimum is 2 GiB RAM, 2 cores and 10 GiB disk; the
recommendation is 4 GiB, 4 cores and 100 GiB. Talos only warns below those values; it
doesn't refuse to boot.

- **Grow.**
  - The EPHEMERAL volume is built with `Grow: ValueOr(true)` and min size from quirks
    ([`system_volumes.go#L120-L124`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/block/internal/volumes/volumeconfig/system_volumes.go#L120-L124)).
  - The docs agree: EPHEMERAL "has a minimum size of 2 GiB and automatically grows to utilize
    the maximum available space on the disk"
    ([system volumes](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/storage-and-disk-management/disk-management/system)).
    On later boots, "If `grow: true` ... Talos will expand the volume to fill available space
    after it"
    ([common fields](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/storage-and-disk-management/disk-management/common)).
  - `Grow` computes the available growth after the partition, extends it and rewrites the GPT
    ([`grow.go`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/block/internal/volumes/grow.go)).
  - The GPT reader recalculates the backup header and last usable LBA from the device's
    current size ("secondary/end values are recalculated from lastLBA"). So space added by
    enlarging the disk becomes visible
    ([`go-blockdevice` v2.0.32 `gpt.go#L260-L298`](https://github.com/siderolabs/go-blockdevice/blob/v2.0.32/partitioning/gpt/gpt.go#L260-L298),
    the version Talos v1.14.5 pins in
    [`go.mod#L144`](https://github.com/siderolabs/talos/blob/v1.14.5/go.mod#L144)).
  - For an existing filesystem with `Grow` set, Talos grows it, using `xfs_growfs` for XFS
    ([`format.go#L80-L87`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/block/internal/volumes/format.go#L80-L87),
    [`makefs/xfs.go#L51-L60`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/makefs/xfs.go#L51-L60)).
  - Volume config "is only applied when the volume has not been provisioned yet", so any
    EPHEMERAL `maxSize` has to be set before the build provisions it (system volumes doc).
  - Growth only works because EPHEMERAL is the last partition on the system disk. Don't add
    user volumes after it on the root disk.
- **Sizes.**
  - [System requirements](https://docs.siderolabs.com/talos/v1.14/getting-started/system-requirements)
    list a control plane at minimum 2 GiB, 2 cores, 10 GiB and recommended 4 GiB, 4 cores,
    100 GiB. A worker is minimum 1 GiB, 1 core, 10 GiB and recommended 2 GiB, 2 cores, 100 GiB.
  - Runtime checks only log warnings
    ([`v1alpha1_sequencer_tasks.go#L135-L215`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/runtime/v1alpha1/v1alpha1_sequencer_tasks.go#L135-L215)).
    For a control plane they compare `MemTotal` with 1848 MiB minus 150 MiB overhead
    (minimum) and 4 GiB minus 150 MiB (recommended). EPHEMERAL is compared with 6 GiB
    ([`pkg/minimal/limits.go`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/minimal/limits.go)).
  - **Against the map.** 2 vCPU per node is the documented control-plane *minimum*, half
    the recommendation, and these nodes also run workloads. The docs give no sizing for
    control planes that run workloads. The spike should measure etcd and API latency and
    learner workloads at 2 vCPU, and pick memory per node. The documented 4 GiB
    recommendation is the sourced starting point.

## 5. Credentials

**Answer.** All CAs (Talos, Kubernetes, etcd, front-proxy) are valid for 10 years from
generation, a hard-coded constant with no flag. The admin client certificate in a generated
`talosconfig` is valid for 1 year. `talosctl gen config` has no TTL flag, but
`talosctl config new --crt-ttl` mints one with any positive TTL. `talosctl gen config` doesn't
produce a kubeconfig at all. `talosctl kubeconfig` mints a fresh admin certificate on every
download, valid for `cluster.adminKubeconfig.certLifetime` (default 1 year). Server
certificates are regenerated by Talos and need no baking.

- **CAs.** `CAValidityTime = 87600 * time.Hour`
  ([`secrets.go#L14-L15`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/generate/secrets/secrets.go#L14-L15)).
  It is used for the etcd, Kubernetes, aggregator and Talos CAs with `NotBefore` set to the
  generation time
  ([`ca.go#L19-L64`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/generate/secrets/ca.go#L19-L64)).
  The `gen config` flags include nothing for CA lifetime or client TTL
  ([`gen/config.go#L438-L462`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/mgmt/gen/config.go#L438-L462)).
- **talosconfig.**
  - The client certificate is generated with `TalosAPIDefaultCertificateValidityDuration`
    ([`talosconfig.go`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/generate/talosconfig.go),
    [`bundle.go#L460-L461`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/generate/secrets/bundle.go#L460-L461)),
    which is `24 * 365` hours
    ([`constants.go#L1396-L1397`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/constants/constants.go#L1396-L1397)).
  - `gen config` only outputs `controlplane`, `worker` and `talosconfig`
    ([`gen/config.go#L44-L48`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/mgmt/gen/config.go#L44-L48)).
  - `talosctl config new --crt-ttl` defaults to the same 1 year
    ([`talos/config.go#L677`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/talos/config.go#L677)).
    The server only rejects a TTL that isn't positive
    ([`v1alpha1_server.go#L2395-L2414`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/internal/server/v1alpha1/v1alpha1_server.go#L2395-L2414)).
  - The docs say the `talosconfig` "should be renewed at least once a year"
    ([certificate management](https://docs.siderolabs.com/talos/v1.14/security/cert-management)).
- **kubeconfig.** "Each time you download the `kubeconfig` file from a Talos Linux cluster, the
  client certificate is regenerated giving you a kubeconfig which is valid for a year"
  (cert-management doc). The lifetime is configurable: `AdminKubeconfigCertLifetime`, "default
  is 1 year"
  ([`v1alpha1_types.go#L1342-L1350`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/types/v1alpha1/v1alpha1_types.go#L1342-L1350),
  [`constants.go#L286-L287`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/constants/constants.go#L286-L287)).
- **Server side.** "Talos Linux automatically manages and rotates all server side
  certificates for etcd, Kubernetes, and the Talos API", but "the kubelet needs to be
  restarted at least once a year" (cert-management doc). Every run cold-boots, so every run
  restarts the kubelet.
- **For the map's "baked certificate expiry" item.** The client certificates are short-lived
  (1 year). A build used for more than a year would hand learners an expired `talosconfig`,
  and any kubeconfig baked at build time has the same horizon. Options the sources support:
  - mint the shared `talosconfig` at build time with `talosctl config new --crt-ttl`, bounded
    by the 10-year CA;
  - re-mint the `talosconfig` and kubeconfig per run from the build's secrets bundle;
  - cap a build's lifetime at under a year.

  That needs a decision.

## 6. Addresses

**Answer.** etcd membership stores each node's **peer URL**, built from its IP. Talos sets it
only when the etcd data directory is empty, and has no command to update it. The member
**name** is the node's hostname. Talos regenerates the Talos API, Kubernetes and etcd server
certificates at boot from the node's current addresses and hostname, so certificates follow
the node. What must stay identical between the QEMU build and every Cloud Hypervisor run, per
node: **the IP address, the hostname, and the control-plane endpoint**.

- **etcd.**
  - The advertised addresses come from `cluster.etcd.advertisedSubnets`, else "the first
    routable address of the node"
    ([`v1alpha1_types.go#L1224-L1244`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/types/v1alpha1/v1alpha1_types.go#L1224-L1244)).
    The spec's `Name` is the hostname
    ([`etcd/spec.go#L201-L204`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/etcd/spec.go#L201-L204)).
  - Talos builds `--initial-cluster` and `--initial-cluster-state` only "when we don't have any
    data"
    ([`services/etcd.go#L569-L600`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/system/services/etcd.go#L569-L600)).
  - etcd only changes a member's peer URLs through an explicit member update followed by a
    restart
    ([etcd v3.7 runtime reconfiguration](https://etcd.io/docs/v3.7/op-guide/runtime-configuration/)).
    `talosctl etcd` offers `members`, `remove-member`, `leave`, `forfeit-leadership`,
    `snapshot`, `defrag`, `status`, `alarm` and `downgrade`, with no update
    ([`talos/etcd.go`](https://github.com/siderolabs/talos/blob/v1.14.5/cmd/talosctl/cmd/talos/etcd.go)).
  - So an IP change between build and run leaves etcd peers advertising unreachable URLs.
- **Certificates.**
  - kube-apiserver SANs come from the endpoint host, `certSANs`, the hostname and FQDN, the
    node's current addresses and 127.0.0.1
    ([`kubernetes_cert_sans.go#L118-L141`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/secrets/kubernetes_cert_sans.go#L118-L141)).
  - etcd certificates are regenerated from the node addresses and hostname once the network is
    ready
    ([`secrets/etcd.go#L83-L178`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/secrets/etcd.go#L83-L178)).
  - Only the CAs (section 5) are baked.
- **Hostname.**
  - The default is `HostnameConfig` `auto: stable`, "a stable hostname based on machine ID",
    such as `talos-2ld-dvw`
    ([Hostname](https://docs.siderolabs.com/talos/v1.14/networking/configuration/hostname)).
  - It is hashed from the node identity
    ([`hostname_config.go#L125-L185`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/network/hostname_config.go#L125-L185)),
    which is cached on STATE
    ([`node_identity.go#L26`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/cluster/node_identity.go#L26)),
    so it survives baking. It does not depend on the MAC.
  - Still, set a static `HostnameConfig` `hostname:` per node so etcd member names and
    Kubernetes node names are readable and fixed in the scenario.
- **Control-plane endpoint.** `cluster.controlPlane.endpoint` is in every machine config and
  in the `talosconfig` and kubeconfig, and its host is in the API server SANs (above). It must
  resolve and be reachable on the run network exactly as at build time.
- **MAC.** Nothing above depends on the MAC once addressing is static and the NIC is selected
  by driver (section 3).
- **Intar consequence.** `ensure_guest_ip_available` rejects a guest IP that any VM on the
  agent already holds, even though each run gets its own bridge. With fixed per-node IPs,
  an agent host can therefore run only one instance of a given cluster scenario at a time,
  unless that check becomes per run network. This is read from code, not exercised.

## Other findings the spike should know

- **Time sync gates etcd and the kubelet.** "Some components like `kubelet` and `etcd` wait for
  the time to be in sync before starting", and the default server is `time.cloudflare.com`
  ([Time Synchronization](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/system-configuration/time-sync)).
  `machine.time.bootTimeout` "Defaults to 'infinity' (waiting forever for time sync)". Talos
  can use the hypervisor's PTP clock via `/dev/ptp_kvm`
  ([`v1alpha1_types.go#L784-L794`](https://github.com/siderolabs/talos/blob/v1.14.5/pkg/machinery/config/types/v1alpha1/v1alpha1_types.go#L784-L794)),
  and the kernel has `CONFIG_PTP_1588_CLOCK_KVM=y`
  ([kernel config](https://github.com/siderolabs/pkgs/blob/f4bda77/kernel/build/config-amd64)).
  Runs keep internet access per the map, but a blocked NTP egress would hang the cluster.
- **Discovery.** The default discovery service is `https://discovery.talos.dev`. "KubeSpan and
  KubePrism require discovery and do not function correctly without it", and "If a node reboots
  while the discovery service is unavailable, it loses all in-memory state"
  ([Discovery Service](https://docs.siderolabs.com/talos/v1.14/configure-your-talos-cluster/system-configuration/discovery)).
  Runs keep internet access, but builds and runs then depend on that external service.
- **Extra disks.** Talos picks EPHEMERAL's disk with `systemDiskMatch()` by default
  ([`system_volumes.go#L117`](https://github.com/siderolabs/talos/blob/v1.14.5/internal/app/machined/pkg/controllers/block/internal/volumes/volumeconfig/system_volumes.go#L117)),
  so Intar's runtime, recordings and tools disks shouldn't be touched. The sources don't
  settle whether Talos tolerates the read-only runtime disk; confirm it in the spike.

## Open points for the spike (#269)

1. **Boot.** Boot the v1.14.5 Image Factory kernel and initramfs on Cloud Hypervisor v53 inside
   an Intar jail, with the Image Factory cmdline plus `console=ttyS0`, against a disk
   installed on QEMU q35. Confirm it reaches the configured state from STATE with no firmware.
2. **ACPI on both VMMs.** Confirm that the `button` module auto-loads and that Talos shuts
   down on Cloud Hypervisor `vm.power-button` and on QEMU QMP `system_powerdown`.
3. **Learner reboot.** With `sysctl.kernel.kexec_load_disabled=1`, or the machine sysctl,
   confirm that `talosctl reboot` becomes a Cloud Hypervisor in-process reset under the jail's
   Landlock and seccomp rules, and that the agent survives it. Without it, record what kexec
   boots and with which cmdline. Note that the serial and console logs are truncated on reset.
4. **Learner shutdown.** Confirm that `talosctl shutdown` makes the Cloud Hypervisor process
   exit as Intar launches it, and decide between `--no-shutdown` plus `vm.boot` and a relaunch.
5. **Interface names.** Record the NIC name Talos assigns on QEMU q35 and on Cloud Hypervisor
   (expected `enp0s*` versus `ens*`). Confirm a `LinkAliasConfig`
   `link.driver == "virtio_net"` with a static address works across MAC changes, and that
   `ip=` with an empty device works in maintenance mode.
6. **Disk growth.** Enlarge a baked disk at run time and confirm EPHEMERAL and its XFS grow on
   boot.
7. **Sizing.** At 2 vCPU per node with workloads, measure etcd and API latency and boot-to-ready
   time, and pick memory per node (the docs recommend 4 GiB).
8. **Addresses.** Cold-boot the baked cluster on the same IPs and hostnames and confirm etcd
   quorum. Optionally confirm that a changed IP breaks it, as the sources predict.
9. **Certificates on old disks.** Confirm the kubelet recovers when the disk's kubelet client
   certificate is older than a year. The docs only say the kubelet must restart yearly to
   rotate.
10. **Time sync.** Confirm boot completes with NTP blocked when `/dev/ptp_kvm` or a
    `bootTimeout` is configured.
