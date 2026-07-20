workshop "platform-engineering-workshop" {
  format_version = 1
  title          = "Cloud on Your Terms — Platform Engineering Workshop"
  summary        = "Build and operate a sovereign cloud-native platform in one persistent Intar workspace."
  prerequisites  = ["Comfort with a terminal", "Basic Kubernetes concepts"]
  attribution    = "Adapted from randax/Platform-Engineering-Workshop at 1b6fad43551a720b143d7a52799f81c4c89455cb, Apache-2.0: https://github.com/randax/Platform-Engineering-Workshop/tree/1b6fad43551a720b143d7a52799f81c4c89455cb"
  default_lobby_minutes = 30
}

workspace {
  lease_grace_minutes = 60
  initial_checkpoint  = "checkpoint-00"

  vm "workspace" {
    image        = "platform-engineering-workshop-debian13-1b6fad4"
    vcpu_millis = 4000
    memory_mib   = 16384
    disk_gib     = 100
  }

  application "gitea" {
    label          = "Gitea"
    vm             = "workspace"
    port           = 30300
    protocol       = "http"
    release_module = "02"
  }

  application "argocd" {
    label          = "Argo CD"
    vm             = "workspace"
    port           = 30080
    protocol       = "http"
    release_module = "02"
  }

  application "rustfs" {
    label          = "RustFS"
    vm             = "workspace"
    port           = 30901
    protocol       = "http"
    release_module = "03"
  }

  application "knative" {
    label          = "Knative"
    vm             = "workspace"
    port           = 31081
    protocol       = "http"
    release_module = "06"
  }

  application "zot" {
    label          = "Zot Registry"
    vm             = "workspace"
    port           = 30500
    protocol       = "http"
    release_module = "07"
  }

  application "cloudbox" {
    label          = "Cloudbox Console"
    vm             = "workspace"
    port           = 30600
    protocol       = "http"
    release_module = "08"
  }

  application "grafana" {
    label          = "Grafana"
    vm             = "workspace"
    port           = 30030
    protocol       = "http"
    release_module = "09"
  }

}

module "00" {
  tier              = "gate"
  outcome           = "Prove the pre-baked Debian 13 workspace, pinned toolchain, and offline image cache are ready."
  depends_on        = []
  content           = "content/module-00.md"
  facilitator_notes = "facilitator/module-00.md"
  hints             = ["hints/module-00-01.md", "hints/module-00-02.md", "hints/module-00-03.md", "hints/module-00-04.md"]
  solution          = "content/module-00-solution.md"
  explain_back      = "Tell your neighbor: why does this workshop refuse to install tools or pull images during\nthe session? (One reason is reliability; the other is the platform-sovereignty message.)"
  verify_script     = "scripts/verify-00.sh"
  catch_up_script   = "scripts/catch-up-00.sh"
  checkpoint        = "checkpoint-00"
  probes            = ["module-00-workspace-ready"]
}

module "01" {
  tier              = "core"
  outcome           = "Run a two-node Talos Kubernetes cluster with Cilium eBPF networking and no kube-proxy."
  depends_on        = ["00"]
  content           = "content/module-01.md"
  facilitator_notes = "facilitator/module-01.md"
  hints             = ["hints/module-01-01.md", "hints/module-01-02.md", "hints/module-01-03.md", "hints/module-01-04.md"]
  solution          = "content/module-01-solution.md"
  explain_back      = "Tell your neighbor: this node has no SSH and no package manager. Name two concrete\n*operational* problems that design deletes (think: patching, drift, attack surface, \"who\nchanged what\")."
  verify_script     = "scripts/verify-01.sh"
  catch_up_script   = "scripts/catch-up-01.sh"
  checkpoint        = "checkpoint-01"
  probes            = ["module-01-talos-cilium-ready"]
}

module "02" {
  tier              = "core"
  outcome           = "Push a commit to the in-cluster Gitea server and watch Argo CD reconcile it."
  depends_on        = ["01"]
  content           = "content/module-02.md"
  facilitator_notes = "facilitator/module-02.md"
  hints             = ["hints/module-02-01.md", "hints/module-02-02.md", "hints/module-02-03.md", "hints/module-02-04.md", "hints/module-02-05.md"]
  solution          = "content/module-02-solution.md"
  explain_back      = "Tell your neighbor: in step 4 your manual edit was reverted. Walk through *who* reverted\nit and *how it knew* — repo, root app, demo app, self-heal. Bonus: why is the git server\nbeing in-cluster a sovereignty feature and not just a demo trick?"
  verify_script     = "scripts/verify-02.sh"
  catch_up_script   = "scripts/catch-up-02.sh"
  checkpoint        = "checkpoint-02"
  probes            = ["module-02-gitops-reconciled"]
}

