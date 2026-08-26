---
title: Workshop manifest v2 authoring
---

Workshops are standalone Intar content. They do not reference Course catalogs,
Scenarios, assignments, or Scenario runs. Workshop revisions declare their own
modules, agenda, presentation, workspace, checkpoints, applications, and
certified runtime profiles.

Only manifest format 2 is accepted. There is no v1 parser or compatibility
mode.

## Source and hydration

An authored Workshop root contains `workshop.hcl` and every file referenced by
the manifest:

```text
workshop.hcl
content/
  module-00.md
facilitator/
  module-00.md
hints/
  module-00-01.md
solutions/
  module-00.md
scripts/
  verify-00.sh
  catch-up-00.sh
slides/
  slide-001.md
  notes/slide-001.md
assets/
  architecture.png
LICENSE
```

The Platform Engineering Workshop is stored differently because its upstream
source is large. Git tracks only the pinned acquisition and image locks under
`content/workshops/platform-engineering/`. Run:

```sh
bun run hydrate
just check-hydrated
```

Hydration verifies the upstream revision, archive digest, and Apache-2.0 license
before generating `.work/workshops/platform-engineering/`. The generated tree
is disposable and must not be committed. OCI layers are never hydrated or
bundled; learner VMs pull every declared image by digest.

All manifest paths are normalized relative paths. Absolute paths, parent
traversal, symlinks, missing files, unsupported active content, and oversized
files are rejected. A root license is bundled when present.

## Minimal multicloud manifest

The Platform Engineering profile contract is represented by this shape:

```hcl
workshop "platform-engineering-workshop" {
  format_version = 2
  title           = "Platform Engineering Workshop"
  summary         = "Build and operate a small internal developer platform."
  prerequisites   = ["Comfort with a terminal"]
  attribution     = "Adapted from randax/Platform-Engineering-Workshop, Apache-2.0"
  default_lobby_minutes = 30
}

workspace {
  lease_grace_minutes = 60
  initial_checkpoint  = "checkpoint-00"

  vm "learner" {
    cpu_millis = 4000
    memory_mib = 16384
    disk_mib   = 32768
  }

  runtime_profile "hetzner-cpx42" {
    provider     = "hetzner_cloud"
    vm_id        = "learner"
    machine_type = "cpx42"
    system_image = "debian-13"
  }

  runtime_profile "gcp-e2-standard-4" {
    provider       = "gcp_compute"
    vm_id          = "learner"
    machine_type   = "e2-standard-4"
    system_image   = "projects/debian-cloud/global/images/family/debian-13"
    root_disk_type = "pd-balanced"
    locations = [
      "europe-west3-a",
      "europe-west3-b",
      "europe-west3-c",
    ]
  }

  application "gitea" {
    label          = "Gitea"
    vm             = "learner"
    port           = 3000
    protocol       = "http"
    release_module = "02"
  }
}

module "00" {
  tier              = "gate"
  outcome           = "Prove the workspace is ready."
  depends_on        = []
  content           = "content/module-00.md"
  facilitator_notes = "facilitator/module-00.md"
  hints             = ["hints/module-00-01.md"]
  solution          = "solutions/module-00.md"
  explain_back      = "Show a partner the successful preflight."
  verify_script     = "scripts/verify-00.sh"
  catch_up_script   = "scripts/catch-up-00.sh"
  checkpoint        = "checkpoint-00"
  probes            = ["module-00-ready"]
}

agenda "preflight" {
  kind             = "lab"
  duration_minutes = 30
  scheduled        = false
  module           = "00"
  slides           = ["module-00"]
  release          = "automatic"
}

presentation {
  assets = []

  slide "module-00" {
    content         = "slides/slide-001.md"
    presenter_notes = "slides/notes/slide-001.md"
    layout          = "default"
  }
}
```

The VM block expresses workload requirements, not the provider's advertised
shape. CPU is in millicores and memory/disk are in MiB. A runtime profile names
an exact provider type; it does not duplicate provider hardware values.

## Runtime profiles

Every manifest must declare at least one explicitly named profile. Supported
providers are `agent_kvm`, `hetzner_cloud`, and `gcp_compute`.

