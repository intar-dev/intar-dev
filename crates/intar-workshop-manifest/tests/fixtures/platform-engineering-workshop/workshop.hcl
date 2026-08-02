workshop "platform-engineering-workshop" {
  format_version = 2
  title          = "Platform Engineering Workshop"
  summary        = "Build and operate a small internal developer platform."
  prerequisites  = ["Comfort with a terminal", "Basic Kubernetes concepts"]
  attribution    = "Adapted from randax/Platform-Engineering-Workshop, Apache-2.0"
  default_lobby_minutes = 30
}

workspace {
  lease_grace_minutes = 60
  initial_checkpoint  = "checkpoint-00"

  vm "workspace" {
    cpu_millis  = 4000
    memory_mib   = 16384
    disk_mib     = 32768
  }

  runtime_profile "hetzner-cpx42" {
    provider      = "hetzner_cloud"
    vm_id         = "workspace"
    machine_type  = "cpx42"
    system_image  = "debian-13"
  }

  runtime_profile "gcp-e2-standard-4" {
    provider       = "gcp_compute"
    vm_id          = "workspace"
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
    vm             = "workspace"
    port           = 3000
    protocol       = "http"
    release_module = "02"
  }

  application "argocd" {
    label          = "Argo CD"
    vm             = "workspace"
    port           = 8080
    protocol       = "http"
    release_module = "02"
  }

  application "rustfs" {
    label          = "RustFS"
    vm             = "workspace"
    port           = 9001
    protocol       = "http"
    release_module = "03"
  }

  application "knative" {
    label          = "Knative"
    vm             = "workspace"
    port           = 8081
    protocol       = "http"
    release_module = "06"
  }

  application "zot" {
    label          = "Zot"
    vm             = "workspace"
    port           = 5000
    protocol       = "http"
    release_module = "07"
  }

  application "cloudbox" {
    label          = "Cloudbox Console"
    vm             = "workspace"
    port           = 4173
    protocol       = "http"
    release_module = "08"
  }

  application "grafana" {
    label          = "Grafana"
    vm             = "workspace"
    port           = 3001
    protocol       = "http"
    release_module = "10"
  }
}

module "00" {
  tier              = "gate"
  outcome           = "Prove the local toolchain and workshop workspace are ready."
  depends_on        = []
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Show your partner the successful preflight result."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-00"
  probes            = ["module-00-ready"]
}

module "01" {
  tier              = "core"
  outcome           = "Run Talos and Cilium in the workshop workspace."
  depends_on        = ["00"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Explain which layer owns cluster networking."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-01"
  probes            = ["module-01-cluster"]
}

module "02" {
  tier              = "core"
  outcome           = "Reconcile an application through Gitea and Argo CD."
  depends_on        = ["01"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Trace one change from Git to the cluster."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-02"
  probes            = ["module-02-gitops"]
}

module "03" {
  tier              = "core"
  outcome           = "Provide PostgreSQL and object storage as platform services."
  depends_on        = ["02"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Explain the service ownership boundary."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-03"
  probes            = ["module-03-data-services"]
}

module "04" {
  tier              = "core"
  outcome           = "Compose a self-service platform API with Crossplane."
  depends_on        = ["03"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Describe the contract exposed to an application team."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-04"
  probes            = ["module-04-crossplane"]
}

module "05" {
  tier              = "core"
  outcome           = "Diagnose and repair an injected platform fault."
  depends_on        = ["04"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Support the diagnosis with observable evidence."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-05"
  probes            = ["module-05-repaired"]
}

module "06" {
  tier              = "stretch"
  outcome           = "Deploy a serverless workload with Knative."
  depends_on        = ["05"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Explain scale-to-zero and its tradeoff."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-06"
  probes            = ["module-06-knative"]
}

module "07" {
  tier              = "stretch"
  outcome           = "Build and publish an image with Argo Workflows and Zot."
  depends_on        = ["06"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Trace the artifact supply chain."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-07"
  probes            = ["module-07-build"]
}

module "08" {
  tier              = "stretch"
  outcome           = "Expose the platform through the Cloudbox Console."
  depends_on        = ["07"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Show how the interface maps to platform APIs."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-08"
  probes            = ["module-08-console"]
}

module "09" {
  tier              = "stretch"
  outcome           = "Ship the picture pipeline capstone end to end."
  depends_on        = ["08"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Narrate the capstone data flow."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-09"
  probes            = ["module-09-capstone"]
}

module "10" {
  tier              = "stretch"
  outcome           = "Exercise a day-two platform operation."
  depends_on        = ["09"]
  content           = "content/lab.md"
  facilitator_notes = "content/facilitator.md"
  hints             = ["content/hint.md"]
  solution          = "content/solution.md"
  explain_back      = "Explain the operational signal and response."
  verify_script     = "scripts/verify.sh"
  catch_up_script   = "scripts/catch-up.sh"
  checkpoint        = "checkpoint-10"
  probes            = ["module-10-day-two"]
}

agenda "preflight" {
  kind             = "lab"
  duration_minutes = 30
  scheduled        = false
  module           = "00"
  slides           = ["module-00"]
  release          = "automatic"
}

agenda "opening" {
  kind             = "briefing"
  duration_minutes = 15
  slides           = ["cover", "opening"]
}

agenda "module-01" {
  kind             = "lab"
  duration_minutes = 35
  module           = "01"
  slides           = ["module-01"]
}

agenda "module-02" {
  kind             = "lab"
  duration_minutes = 35
  module           = "02"
  slides           = ["module-02"]
}

agenda "module-03" {
  kind             = "lab"
  duration_minutes = 35
  module           = "03"
  slides           = ["module-03"]
}

agenda "break-1" {
  kind             = "break"
  duration_minutes = 10
  slides           = ["break"]
}

agenda "module-04" {
  kind             = "lab"
  duration_minutes = 35
  module           = "04"
  slides           = ["module-04"]
}

agenda "module-05" {
  kind             = "lab"
  duration_minutes = 25
  module           = "05"
  slides           = ["module-05"]
}

agenda "break-2" {
  kind             = "break"
  duration_minutes = 10
  slides           = ["break"]
}

agenda "module-06" {
  kind             = "lab"
  duration_minutes = 6
  module           = "06"
  slides           = ["module-06"]
  release          = "pool"
}

agenda "module-07" {
  kind             = "lab"
  duration_minutes = 6
  module           = "07"
  slides           = ["module-07"]
  release          = "pool"
}

agenda "module-08" {
  kind             = "lab"
  duration_minutes = 6
  module           = "08"
  slides           = ["module-08"]
  release          = "pool"
}

agenda "module-09" {
  kind             = "lab"
  duration_minutes = 6
  module           = "09"
  slides           = ["module-09"]
  release          = "pool"
}

agenda "module-10" {
  kind             = "lab"
  duration_minutes = 6
  module           = "10"
  slides           = ["module-10"]
  release          = "pool"
}

agenda "closing" {
  kind             = "retro"
  duration_minutes = 10
  slides           = ["closing"]
}

presentation {
  assets = []

  slide "cover" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
    layout          = "cover"
  }

  slide "opening" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
    layout          = "section"
  }

  slide "module-00" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-01" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-02" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-03" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-04" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-05" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-06" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-07" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-08" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-09" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "module-10" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
  }

  slide "break" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
    layout          = "break"
  }

  slide "closing" {
    content         = "slides/shared.md"
    presenter_notes = "slides/notes.md"
    layout          = "closing"
  }
}