module "03" {
  tier              = "core"
  outcome           = "Provision PostgreSQL and S3-compatible object storage as platform services."
  depends_on        = ["02"]
  content           = "content/module-03.md"
  facilitator_notes = "facilitator/module-03.md"
  hints             = ["hints/module-03-01.md", "hints/module-03-02.md", "hints/module-03-03.md", "hints/module-03-04.md", "hints/module-03-05.md"]
  solution          = "content/module-03-solution.md"
  explain_back      = "Tell your neighbor: when you pushed `postgres-cluster.yaml`, list the chain of actors that\nturned 30 lines of YAML into a running Postgres (git → ? → ? → pods, PVC, Services,\nSecrets). Which of those actors did *you* install, and via what?"
  verify_script     = "scripts/verify-03.sh"
  catch_up_script   = "scripts/catch-up-03.sh"
  checkpoint        = "checkpoint-03"
  probes            = ["module-03-data-services-ready"]
}

module "04" {
  tier              = "core"
  outcome           = "Turn one Crossplane claim into a database and bucket through a self-service API."
  depends_on        = ["03"]
  content           = "content/module-04.md"
  facilitator_notes = "facilitator/module-04.md"
  hints             = ["hints/module-04-01.md", "hints/module-04-02.md", "hints/module-04-03.md", "hints/module-04-04.md"]
  solution          = "content/module-04-solution.md"
  explain_back      = "Tell your neighbor: your teammate asks \"why not just give developers the CNPG YAML from\nmodule 03 — it was only 30 lines?\" Give the two strongest answers you have. (Think:\nwhat can you change later without touching developers? what can developers *not* do\nthrough this API?)"
  verify_script     = "scripts/verify-04.sh"
  catch_up_script   = "scripts/catch-up-04.sh"
  checkpoint        = "checkpoint-04"
  probes            = ["module-04-crossplane-composed"]
}

module "05" {
  tier              = "core"
  outcome           = "Diagnose a seeded fault and prove the repair against live cluster state."
  depends_on        = ["04"]
  content           = "content/module-05.md"
  facilitator_notes = "facilitator/module-05.md"
  hints             = ["hints/module-05-01.md", "hints/module-05-02.md", "hints/module-05-03.md", "hints/module-05-04.md"]
  solution          = "content/module-05-solution.md"
  explain_back      = "Tell your neighbor about fault 4 (or your favorite): what was the *first* diagnosis on\nthe table, which single command killed or confirmed it, and what would have happened if\nyou'd applied the fix for the wrong diagnosis?"
  verify_script     = "scripts/verify-05.sh"
  catch_up_script   = "scripts/catch-up-05.sh"
  checkpoint        = "checkpoint-05"
  probes            = ["module-05-debugging-verified"]
}

module "06" {
  tier              = "stretch"
  outcome           = "Cold-start a Knative service from zero and observe it scale back to zero."
  depends_on        = ["05"]
  content           = "content/module-06.md"
  facilitator_notes = "facilitator/module-06.md"
  hints             = ["hints/module-06-01.md", "hints/module-06-02.md", "hints/module-06-03.md", "hints/module-06-04.md"]
  solution          = "content/module-06-solution.md"
  explain_back      = "Tell your neighbor: between your `curl` hitting :31080 and a `Hello ...!` coming back\nfrom a pod that didn't exist — what had to happen, in order? (Ingress → ? → pod; who\nbuffered your request while the pod started?)"
  verify_script     = "scripts/verify-06.sh"
  catch_up_script   = "scripts/catch-up-06.sh"
  checkpoint        = "checkpoint-06"
  probes            = ["module-06-knative-scale-to-zero"]
}

