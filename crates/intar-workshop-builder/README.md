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
  every `agent_kvm` checkpoint;
- independently hashes and multipart-uploads every image/kernel/initrd before
  posting one success result;
- for direct-cloud profiles, emits exactly one deterministic,
  content-addressed reconstruction bundle per checkpoint through that same
  generic artifact upload path and hands it to Intar's direct-provider
  verification harness without starting the KVM backend. The harness applies
  the terminal cumulative bundle on one clean persistent verifier VM for each
  declared profile;
  and
- posts one terminal failure and aborts the guest workflow on any non-shutdown
  error. Operator shutdown leaves the claim resumable instead of publishing a
  false terminal failure.

The crate includes the deployable `intar-workshop-builder` binary, the concrete
`KvmWorkshopBackend`, and a fail-closed provider-only backend. The top-level
`execution_mode` selects the host capability:

- `direct_provider_only` is the production mode for direct-cloud publications. It
  requires runtime-bundle signing, claims only manifests declaring
  direct-cloud profiles, and never preflights, constructs, or invokes a KVM backend.
  It forbids authored images, local runtime proof, and `execution.images`.
- `agent_kvm` retains the existing authored-image and local checkpoint path.
  It remains the default for dedicated KVM builder configurations.

`config.example.toml` is the production `direct_provider_only` configuration
and therefore has no `[execution]`, disk, image, QEMU, or KVM setting. Run
`doctor` before enabling the service; `run` performs the same mode-specific
checks before authenticating or claiming a publication:

```console
intar-workshop-builder doctor --config /etc/intar/workshop-builder.toml
intar-workshop-builder run --config /etc/intar/workshop-builder.toml
```

In `agent_kvm` mode, the same binary has an explicit, one-shot authored-base
workflow:

```console
intar-workshop-builder prepare-authored-image \
  --config /etc/intar/workshop-builder.toml
```

It is rejected in `direct_provider_only` mode and is never invoked by `run`,
`run-once`, or publication claiming. The
protected release archive carries the deterministic Platform workshop bundle,
Kino, the sanitizer, their checksum files, and the exact workspace agent.
`[execution.authored_image_preparation]` pins the first three inputs by
SHA-256, selects one image mapping, and names a previously absent output
directory. Preparation clones and expands the separately pinned clean Debian
proof disk, boots it through KVM with a fresh `INTARBUILD` seed, installs only
the curated `runtime/source`, runs the pinned bootstrap and module-00 verifier,
proves the one-commit Git tree and sole Talos host image, sanitizes caches and
machine identity, shuts down through acknowledged QMP, runs repairing and
read-only `e2fsck`, and hashes the complete disk. `disk.raw`,
`provenance.json`, and the three build logs become visible together through
one atomic directory rename. The command refuses to overwrite any existing
output.

Before cloning, both the output and execution-work filesystems must have at
least `minimum_free_space_bytes`, and never less than twice the workshop's
nominal disk size. Use 80 GiB for the 32 GiB Platform image, leaving 16 GiB
beyond the conservative two-disk peak for publication artifacts. A host with
less than that configured budget is rejected before creating a disk. This
check does not replace normal capacity monitoring.

The `agent_kvm` execution mapping is deliberately operator-owned. Each
`workspace.vm.image` resolves to one absolute raw base disk, kernel, initrd and
boot command line in `config.example.toml`. The current runtime accepts only x86_64. The host rejects symlinked or
missing files, an unsafe work root, missing KVM access, missing filesystem
tools, architecture mismatches, and workshops with anything other than one VM
before a build starts. V1 rejects multi-VM workshops explicitly.

## Direct-cloud reconstruction bundles

A production builder for workshops whose HCL declares only direct-cloud profiles uses
`execution_mode = "direct_provider_only"` and requires
`[worker.runtime_bundle_signing]`. Its claim request carries that capability;
the registry filters atomically on the already-validated compiled manifest, so
the builder cannot take an `agent_kvm` publication. The local provider-only
backend is a second fence and returns an error from every VM lifecycle method.
`key_id` is public metadata. The Ed25519
private seed is supplied either by an absolute `private_key_file` or by the
named `private_key_env`; the latter contains standard-base64 for exactly 32
bytes. The key itself must never be written into TOML. Unix key files must be
regular caller-owned files with mode `0600`, or root-owned files with one link,
no access ACL, mode `0640`, and a group matching the caller's non-root primary
group. Production separately provisions
`/etc/intar/workshop-runtime-ed25519` as `root:intar-builder 0640`; that lets
the service account read the seed without owning or replacing it. The
installer never generates or packages this key, validates it when present, and
rejects foreign members of the `intar-builder` group. `doctor`, `run`, and
`run-once` validate a configured key before registry authentication.
Production's protected `WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEY_ID` must exactly
match this `key_id`, and the protected
`WORKSHOP_RUNTIME_BUNDLE_SIGNING_KEYS_JSON` public-key map must contain it.

