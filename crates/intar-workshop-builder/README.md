# Intar workshop builder

`intar-workshop-builder` is the trusted, domain-specific publication worker for
standalone workshop revisions. It deliberately does not reuse scenario
metadata. The crate:

- authenticates with the existing builder bootstrap identity;
- atomically claims `/agent/registry/workshop-publications/next`;
- downloads only a same-origin bundle, verifies the claimed SHA-256, extracts
  it with entry and byte limits, and validates it with
  `intar-workshop-manifest`;
- applies catch-up scripts in stable dependency order through the typed
  `WorkshopExecutionBackend` lifecycle;
- requires a successful pre-seal verification, sanitization and acknowledged
  shutdown, sealed raw-zstd artifacts, and a new cold-boot verification for
  every checkpoint;
- independently hashes and multipart-uploads every image/kernel/initrd before
  posting one success result;
- for a `hetzner_cloud` workshop, emits exactly one deterministic,
  content-addressed reconstruction bundle per checkpoint through that same
  generic artifact upload path and separately cold-boots that exact bundle on
  a pinned clean Debian 13 base; and
- posts one terminal failure and aborts the guest workflow on any non-shutdown
  error. Operator shutdown leaves the claim resumable instead of publishing a
  false terminal failure.

The crate includes the deployable `intar-workshop-builder` binary and concrete
`KvmWorkshopBackend`. Run `doctor` before enabling the service; `run` also
performs the same checks before authenticating or claiming a publication:

```console
intar-workshop-builder doctor --config /etc/intar/workshop-builder.toml
intar-workshop-builder run --config /etc/intar/workshop-builder.toml
```

The execution mapping is deliberately operator-owned. Each
`workspace.vm.image` resolves to one absolute raw base disk, kernel, initrd and
boot command line in `config.example.toml`. V1 accepts only x86_64. The host rejects symlinked or
missing files, an unsafe work root, missing KVM access, missing filesystem
tools, architecture mismatches, and workshops with anything other than one VM
before a build starts. V1 rejects multi-VM workshops explicitly.

## Direct-cloud reconstruction bundles

A workshop whose HCL selects `hetzner_cloud` additionally requires
`[worker.runtime_bundle_signing]`. `key_id` is public metadata. The Ed25519
private seed is supplied either by an absolute `private_key_file` or by the
named `private_key_env`; the latter contains standard-base64 for exactly 32
bytes. The key itself must never be written into TOML. Unix key files must be
regular files inaccessible to group and other users. `doctor`, `run`, and
`run-once` validate a configured key before registry authentication.
Production's protected `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID` must exactly
match this `key_id`, and the protected
`WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` public-key map must contain it.

Each bundle contains a generated `checkpoint.json`, the exact workshop-root
`LICENSE`, the explicitly allowlisted `runtime/source` learner tree,
`runtime/bootstrap.sh`, `runtime/images.lock`,
and the declared catch-up and verify scripts for the target module's dependency
closure. Every installed file has a digest, mode, and normalized path in the
generated manifest. Source traversal rejects symlinks, oversized files,
solution/facilitator/presentation paths, answer-key filenames, tag-only OCI
references, and digest references absent from the image lock. Participant and
facilitator Markdown, presenter notes, hints, solution files, undeclared secret
files, and OCI layer blobs therefore cannot enter a learner bundle. Entries,
metadata, JSON, and compression are deterministic.
The Ed25519 signature covers the exact compressed bytes whose SHA-256 is used
by the generic artifact registry; the terminal checkpoint report sends
`sha256`, `compression`, `signature_b64`, and `signing_key_id`.

Signing alone is not a Hetzner compatibility proof. Direct-cloud publishing
also requires `[execution.runtime_bundle_verification]`. It pins a separate
minimal Debian 13 raw disk, kernel, initrd, and the exact statically linked
`intar-workspace-agent` by SHA-256. `doctor` hashes every configured artifact
before registry authentication. For every checkpoint, the builder clones that
clean disk instead of the authored KVM checkpoint, boots it with a fresh seed
and SSH key, uploads the exact just-signed bundle and pinned agent, and invokes
the agent's `verify-bundle` path. That path verifies the digest and
Ed25519 signature, requires tmpfs staging, safely extracts the bundle, applies
the bootstrap and catch-up steps, installs the probe mappings, and runs the
included verifiers. Only an acknowledged shutdown after success produces
`runtime_bundle_cold_boot_verified = true`; the registry independently requires
that explicit field for every `hetzner_cloud` artifact. A legacy sealed-disk
`cold_boot_verified` value can never stand in for it.

The proof disk contains only Debian 13 plus Intar's `INTARBUILD` seed/SSH
bootstrap contract. It must not be the authored workshop image and must not
contain workshop source, pre-pulled OCI layers, or an installed agent copy. The
release archive carries `intar-workspace-agent` and its checksum; install that
exact binary at the configured path. Record the clean disk/kernel/initrd
digests from the operator-controlled image promotion job. Changing any pinned
input fails `doctor` until the configuration is deliberately updated. The
registry also requires the reported agent digest to match the CI-published
guest-tool manifest at publication time and pins its paired Kino digest; later
learner allocation uses those immutable digests rather than the mutable
`current.json` pointer.