module "07" {
  tier              = "stretch"
  outcome           = "Build an image inside the cluster with Argo Workflows and BuildKit, push it to Zot, and run it."
  depends_on        = ["05"]
  content           = "content/module-07.md"
  facilitator_notes = "facilitator/module-07.md"
  hints             = ["hints/module-07-01.md", "hints/module-07-02.md", "hints/module-07-03.md", "hints/module-07-04.md"]
  solution          = "content/module-07-solution.md"
  explain_back      = "Tell your neighbor: list every network hop in your pipeline (git clone from ? → build\nruns where? → push to ? → kubelet pulls from ?). How many of those left your Intar\nworkspace? That's the sovereignty argument in one answer."
  verify_script     = "scripts/verify-07.sh"
  catch_up_script   = "scripts/catch-up-07.sh"
  checkpoint        = "checkpoint-07"
  probes            = ["module-07-in-cluster-build-published"]
}

module "08" {
  tier              = "stretch"
  outcome           = "Create a database through the readable Cloudbox Console developer portal."
  depends_on        = ["05"]
  content           = "content/module-08.md"
  facilitator_notes = "facilitator/module-08.md"
  hints             = ["hints/module-08-01.md", "hints/module-08-02.md", "hints/module-08-03.md", "hints/module-08-04.md"]
  solution          = "content/module-08-solution.md"
  explain_back      = "Tell your neighbor: your module-04 database went `git push → ArgoCD → Crossplane`; the\nconsole's database went `form → Kubernetes API → Crossplane`, skipping git entirely.\nWhat did you lose by skipping git? (Who can delete `console-db`, and would anything bring\nit back?) When is a direct-to-API portal the right trade, and when must the form write to\ngit instead?"
  verify_script     = "scripts/verify-08.sh"
  catch_up_script   = "scripts/catch-up-08.sh"
  checkpoint        = "checkpoint-08"
  probes            = ["module-08-cloudbox-console-ready"]
}

module "09" {
  tier              = "stretch"
  outcome           = "Upload a picture and trace its event-driven resize, metadata, and storage pipeline end to end."
  depends_on        = ["06", "08"]
  content           = "content/module-09.md"
  facilitator_notes = "facilitator/module-09.md"
  hints             = ["hints/module-09-01.md", "hints/module-09-02.md", "hints/module-09-03.md", "hints/module-09-04.md", "hints/module-09-05.md", "hints/module-09-06.md"]
  solution          = "content/module-09-solution.md"
  explain_back      = "Tell your neighbor: why does the uploader POST an event to a Broker instead of just\ncalling the resizer's URL — what breaks, and what becomes possible, under each design?\n(Think: adding a third consumer; deploying a broken resizer.) And when the resizer is\ndown, *where exactly* does the event wait — and what would take that waiting event to\nproduction grade?"
  verify_script     = "scripts/verify-09.sh"
  catch_up_script   = "scripts/catch-up-09.sh"
  checkpoint        = "checkpoint-09"
  probes            = ["module-09-picture-pipeline-complete"]
}

module "10" {
  tier              = "stretch"
  outcome           = "Recover a broken release with a durable Git revert and verify stable day-two operation."
  depends_on        = ["02"]
  content           = "content/module-10.md"
  facilitator_notes = "facilitator/module-10.md"
  hints             = ["hints/module-10-01.md", "hints/module-10-02.md", "hints/module-10-03.md", "hints/module-10-04.md", "hints/module-10-05.md", "hints/module-10-06.md", "hints/module-10-07.md", "hints/module-10-08.md", "hints/module-10-09.md", "hints/module-10-10.md", "hints/module-10-11.md", "hints/module-10-12.md"]
  solution          = "content/module-10-solution.md"
  explain_back      = "Tell your neighbor which observation connected the pod's restart loop to the exact Git\ndiff, and why reverting Git is safer here than editing the live Deployment—even if the\nlive edit appears to work for a minute."
  verify_script     = "scripts/verify-10.sh"
  catch_up_script   = "scripts/catch-up-10.sh"
  checkpoint        = "checkpoint-10"
  probes            = ["module-10-day-two-recovery-stable"]
}

agenda "preflight" {
  kind             = "lab"
  duration_minutes = 30
  scheduled        = false
  module           = "00"
  slides           = ["slide-026", "slide-027", "slide-028"]
  release          = "automatic"
}

agenda "opening" {
  kind             = "briefing"
  duration_minutes = 15
  scheduled        = true
  slides           = ["slide-001", "slide-002", "slide-003", "slide-004", "slide-005", "slide-006", "slide-007", "slide-008", "slide-009", "slide-010", "slide-011", "slide-012", "slide-013", "slide-014", "slide-015", "slide-016", "slide-017", "slide-018", "slide-019", "slide-020", "slide-021", "slide-022", "slide-023", "slide-024", "slide-025"]
  release          = "facilitator"
}

