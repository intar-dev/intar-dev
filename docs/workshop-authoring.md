# Workshop authoring

Workshops are standalone Intar content. A workshop does not reference a course,
scenario, assignment, or scenario run. Its only shared platform dependency is
the domain-neutral VM runtime used to create each learner workspace.

## Source layout

An authoring root contains _workshop.hcl_ and every file referenced from it:

```text
workshop.hcl
content/
  module-00.md
  module-00-facilitator.md
  module-00-hint-1.md
  module-00-solution.md
scripts/
  verify.sh
  catch-up.sh
slides/
  cover.md
  cover-notes.md
assets/
  architecture.png
```

Source paths must be normalized relative paths. Absolute paths, parent
traversal, symlinks, missing files, unsupported extensions, and files larger
than 8 MiB are rejected. Only referenced sources enter the bundle, plus a root
`LICENSE` file when present so attribution travels with every revision.

## Manifest shape

_workshop.hcl_ has exactly one workshop, workspace, and presentation block,
plus ordered module and agenda blocks:

```hcl
workshop "platform-engineering-workshop" {
  format_version = 1
  title          = "Platform Engineering Workshop"
  summary        = "Build and operate a small internal developer platform."
  prerequisites  = ["Comfort with a terminal"]
  attribution    = "Adapted from randax/Platform-Engineering-Workshop, Apache-2.0"
  default_lobby_minutes = 30
}

workspace {
  lease_grace_minutes = 60
  initial_checkpoint  = "checkpoint-00"

  vm "workspace" {
    image        = "platform-workshop-debian13"
    vcpu_millis = 4000
    memory_mib   = 16384
    disk_gib     = 100
  }

  application "gitea" {
    label          = "Gitea"
    vm             = "workspace"
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
  facilitator_notes = "content/module-00-facilitator.md"
  hints             = ["content/module-00-hint-1.md"]
  solution          = "content/module-00-solution.md"
  explain_back      = "Show your partner the successful preflight."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
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
  assets = ["assets/architecture.png"]

  slide "module-00" {
    content         = "slides/module-00.md"
    presenter_notes = "slides/module-00-notes.md"
    layout          = "default"
  }
}
```

Supported module tiers are _gate_, _core_, and _stretch_. Supported agenda
kinds are _briefing_, _lab_, _demo_, _break_, _explain_back_, _tinker_, and
_retro_; release modes are _facilitator_, _automatic_, and _pool_. Pool release
is reserved for stretch modules. Agenda items default to scheduled; the
compiler derives the public session duration from scheduled items only.
`default_lobby_minutes` is required and controls how many minutes before the
scheduled start a session lobby opens when the session creator does not supply
an explicit lobby time. Values from 0 through 1440 are accepted.

Application protocols are _http_ and _ws_. Stargate terminates the public TLS
connection and reaches both transports through an HTTP/1.1 SSH direct-forward;
guest-side _https_ and _wss_ are rejected in v1. Application IDs and VM/port
pairs must be unique, and every application must name the module that releases
it. VM CPU is expressed in millicores in increments of 250.

Slide layouts are deliberately finite: _cover_, _default_, _section_,
_statement_, _break_, and _closing_. Slide, participant, hint, solution, and
presenter-note sources are Markdown. Mermaid fences are allowed, but raw HTML,
Vue components/directives, JavaScript URLs, and active SVG content are rejected.
Images must be declared, bundled presentation assets and must use inline
Markdown image targets; remote and reference-style images are rejected.
Ordinary external attribution links remain supported. Rendering must sanitize
links again at runtime as a defense in depth.

All IDs use lowercase ASCII letters, digits, and hyphens. Module dependencies
must resolve, remain within the same or an earlier tier, and form an acyclic
graph. Module probe IDs and checkpoint IDs are globally unique.

The compact checked-in reference under
_crates/intar-workshop-manifest/tests/fixtures/platform-engineering-workshop_
models modules 00 through 10 and the derived 240-minute schedule without
vendoring the upstream slide deck.

## CLI

Run the focused commands from the repository root:

```sh
cargo run -p intar-workshop-cli -- validate path/to/workshop
cargo run -p intar-workshop-cli -- bundle path/to/workshop
cargo run -p intar-workshop-cli -- bundle path/to/workshop --output dist/workshop.tar.gz
```

Bundles are deterministic gzip-compressed tar archives. Entries are sorted and
have fixed owner, group, and timestamp metadata. The archive contains the safe
source set and _workshop.compiled.json_, a normalized manifest with the
compiler-derived duration. Rebuilding unchanged sources produces identical
bytes and a stable SHA-256 digest.

Publishing requires an organization-scoped token:

```sh
export INTAR_WORKSHOP_REGISTRY_URL=https://intar.dev
export INTAR_WORKSHOP_PUBLISH_TOKEN=...
cargo run -p intar-workshop-cli -- publish path/to/workshop
cargo run -p intar-workshop-cli -- status PUBLICATION_ID
```

Publish sends a bearer-authenticated multipart request to
POST _/registry/v1/workshop-bundles_. The bundle part is _application/gzip_;
workshop_id and sha256 text fields accompany it. A successful response is a
JSON object containing publication_id and may contain status and status_url.
Status reads GET _/registry/v1/workshop-bundles/:publication_id_ with the same
token. Remote registries must use HTTPS; plain HTTP is accepted only for
localhost.
