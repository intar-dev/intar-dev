# intar-builder

The builder runs on a builder host. It holds a WebSocket to the website, like
the agent, builds the machine images the control plane asks for, and pushes
them to the registry.

It is the fallback. A scenario repository normally builds its own images in
its pipeline with [`intar-image-cli`](../intar-image-cli), and the builder
builds only for a scenario source that is not set up that way. Both use the
same build code, [`crates/intar-image-build`](../intar-image-build).

```bash
intar-builder run --config /etc/intar-builder/config.toml      # the service
intar-builder doctor --config /etc/intar-builder/config.toml   # check the host, then exit
```

[`deploy/config.example.toml`](deploy/config.example.toml) lists every
setting. The binary has no `--version`; releases are told apart by their
SHA-256. Rolling one out is described in [`RELEASING.md`](../../RELEASING.md).

## arm64 images

A builder is an amd64 host. It also builds the arm64 image of each machine, by
emulation, after the amd64 one and in the same job, when `qemu-system-aarch64`
is installed beside `qemu.qemu_binary`, the kernel runs arm64 programs
(`qemu-user-static` registers that), and `qemu.layered.debian_image_arm64` is
pinned. The `arm64 images` line of `doctor` says whether it does and what is
missing. A job whose arm64 image fails has still succeeded: learners on amd64
hosts and computers are not held up by it, and the failure is in the build's
log and on its row.

## The guest kernel

The builder does not compile the guest kernel. A base image build downloads
the kernel that `kernel.yml` built and published as a release of this
repository, and BuildKit refuses the file unless it has the checksum pinned in
`crates/intar-image-build/src/kernel.rs`. The host therefore needs to reach
GitHub's release downloads when it builds a base image that is not in its
caches. `qemu.layered.kernel_build_jobs` is still read from the configuration
and no longer used.