agenda "module-01" {
  kind             = "lab"
  duration_minutes = 35
  scheduled        = true
  module           = "01"
  slides           = ["slide-029", "slide-030", "slide-031"]
  release          = "facilitator"
}

agenda "module-02" {
  kind             = "lab"
  duration_minutes = 35
  scheduled        = true
  module           = "02"
  slides           = ["slide-032", "slide-033", "slide-034", "slide-035"]
  release          = "facilitator"
}

agenda "module-03" {
  kind             = "lab"
  duration_minutes = 35
  scheduled        = true
  module           = "03"
  slides           = ["slide-036", "slide-037", "slide-038", "slide-039"]
  release          = "facilitator"
}

agenda "break-1" {
  kind             = "break"
  duration_minutes = 10
  scheduled        = true
  slides           = ["slide-040"]
  release          = "facilitator"
}

agenda "module-04" {
  kind             = "lab"
  duration_minutes = 35
  scheduled        = true
  module           = "04"
  slides           = ["slide-041", "slide-042", "slide-043", "slide-044"]
  release          = "facilitator"
}

agenda "module-05" {
  kind             = "lab"
  duration_minutes = 25
  scheduled        = true
  module           = "05"
  slides           = ["slide-045", "slide-046", "slide-047", "slide-048"]
  release          = "facilitator"
}

agenda "break-2" {
  kind             = "break"
  duration_minutes = 10
  scheduled        = true
  slides           = ["slide-049"]
  release          = "facilitator"
}

agenda "module-06-pool" {
  kind             = "lab"
  duration_minutes = 0
  scheduled        = false
  module           = "06"
  slides           = ["slide-050", "slide-051", "slide-052"]
  release          = "pool"
}

agenda "module-07-pool" {
  kind             = "lab"
  duration_minutes = 0
  scheduled        = false
  module           = "07"
  slides           = ["slide-053", "slide-054", "slide-055"]
  release          = "pool"
}

agenda "module-08-pool" {
  kind             = "lab"
  duration_minutes = 0
  scheduled        = false
  module           = "08"
  slides           = ["slide-056", "slide-057", "slide-058", "slide-059", "slide-060", "slide-061", "slide-062", "slide-063", "slide-064"]
  release          = "pool"
}

agenda "module-09-pool" {
  kind             = "lab"
  duration_minutes = 0
  scheduled        = false
  module           = "09"
  slides           = ["slide-065", "slide-066", "slide-067", "slide-068", "slide-069"]
  release          = "pool"
}

agenda "module-10-pool" {
  kind             = "lab"
  duration_minutes = 0
  scheduled        = false
  module           = "10"
  slides           = ["slide-070", "slide-071", "slide-072", "slide-073", "slide-074", "slide-075"]
  release          = "pool"
}

agenda "stretch-tinker" {
  kind             = "tinker"
  duration_minutes = 30
  scheduled        = true
  slides           = ["slide-050", "slide-051", "slide-052", "slide-053", "slide-054", "slide-055", "slide-056", "slide-057", "slide-058", "slide-059", "slide-060", "slide-061", "slide-062", "slide-063", "slide-064", "slide-065", "slide-066", "slide-067", "slide-068", "slide-069", "slide-070", "slide-071", "slide-072", "slide-073", "slide-074", "slide-075"]
  release          = "facilitator"
}

agenda "closing" {
  kind             = "retro"
  duration_minutes = 10
  scheduled        = true
  slides           = ["slide-076", "slide-077", "slide-078", "slide-079", "slide-080", "slide-081", "slide-082", "slide-083", "slide-084", "slide-085"]
  release          = "facilitator"
}