Each bundle contains a generated `checkpoint.json`, the exact workshop-root
`LICENSE`, the explicitly allowlisted `runtime/source` learner tree,
`runtime/bootstrap.sh`, `runtime/images.lock`,
and the declared catch-up and verify scripts for every ordered module through
the target checkpoint. Every installed file has a digest, mode, and normalized
path in the generated manifest. The completion report names that exact covered
module prefix so the registry can reject mismatched checkpoint claims. Source
traversal rejects symlinks, oversized files, solution/facilitator/presentation
paths, answer-key filenames, tag-only OCI references, and digest references
absent from the image lock. Participant and facilitator Markdown, presenter
notes, hints, solution files, undeclared secret
files, and OCI layer blobs therefore cannot enter a learner bundle. Entries,
metadata, JSON, and compression are deterministic.
The Ed25519 signature covers the exact compressed bytes whose SHA-256 is used
by the generic artifact registry; the terminal checkpoint report sends
`sha256`, `compression`, `signature_b64`, and `signing_key_id`.

Signing alone is not a provider compatibility proof. The builder marks each
signed bundle as awaiting provider verification and reports no KVM image or
local cold-boot claim. The registry pins the CI-published workspace-agent and
Kino digests, then Intar's provider harness creates one clean Debian 13
verifier VM for every declared profile through the organization's matching
encrypted BYOK connection. The
generation-bound workspace agent downloads the exact terminal signed bundle
into tmpfs, runs bootstrap once, then runs every checkpoint's catch-up and
verifier in stable order on that same server. A failed catch-up or verifier
rejects the whole cumulative proof and prevents later steps from running.

The terminal checkpoint is the sole cold-boot verification basis. Earlier
checkpoint artifacts reference that terminal basis and must not claim an
independent cold boot. The registry publishes the immutable revision only
after every profile's cumulative proof succeeds and the harness confirms
deletion of every verifier instance and its provider resources. Each verifier attempt
is a separate publication record: it never becomes a learner workspace,
runtime execution, active slot, terminal route, or scenario data. Its rounded
estimated provider cost remains visible with the publication.
`[execution.runtime_bundle_verification]` is never consulted by the
direct-provider path and must not be used as provider certification evidence.

This publication optimization does not change learner semantics. A normal
learner is provisioned once from checkpoint 00 (or a facilitator-selected
checkpoint for catch-up) and keeps that server while working through released
modules incrementally. Intar does not replace the server at each module.
Checkpoint restore or host recovery is the explicit destructive boundary: it
revokes the old generation, deletes its server resources, and reconstructs a
new server from the selected signed cumulative bundle.

The Platform Engineering revision carries a curated learner source tree and a
reviewed external-image inventory. Its bootstrap starts from clean Debian 13,
requires x86-64, installs the pinned toolchain, gates every registry on DNS,
TLS, HTTPS, and manifest availability, and permits OCI pulls only by digest.
The custom upstream Grafana package was not publicly retrievable when the lock
was generated, so this revision explicitly uses stock Grafana with built-in
Prometheus, Loki, and Jaeger datasources. This source/bundle validation is not
a substitute for the production pilot: Talos-in-Docker, Cilium/eBPF,
privileged BuildKit, all seven browser apps, recovery, and teardown still need
to cold-boot and pass on a real CPX42 learner server.

## Dedicated authored-image contract

The supported preparer starts from the pinned clean Debian 13 proof triple and
constructs a base that contains:

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

The protected release archive includes `deploy/install.sh` and an internal
`deploy/SHA256SUMS`. Stop and drain the existing service, then run
`sudo ./deploy/install.sh --check` followed by the installer as root. It
verifies
QEMU, e2fsprogs, systemd, KVM, the service account, and every packaged file
before changing the host. The idempotent installer creates a non-login
`intar-builder` user in the `kvm` group; installs the builder, workspace agent,
Kino, sanitizer, workshop bundle, unit, and example config at their configured
absolute paths; and makes `/var/lib/intar-workshop-builder` owned by that user
with mode `0750`.

An existing `/etc/intar/workshop-builder.toml` is never replaced: its bytes are
preserved while ownership and mode are normalized to
`root:intar-builder 0640`. The installer refuses an active service or any live
agent, jail daemon, legacy builder, workshop builder, QEMU, or Cloud Hypervisor
process. On a co-located scenario host, drain active learner VMs, stop
`intar-agent.service`, `intar-jailerd.socket`, `intar-jailerd.service`,
`intar-builder.service`, and `intar-workshop-builder.service`, and verify that
none has a pending systemd job. The installer reloads systemd metadata but
never enables or starts a service and never invokes image preparation.

The installer also creates `/var/cache/intar-workshop-builder` as
`root:intar-builder 0750`. Its `clean` child is also root-owned and
non-writable by the service account; separately provisioned proof
disk/kernel/initrd files stay there as root-owned, read-only inputs. Its
`authored` child is `intar-builder:intar-builder 0750`, allowing atomic output
promotion while satisfying the preparer's rejection of group/world-writable
output parents. Start only after an operator reviews the preserved config and
`doctor` passes.

Unit tests use a fake guest/process seam to verify typed lifecycle ordering,
the author-material scrub boundary, cancellation without terminal failure, and
strict stale-staging cleanup. Actual Talos-in-Docker, Cilium/eBPF,
privileged containers, app ports, sanitizer behavior and checkpoint cold boots
still require the Linux/KVM pilot-host E2E; they cannot be proven in a macOS or
sandboxed development environment.
