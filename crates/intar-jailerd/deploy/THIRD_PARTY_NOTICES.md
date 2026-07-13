# Third-party notices

## Cloud Hypervisor v53.0

The scenario-host archive redistributes the unmodified static Cloud Hypervisor
v53.0 executable published by the Cloud Hypervisor project.

- Project and source: <https://github.com/cloud-hypervisor/cloud-hypervisor>
- Release: <https://github.com/cloud-hypervisor/cloud-hypervisor/releases/tag/v53.0>
- Source commit: `9ed824d6d08df3e96f7d5f50795d9449ac99f431`
- Executable SHA-256: `448af3d4e59b22c2987f7df94c213ad40fb53a10d437e42b5ee6c4fce7c29ecc`

The archive includes the upstream v53.0 `LICENSES` directory verbatim under
`deploy/cloud-hypervisor-LICENSES/`.

## Statically linked Rust dependencies

`intar-agent`, `intar-jailerd`, and `intar-jailer` contain third-party Rust
crates. The release workflow derives their exact transitive package names,
versions, declared licenses, repositories, and Cargo sources from the locked
workspace graph. That inventory is shipped as
`deploy/intar-rust-dependencies.json` and installed alongside this notice.

## Downloaded self-test fixtures

The operational self-test wrapper does not redistribute guest boot fixtures.
It downloads the following publisher artifacts directly into a root-only host
cache (or consumes the same pre-seeded bytes in `--offline` mode) and verifies
their immutable SHA-256 digests before use:

- Cloud Hypervisor test Linux kernel `ch-release-v6.16.9-20260508`:
  <https://github.com/cloud-hypervisor/linux/releases/tag/ch-release-v6.16.9-20260508>,
  SHA-256 `9d3570b47d5abb069ca00edfbfcef4c68306a9c3d078a01f10082b258f1001b8`.
  Linux is licensed under GPL-2.0-only; corresponding source and license
  information are provided by the publisher repository at
  <https://github.com/cloud-hypervisor/linux>.
- Alpine Linux 3.11.3 x86_64 minirootfs:
  <https://dl-cdn.alpinelinux.org/alpine/v3.11/releases/x86_64/>, SHA-256
  `8a6c827f137058ac3e3df1125891ff5c3b62955f0b911adec26eae6ea2bbb285`.
  Package source and license records are available from
  <https://www.alpinelinux.org/about/> and
  <https://git.alpinelinux.org/aports/>.
