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
  posting one success result; and
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

## Dedicated guest contract

The base disk must be Debian 13 and already contain:

- the Intar `INTARBUILD` seed bootstrap service for the ephemeral SSH key;
- `/usr/local/bin/kino` and the normal Intar runtime supervisor;
- the pinned workshop toolchain, participant repository and offline images;
- the fixed sanitizer at the configured `execution.sanitizer_path`; and
- any canonical solve helper only at the narrow paths listed in
  `guest_build_material_paths`.

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

The dedicated base must not contain a `.git` directory, package cache, backup,
or second repository copy from which a learner could recover a removed solve
helper. `guest_build_material_paths` must enumerate every canonical catch-up,
solution, answer-key, and facilitator-only path needed during the build. A
missing helper fails publication. Every build-material path must also appear in
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