- `agent_kvm` names an Intar image and uses the organization-runner path.
- `hetzner_cloud` names an exact x86 server type and image.
- `gcp_compute` names an exact x86 machine type, image or image family, boot
  disk policy, and permitted zones.

A direct-cloud profile may reference a Workshop with exactly one VM. The VM ID
is author-defined; `learner` is a convention, not a schema keyword. Agent KVM
Workshops may use the generic multi-VM harness when their content requires it.

Publication resolves and stores:

- exact hardware shape and architecture;
- exact immutable image identity (including resolution of a GCP image family);
- root-disk policy and allowed locations;
- the profile's provider-specific price observation;
- certification evidence and confirmed verifier cleanup.

Unknown, deprecated, ARM, undersized, or mutable unresolved profiles fail
publication. Intar never substitutes a machine type or provider. Changing any
profile creates a new immutable revision. Session creation must select an exact
profile ID and, for direct cloud, a compatible organization connection.

## Checkpoints and learner progression

Each module names a canonical catch-up checkpoint. The publisher applies
catch-up scripts cumulatively on one temporary verifier VM per declared
profile, verifies each checkpoint, reboots and verifies again, then confirms
all verifier resources are deleted.

The resulting checkpoint payload is a signed,
`direct_cloud_linux_x86_64_v1` reconstruction bundle. Compatible Hetzner and
GCP profiles reuse the same content-addressed bundle. It contains no OCI
layers.

A learner stays on one VM while progressing normally. Completing or releasing
a module does not create another VM and does not incur another provider minimum
billing period. Restore and host/provider recovery are the only operations that
create a new generation; progress and audit history remain attached to the
logical Workshop workspace.

## Modules, agenda, and presentation

Module tiers are `gate`, `core`, and `stretch`. Dependencies must exist, form an
acyclic graph, and obey tier ordering. Probe IDs and checkpoint IDs are stable
and unique. Verification is outcome-based; deterministic named probes back the
manual verifier.

Agenda kinds are `briefing`, `lab`, `demo`, `break`, `explain_back`, `tinker`,
and `retro`. Release modes are `facilitator`, `automatic`, and `pool`; pooled
release is for dependency-ready stretch work. The compiler derives total
duration from scheduled agenda items. Unscheduled lobby work does not inflate
the public duration.

Slides, participant material, hints, solutions, and notes are sanitized
Markdown. HCL presentation layouts are `cover`, `default`, `section`,
`statement`, `break`, and `closing`. Raw HTML, JavaScript URLs, Vue components,
active SVG, and remote presentation images are rejected. Mermaid is rendered at
build time.

## Declared applications

An application declares one VM, port, HTTP/WebSocket protocol, label, and
release module. IDs and VM/port pairs are unique. Stargate exposes only declared
applications through isolated `wa-<route>.intar.app` origins and SSH direct
forwarding; it does not publish guest ports.

`upstream_host` is optional for a guest service that selects a virtual host,
such as Knative ingress. It changes only the guest-facing `Host` header. The
public route hostname remains the forwarding hostname and responses are not
rewritten.

## Validate, bundle, and publish

Run authoring commands from the repository root so Rust uses the shared Cargo
cache and root `target/`:

```sh
cargo run -p intar-workshop-cli -- validate path/to/workshop
cargo run -p intar-workshop-cli -- bundle path/to/workshop \
  --output /tmp/workshop.tar.gz
```

Bundles are deterministic: entries are sorted and archive ownership and
timestamps are fixed. Rebuilding unchanged sources produces identical bytes
and SHA-256.

Publishing uses an organization-scoped registry token and HTTPS:

```sh
export INTAR_WORKSHOP_REGISTRY_URL=https://intar.dev
export INTAR_WORKSHOP_PUBLISH_TOKEN=...
cargo run -p intar-workshop-cli -- publish path/to/workshop
cargo run -p intar-workshop-cli -- status PUBLICATION_ID
```

The revision becomes visible only after every profile, checkpoint, probe,
application, cold boot, and verifier deletion check succeeds. Never put BYOK
credentials, provider KEKs, guest bootstrap capabilities, or signing private
keys in Workshop source or publication bundles.