presentation {
  assets = ["assets/console/applications-dark.png", "assets/console/buckets-dark.png", "assets/console/builds-dark.png", "assets/console/components-dark.png", "assets/console/database-dark.png", "assets/console/mobile-nav.png", "assets/console/monitoring-dark.png", "assets/console/services-dark.png", "assets/console/streams-dark.png", "assets/modules/08/console-buckets-monitoring-dark.png", "assets/modules/08/console-builds-monitoring-dark.png", "assets/modules/08/console-component-monitoring-dark.png", "assets/modules/08/console-new-function-dark.png", "assets/modules/08/console-streams-monitoring-dark.png", "assets/modules/09/console-component-monitoring-dark.png"]

  slide "slide-001" {
    content         = "slides/slide-001.md"
    presenter_notes = "slides/notes/slide-001.md"
    layout          = "cover"
  }

  slide "slide-002" {
    content         = "slides/slide-002.md"
    presenter_notes = "slides/notes/slide-002.md"
    layout          = "section"
  }

  slide "slide-003" {
    content         = "slides/slide-003.md"
    presenter_notes = "slides/notes/slide-003.md"
    layout          = "default"
  }

  slide "slide-004" {
    content         = "slides/slide-004.md"
    presenter_notes = "slides/notes/slide-004.md"
    layout          = "default"
  }

  slide "slide-005" {
    content         = "slides/slide-005.md"
    presenter_notes = "slides/notes/slide-005.md"
    layout          = "statement"
  }

  slide "slide-006" {
    content         = "slides/slide-006.md"
    presenter_notes = "slides/notes/slide-006.md"
    layout          = "section"
  }

  slide "slide-007" {
    content         = "slides/slide-007.md"
    presenter_notes = "slides/notes/slide-007.md"
    layout          = "statement"
  }

  slide "slide-008" {
    content         = "slides/slide-008.md"
    presenter_notes = "slides/notes/slide-008.md"
    layout          = "default"
  }

  slide "slide-009" {
    content         = "slides/slide-009.md"
    presenter_notes = "slides/notes/slide-009.md"
    layout          = "default"
  }

  slide "slide-010" {
    content         = "slides/slide-010.md"
    presenter_notes = "slides/notes/slide-010.md"
    layout          = "default"
  }

  slide "slide-011" {
    content         = "slides/slide-011.md"
    presenter_notes = "slides/notes/slide-011.md"
    layout          = "default"
  }

  slide "slide-012" {
    content         = "slides/slide-012.md"
    presenter_notes = "slides/notes/slide-012.md"
    layout          = "default"
  }

  slide "slide-013" {
    content         = "slides/slide-013.md"
    presenter_notes = "slides/notes/slide-013.md"
    layout          = "section"
  }

  slide "slide-014" {
    content         = "slides/slide-014.md"
    presenter_notes = "slides/notes/slide-014.md"
    layout          = "default"
  }

  slide "slide-015" {
    content         = "slides/slide-015.md"
    presenter_notes = "slides/notes/slide-015.md"
    layout          = "default"
  }

  slide "slide-016" {
    content         = "slides/slide-016.md"
    presenter_notes = "slides/notes/slide-016.md"
    layout          = "default"
  }

  slide "slide-017" {
    content         = "slides/slide-017.md"
    presenter_notes = "slides/notes/slide-017.md"
    layout          = "default"
  }

  slide "slide-018" {
    content         = "slides/slide-018.md"
    presenter_notes = "slides/notes/slide-018.md"
    layout          = "default"
  }

  slide "slide-019" {
    content         = "slides/slide-019.md"
    presenter_notes = "slides/notes/slide-019.md"
    layout          = "default"
  }

  slide "slide-020" {
    content         = "slides/slide-020.md"
    presenter_notes = "slides/notes/slide-020.md"
    layout          = "section"
  }

  slide "slide-021" {
    content         = "slides/slide-021.md"
    presenter_notes = "slides/notes/slide-021.md"
    layout          = "default"
  }

  slide "slide-022" {
    content         = "slides/slide-022.md"
    presenter_notes = "slides/notes/slide-022.md"
    layout          = "default"
  }

  slide "slide-023" {
    content         = "slides/slide-023.md"
    presenter_notes = "slides/notes/slide-023.md"
    layout          = "default"
  }

  slide "slide-024" {
    content         = "slides/slide-024.md"
    presenter_notes = "slides/notes/slide-024.md"
    layout          = "default"
  }

  slide "slide-025" {
    content         = "slides/slide-025.md"
    presenter_notes = "slides/notes/slide-025.md"
    layout          = "default"
  }

  slide "slide-026" {
    content         = "slides/slide-026.md"
    presenter_notes = "slides/notes/slide-026.md"
    layout          = "section"
  }

  slide "slide-027" {
    content         = "slides/slide-027.md"
    presenter_notes = "slides/notes/slide-027.md"
    layout          = "default"
  }

  slide "slide-028" {
    content         = "slides/slide-028.md"
    presenter_notes = "slides/notes/slide-028.md"
    layout          = "default"
  }

  slide "slide-029" {
    content         = "slides/slide-029.md"
    presenter_notes = "slides/notes/slide-029.md"
    layout          = "section"
  }

  slide "slide-030" {
    content         = "slides/slide-030.md"
    presenter_notes = "slides/notes/slide-030.md"
    layout          = "default"
  }

  slide "slide-031" {
    content         = "slides/slide-031.md"
    presenter_notes = "slides/notes/slide-031.md"
    layout          = "default"
  }

  slide "slide-032" {
    content         = "slides/slide-032.md"
    presenter_notes = "slides/notes/slide-032.md"
    layout          = "section"
  }

  slide "slide-033" {
    content         = "slides/slide-033.md"
    presenter_notes = "slides/notes/slide-033.md"
    layout          = "default"
  }

  slide "slide-034" {
    content         = "slides/slide-034.md"
    presenter_notes = "slides/notes/slide-034.md"
    layout          = "default"
  }

  slide "slide-035" {
    content         = "slides/slide-035.md"
    presenter_notes = "slides/notes/slide-035.md"
    layout          = "default"
  }

  slide "slide-036" {
    content         = "slides/slide-036.md"
    presenter_notes = "slides/notes/slide-036.md"
    layout          = "section"
  }

  slide "slide-037" {
    content         = "slides/slide-037.md"
    presenter_notes = "slides/notes/slide-037.md"
    layout          = "default"
  }

  slide "slide-038" {
    content         = "slides/slide-038.md"
    presenter_notes = "slides/notes/slide-038.md"
    layout          = "default"
  }

  slide "slide-039" {
    content         = "slides/slide-039.md"
    presenter_notes = "slides/notes/slide-039.md"
    layout          = "default"
  }

  slide "slide-040" {
    content         = "slides/slide-040.md"
    presenter_notes = "slides/notes/slide-040.md"
    layout          = "break"
  }

  slide "slide-041" {
    content         = "slides/slide-041.md"
    presenter_notes = "slides/notes/slide-041.md"
    layout          = "section"
  }

  slide "slide-042" {
    content         = "slides/slide-042.md"
    presenter_notes = "slides/notes/slide-042.md"
    layout          = "default"
  }

  slide "slide-043" {
    content         = "slides/slide-043.md"
    presenter_notes = "slides/notes/slide-043.md"
    layout          = "default"
  }

  slide "slide-044" {
    content         = "slides/slide-044.md"
    presenter_notes = "slides/notes/slide-044.md"
    layout          = "default"
  }

  slide "slide-045" {
    content         = "slides/slide-045.md"
    presenter_notes = "slides/notes/slide-045.md"
    layout          = "section"
  }

  slide "slide-046" {
    content         = "slides/slide-046.md"
    presenter_notes = "slides/notes/slide-046.md"
    layout          = "default"
  }

  slide "slide-047" {
    content         = "slides/slide-047.md"
    presenter_notes = "slides/notes/slide-047.md"
    layout          = "default"
  }

  slide "slide-048" {
    content         = "slides/slide-048.md"
    presenter_notes = "slides/notes/slide-048.md"
    layout          = "default"
  }

  slide "slide-049" {
    content         = "slides/slide-049.md"
    presenter_notes = "slides/notes/slide-049.md"
    layout          = "break"
  }

  slide "slide-050" {
    content         = "slides/slide-050.md"
    presenter_notes = "slides/notes/slide-050.md"
    layout          = "section"
  }

  slide "slide-051" {
    content         = "slides/slide-051.md"
    presenter_notes = "slides/notes/slide-051.md"
    layout          = "default"
  }

  slide "slide-052" {
    content         = "slides/slide-052.md"
    presenter_notes = "slides/notes/slide-052.md"
    layout          = "default"
  }

  slide "slide-053" {
    content         = "slides/slide-053.md"
    presenter_notes = "slides/notes/slide-053.md"
    layout          = "section"
  }

  slide "slide-054" {
    content         = "slides/slide-054.md"
    presenter_notes = "slides/notes/slide-054.md"
    layout          = "default"
  }

  slide "slide-055" {
    content         = "slides/slide-055.md"
    presenter_notes = "slides/notes/slide-055.md"
    layout          = "default"
  }

  slide "slide-056" {
    content         = "slides/slide-056.md"
    presenter_notes = "slides/notes/slide-056.md"
    layout          = "section"
  }

  slide "slide-057" {
    content         = "slides/slide-057.md"
    presenter_notes = "slides/notes/slide-057.md"
    layout          = "default"
  }

  slide "slide-058" {
    content         = "slides/slide-058.md"
    presenter_notes = "slides/notes/slide-058.md"
    layout          = "default"
  }

  slide "slide-059" {
    content         = "slides/slide-059.md"
    presenter_notes = "slides/notes/slide-059.md"
    layout          = "default"
  }

  slide "slide-060" {
    content         = "slides/slide-060.md"
    presenter_notes = "slides/notes/slide-060.md"
    layout          = "default"
  }

  slide "slide-061" {
    content         = "slides/slide-061.md"
    presenter_notes = "slides/notes/slide-061.md"
    layout          = "statement"
  }

  slide "slide-062" {
    content         = "slides/slide-062.md"
    presenter_notes = "slides/notes/slide-062.md"
    layout          = "default"
  }

  slide "slide-063" {
    content         = "slides/slide-063.md"
    presenter_notes = "slides/notes/slide-063.md"
    layout          = "default"
  }

  slide "slide-064" {
    content         = "slides/slide-064.md"
    presenter_notes = "slides/notes/slide-064.md"
    layout          = "default"
  }

  slide "slide-065" {
    content         = "slides/slide-065.md"
    presenter_notes = "slides/notes/slide-065.md"
    layout          = "section"
  }

  slide "slide-066" {
    content         = "slides/slide-066.md"
    presenter_notes = "slides/notes/slide-066.md"
    layout          = "default"
  }

  slide "slide-067" {
    content         = "slides/slide-067.md"
    presenter_notes = "slides/notes/slide-067.md"
    layout          = "default"
  }

  slide "slide-068" {
    content         = "slides/slide-068.md"
    presenter_notes = "slides/notes/slide-068.md"
    layout          = "default"
  }

  slide "slide-069" {
    content         = "slides/slide-069.md"
    presenter_notes = "slides/notes/slide-069.md"
    layout          = "default"
  }

  slide "slide-070" {
    content         = "slides/slide-070.md"
    presenter_notes = "slides/notes/slide-070.md"
    layout          = "section"
  }

  slide "slide-071" {
    content         = "slides/slide-071.md"
    presenter_notes = "slides/notes/slide-071.md"
    layout          = "default"
  }

  slide "slide-072" {
    content         = "slides/slide-072.md"
    presenter_notes = "slides/notes/slide-072.md"
    layout          = "default"
  }

  slide "slide-073" {
    content         = "slides/slide-073.md"
    presenter_notes = "slides/notes/slide-073.md"
    layout          = "default"
  }

  slide "slide-074" {
    content         = "slides/slide-074.md"
    presenter_notes = "slides/notes/slide-074.md"
    layout          = "default"
  }

  slide "slide-075" {
    content         = "slides/slide-075.md"
    presenter_notes = "slides/notes/slide-075.md"
    layout          = "default"
  }

  slide "slide-076" {
    content         = "slides/slide-076.md"
    presenter_notes = "slides/notes/slide-076.md"
    layout          = "section"
  }

  slide "slide-077" {
    content         = "slides/slide-077.md"
    presenter_notes = "slides/notes/slide-077.md"
    layout          = "default"
  }

  slide "slide-078" {
    content         = "slides/slide-078.md"
    presenter_notes = "slides/notes/slide-078.md"
    layout          = "default"
  }

  slide "slide-079" {
    content         = "slides/slide-079.md"
    presenter_notes = "slides/notes/slide-079.md"
    layout          = "section"
  }

  slide "slide-080" {
    content         = "slides/slide-080.md"
    presenter_notes = "slides/notes/slide-080.md"
    layout          = "default"
  }

  slide "slide-081" {
    content         = "slides/slide-081.md"
    presenter_notes = "slides/notes/slide-081.md"
    layout          = "default"
  }

  slide "slide-082" {
    content         = "slides/slide-082.md"
    presenter_notes = "slides/notes/slide-082.md"
    layout          = "default"
  }

  slide "slide-083" {
    content         = "slides/slide-083.md"
    presenter_notes = "slides/notes/slide-083.md"
    layout          = "default"
  }

  slide "slide-084" {
    content         = "slides/slide-084.md"
    presenter_notes = "slides/notes/slide-084.md"
    layout          = "default"
  }

  slide "slide-085" {
    content         = "slides/slide-085.md"
    presenter_notes = "slides/notes/slide-085.md"
    layout          = "closing"
  }

}
