scenario "workshop-cluster" {
  category = "kubernetes"
  description = "Restore the workshop environment so the application platform is healthy again"

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
    }

    probe "cluster-dns-ready" {
      kind          = "k8s_pod_state"
      namespace     = "kube-system"
      selector      = "k8s-app=kube-dns"
      desired_state = "condition:Ready"
      kubeconfig    = "/etc/rancher/k3s/k3s.yaml"
      phase         = "boot"
      description   = "Core cluster services should become Ready"
    }

    probe "hello-web-ready" {
      kind          = "k8s_pod_state"
      namespace     = "workshop"
      selector      = "app=hello-web"
      desired_state = "condition:Ready"
      kubeconfig    = "/etc/rancher/k3s/k3s.yaml"
      phase         = "scenario"
      description   = "The workshop application should have a Ready pod"
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
