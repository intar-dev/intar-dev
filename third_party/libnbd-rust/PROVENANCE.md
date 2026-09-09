# libnbd Rust bindings provenance

This directory is the unmodified `rust/` subtree from libnbd 1.22.2, except
for `libnbd-sys/libnbd_version`. Upstream generates that one-line file during
its own build. Cargo's direct Git dependency cannot build without it.

- Upstream tag: `v1.22.2`
- Upstream commit: `5f55a26f3a776c11049a27154b1f2b59b8c335da`
- Source tarball: `https://download.libguestfs.org/libnbd/1.22-stable/libnbd-1.22.2.tar.gz`
- Tar SHA-256: `bdc403af00fd1c9b5ed20503765496a81c2d0197af550765af3dee196e8519ca`
- Detached signature SHA-256: `0dd24ca3252c16365c52b1232946f078e5278698694133bc918c809cd69b4cc0`
- Signing key fingerprint: `F7774FB1AD074A7E8C8767EA91738F73E1B768A0`
- License: LGPL-2.1-or-later; see `COPYING.LIB`.

Do not edit generated binding code in this directory. Update it only by
replacing the subtree from a verified upstream libnbd release.