The Platform Engineering revision carries a curated learner source tree and a
reviewed external-image inventory. Its bootstrap starts from clean Debian 13,
requires x86-64, installs the pinned toolchain, gates every registry on DNS,
TLS, HTTPS, and manifest availability, and permits OCI pulls only by digest.
The custom upstream Grafana package was not publicly retrievable when the lock
was generated, so this revision explicitly uses stock Grafana with built-in
Prometheus, Loki, and Jaeger datasources. This source/bundle validation is not
a substitute for the production pilot: Talos-in-Docker, Cilium/eBPF,
privileged BuildKit, all seven browser apps, recovery, and teardown still need
to cold-boot and pass on a real CX43 learner server.

## Dedicated authored-image contract

The base disk must be Debian 13 and already contain:

- the Intar `INTARBUILD` seed bootstrap service for the ephemeral SSH key;
- `/usr/local/bin/kino` and the normal Intar runtime supervisor;
- the pinned workshop toolchain and participant repository; `agent_kvm` may
  carry its separately validated image cache, while direct-cloud proof disks
  and runtime bundles carry no OCI layers;
- the fixed sanitizer at the configured `execution.sanitizer_path`; and
- any build-only repository metadata or canonical solve helper only at the
  narrow paths listed in `guest_build_material_paths`.

The backend captures those configured build-only paths once into its private
host work directory. A mutable generation receives them, but the backend
removes every path before sanitization and sealing. Cold-boot proof therefore
runs without them. They are restored only after the next sealed checkpoint is
expanded into a new private mutable generation. The bundle boundary is an
allowlist: only the declared `catch_up_script` and `verify_script` for the
current module can enter the guest. Catch-up scripts use a transient root-only
directory and are deleted after execution and again before sealing. Solutions,
facilitator notes, slides, and participant Markdown are never uploaded from the
source bundle. Any canonical solution tree required by a preinstalled catch-up
helper is trusted base-image build material and must be listed separately in
`guest_build_material_paths`. Every declared manual verify script is installed
at `/usr/local/lib/intar-workshop/verifiers` before checkpoint 00 is sealed and
is retained in all checkpoints; the builder generates `/etc/kino/kino.hcl.tpl`
so every declared probe runs the matching retained verifier.

The dedicated base must not contain an upstream or otherwise unreviewed `.git`
directory, package cache, backup, or second repository copy from which a
learner could recover a removed solve helper. The Platform Engineering image
preparer copies only the runtime bundle's learner-safe source allowlist, runs
its bootstrap, and creates a fresh one-commit `.git` from that curated tree.
That exact `.git` is declared as build material: canonical mutable generations
can seed Gitea, but it is removed before every seal and is absent from every KVM
participant checkpoint. The learner-side seed script recreates an equivalent
fresh repository from the filtered participant tree when module 02 needs it.

`guest_build_material_paths` must enumerate every repository-metadata,
canonical catch-up, solution, answer-key, and facilitator-only path needed
during the build. Every listed path must exist in the authored image, so a
missing path fails publication. Every build-material path must also appear in
the required `guest_forbidden_participant_paths`; that second list must include
the workshop `.git` path and additionally names all lab `solve.sh` and source
README files, facilitator slides, and known backup or duplicate repository
locations. Cold-boot proof fails if any listed path exists, turning this
participant boundary into a publication gate rather than an operator-only
review note. The dedicated image review must still reject an unknown duplicate
outside the explicit inventory.

Every checkpoint follows: catch-up, verify, scrub, fixed sanitizer,
acknowledged QMP guest shutdown, raw-zstd seal, decompression into a fresh raw
disk, fresh seed/key, cold boot, retained-verifier run, and another acknowledged
shutdown. Abort and process-drop paths kill/reap QEMU and delete only the
per-publication temporary directory.

`run` and `run-once` execute registry and build work on a dedicated worker
thread and keep the process signal loop separate. On Unix, either SIGINT or
SIGTERM cancels in-flight registry waits, guest SSH operations, checkpoint
compression, and checkpoint expansion. The worker then kills/reaps any active
QEMU process and drops its private publication directories before exiting.
Cancellation never posts a terminal publication failure; registry claim-lease
recovery can reclaim it safely. The systemd unit uses SIGTERM and retains a
three-minute cgroup kill fallback for an unresponsive external binary.

Before authenticating or claiming work, the builder removes crash leftovers
only from its two preflighted private work roots. Cleanup accepts direct
children whose names match `publication-*` and whose exact private marker was
written by this binary. It rejects `/`, symlinked roots and children, unmarked
directories, nested paths, and unrelated operator data. A forced kill can
therefore leave bounded staging data, which the next start validates and
removes without widening the recursive deletion target.

Install the unit and sanitizer from `deploy/`, install the example config as
`/etc/intar/workshop-builder.toml`, create a non-login `intar-builder` user in
the `kvm` group, and make `/var/lib/intar-workshop-builder` owned by that user
with mode `0750`. The base disk/kernel/initrd should be root-owned, readable
but not writable by the service user. Start only after `doctor` passes.

Unit tests use a fake guest/process seam to verify typed lifecycle ordering,
the author-material scrub boundary, cancellation without terminal failure, and
strict stale-staging cleanup. Actual Talos-in-Docker, Cilium/eBPF,
privileged containers, app ports, sanitizer behavior and checkpoint cold boots
still require the Linux/KVM pilot-host E2E; they cannot be proven in a macOS or
sandboxed development environment.
