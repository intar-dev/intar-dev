# intar-builder

Builds the machine images the Worker asks for and pushes them to the registry.
`intar-builder doctor --config /etc/intar-builder/config.toml` checks the host;
`deploy/config.example.toml` lists every setting.

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
