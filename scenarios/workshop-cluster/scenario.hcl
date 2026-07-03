scenario "workshop-cluster" {
  title             = "Workshop Cluster"
  category          = "kubernetes"
  tags              = ["kubernetes", "k3s", "workshop"]
  difficulty        = "medium"
  estimated_minutes = 25
  description       = "Restore the workshop environment so the application platform is healthy again"
  briefing          = <<-MD
    A lightweight k3s workshop cluster is running, but the demo application is unavailable.
    Inspect the cluster state and restore the `hello-web` workload so participants can use it.
  MD

  hint "inspect-workshop-namespace" {
    title = "Start in the workshop namespace"
    body  = "Use `kubectl get deploy,pods -n workshop` to compare the deployment with the pod state."
  }

  hint "look-at-replicas" {
    title = "Check desired replicas"
    body  = "A deployment with zero desired replicas will not create a Ready pod."
  }

  solution {
    body = <<-MD
      Scale the workshop deployment back up:

      ```bash
      export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
      kubectl scale deployment/hello-web --namespace workshop --replicas=1
      kubectl rollout status deployment/hello-web --namespace workshop
      ```
    MD
  }

  image "debian-13-generic" {
    base = "trixie"
  }

  kino {
    defaults {
      every_seconds   = 2
      timeout_seconds = 1
    }

    probe "k3s-running" {
      kind        = "service"
      service     = "k3s"
      state       = "running"
      phase       = "boot"
      description = "The k3s control plane should be running"
      title       = "Keep k3s running"
      body        = "The control plane service must be active before Kubernetes checks can pass."
    }

    probe "cluster-dns-ready" {
      kind          = "k8s_pod_state"
      namespace     = "kube-system"
      selector      = "k8s-app=kube-dns"
      desired_state = "condition:Ready"
      kubeconfig    = "/etc/rancher/k3s/k3s.yaml"
      phase         = "boot"
      description   = "Core cluster services should become Ready"
      title         = "Wait for cluster DNS"
      body          = "CoreDNS must be Ready before the workload can reliably serve traffic."
    }

    probe "hello-web-ready" {
      kind          = "k8s_pod_state"
      namespace     = "workshop"
      selector      = "app=hello-web"
      desired_state = "condition:Ready"
      kubeconfig    = "/etc/rancher/k3s/k3s.yaml"
      phase         = "scenario"
      description   = "The workshop application should have a Ready pod"
      title         = "Restore hello-web"
      body          = "The workshop namespace needs a Ready `hello-web` pod."

      hint "get-deploy" {
        body = "`kubectl get deploy hello-web -n workshop` shows the desired replica count."
      }

      hint "scale-up" {
        body = "Scale `deployment/hello-web` in the `workshop` namespace back to one replica."
      }
    }
  }

  vm "control-plane" {
    cpu    = 2
    memory = 2048
    disk   = 6
    image  = "debian-13-generic"

    step "setup-k3s" {
      command {
        cmd = <<-SHELL
          export INSTALL_K3S_EXEC="server --node-name control-plane"
          export K3S_KUBECONFIG_MODE="644"
          curl -sfL https://get.k3s.io | sh -
          export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

          for _ in $(seq 1 120); do
            if kubectl wait --for=condition=Ready node/control-plane --timeout=5s >/dev/null 2>&1; then
              break
            fi
            sleep 1
          done

          kubectl wait --for=condition=Ready node/control-plane --timeout=30s
        SHELL
      }
    }

    step "seed-workload" {
      k8s_namespace {
        name = "workshop"
      }

      k8s_deployment {
        name           = "hello-web"
        namespace      = "workshop"
        image          = "nginx:1.27-bookworm"
        replicas       = 1
        labels         = { app = "hello-web" }
        container_port = 80
      }

      k8s_service {
        name        = "hello-web"
        namespace   = "workshop"
        selector    = { app = "hello-web" }
        port        = 80
        target_port = 80
      }

      command {
        cmd = <<-SHELL
          export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
          kubectl rollout status deployment/hello-web --namespace workshop --timeout=120s
        SHELL
      }
    }

    step "break-scale-down" {
      k8s_scale_deployment {
        name      = "hello-web"
        namespace = "workshop"
        replicas  = 0
      }
    }

    probes = ["k3s-running", "cluster-dns-ready", "hello-web-ready"]
  }
}
