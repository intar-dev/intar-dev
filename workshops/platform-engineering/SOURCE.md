# Source and image contract

This workshop is a native Intar port of
https://github.com/randax/Platform-Engineering-Workshop pinned at
`1b6fad43551a720b143d7a52799f81c4c89455cb`. The upstream work is Apache-2.0 licensed; the complete
license text is retained in `LICENSE` and is included in the deterministic
bundle.

The dedicated Debian 13 guest image must contain a participant-safe snapshot of
the pinned repository at `/opt/platform-engineering-workshop`, the pinned
toolchain, and all non-optional container images and OCI packages. The live learner
path never runs `dev-setup.sh`, `cloudbox-init.sh`, `apt`, or an external image copy.
Busybox and every other base used by a required build must be addressable from the
guest-local mirror; Crossplane's pinned Function xpkg must be mirrored into Zot and
referenced locally before sealing. Participant checkpoints retain manual
`verify.sh` files but exclude `.git`, canonical catch-up/solve material,
solutions, and facilitator-only content. The trusted base additionally carries
the pinned generic catch-up helper and cumulative `solutions/` tree only at the
paths declared in the builder's `guest_build_material_paths`; the builder
captures those paths before checkpointing, scrubs them before every seal, and
restores them only into the next private mutable build generation. The image
must also provide loopback browser adapters for the RustFS console on
port 30901 and the workshop's fixed Knative service on port 31081. These
adapters do not publish host ports; Stargate reaches them via SSH direct
forwarding.

Browser use is limited to the seven applications declared in `workshop.hcl`:
Gitea, Argo CD, RustFS, Knative, Zot, Cloudbox Console, and Grafana. Participant
copy uses those Intar app buttons. `localhost` appears only in in-guest terminal/API
commands. Backstage, Kagent's own UI/API, arbitrary workloads, and raw NodePorts are
not browser routes in v1.

All verified module paths work offline. External AI is an explicit optional
comparison in modules 05 and 10: it is never timed, probed, or needed for solution,
helper, checkpoint, or verifier completion, and its credentials/connectivity are
outside the workshop contract.

The source importer intentionally converts Slidev HTML/Vue presentation syntax
to Intar's finite native Markdown layouts and separates every HTML speaker-note
comment into its corresponding presenter-notes file. The generated deck must
remain exactly 85 slides. CI regenerates the raw import from the pinned commit
and locks both trees plus their explicit Intar-adaptation delta; an intentional
source or adaptation change must update that reviewed lock.
