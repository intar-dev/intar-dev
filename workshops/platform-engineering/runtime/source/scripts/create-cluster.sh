#!/usr/bin/env bash
# =============================================================================
# create-cluster.sh — module 1: create the CloudBox Talos cluster
#
# What it does:
#   1. talosctl cluster create docker — Talos v1.13.6, 1 controlplane +
#      1 worker, raised memory limits, CNI and kube-proxy disabled
#      (Cilium replaces both), workshop NodePorts published on localhost
#   2. Pulls every Talos/Kubernetes workload from a reviewed external digest
#   3. Installs Cilium via Helm with the values from the official Talos guide
#   4. Waits for both nodes to become Ready and prints next steps
#
# Usage:
#   ./scripts/create-cluster.sh
#
# External image access is fixed by the signed runtime bundle; there is no mirror override.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib.sh"

need talosctl
need kubectl
need helm
need docker
docker_running || die "Docker daemon is not reachable. Start Docker and re-run."

# Talos labels every node container with talos.cluster.name=<cluster>
if [[ -n "$(docker ps -aq --filter "label=talos.cluster.name=${CLUSTER_NAME}")" ]]; then
  die "A '${CLUSTER_NAME}' cluster already exists. Run ./scripts/destroy-cluster.sh first."
fi

# --- Machine config patches -----------------------------------------------------
# Disable the default CNI (flannel) and kube-proxy: Cilium replaces both.
# This is why Talos >= v1.13 is required — v1.12 hangs on cni:none (talos#12885).
CNI_PATCH="$(cat <<'EOF'
cluster:
  apiServer:
    image: registry.k8s.io/kube-apiserver@sha256:0535dde1a857029209d7effe681c919a1580d2eb24eda4bd122d24e9a372e1b8
  controllerManager:
    image: registry.k8s.io/kube-controller-manager@sha256:b3add29a00c3c4763c75a09ec94915e3d0d590b93b3850a97d52970fbd2b2c12
  scheduler:
    image: registry.k8s.io/kube-scheduler@sha256:94dfc9f285718a06bb873947959b8514ed95dddaa7c74d765cc346fdfa684859
  etcd:
    image: registry.k8s.io/etcd@sha256:3c2ced08f23b1183e8bd4613064c3fb6b8db5057a4d1f13c3518c76e357a07a8
  coreDNS:
    image: registry.k8s.io/coredns/coredns@sha256:e7e6440cfd1e919280958f5b5a6ab2b184d385bba774c12ad2a9e1e4183f90d9
  network:
    cni:
      name: none
  proxy:
    disabled: true
machine:
  # Every cloud region had to start somewhere.
  nodeLabels:
    cloudbox.io/region: eu-laptop-1
    cloudbox.io/zone: under-desk-a
  kubelet:
    image: ghcr.io/siderolabs/kubelet@sha256:e594fcc880e6d2816b3334e4ddfd586b420ca8c3a4dd2b40e9de1571e69e559a
    extraArgs:
      pod-infra-container-image: registry.k8s.io/pause@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c
    extraMounts:
      # local-path-provisioner writes PV data here; without this bind mount
      # every PVC on Talos stays Pending (kubelet cannot reach the host path).
      - destination: /var/local-path-provisioner
        type: bind
        source: /var/local-path-provisioner
        options: [bind, rshared, rw]
EOF
)"

patches=(--config-patch "${CNI_PATCH}")

# The direct-cloud runtime intentionally has no local registry mirror.
# Talos containerd resolves every external workload from its digest-pinned
# manifest reference. Checkpoint 00 has already gated DNS, TLS, HTTPS, and
# registry manifest availability for the full signed image lock.
info "Using digest-pinned external registries; no local mirror is configured"

# --- 1. Create the cluster --------------------------------------------------------
step "Creating Talos cluster '${CLUSTER_NAME}' (Talos ${TALOS_VERSION}, Kubernetes ${KUBERNETES_VERSION})"
info "1 controlplane (${TALOS_MEMORY_CONTROLPLANE} MB) + 1 worker (${TALOS_MEMORY_WORKER} MB)"

# NodePorts are published on the controlplane container; Cilium's
# kube-proxy replacement makes every NodePort answer on every node.
talosctl cluster create docker \
  --name "${CLUSTER_NAME}" \
  --image "${TALOS_IMAGE}" \
  --kubernetes-version "${KUBERNETES_VERSION}" \
  --workers 1 \
  --memory-controlplanes "${TALOS_MEMORY_CONTROLPLANE}" \
  --memory-workers "${TALOS_MEMORY_WORKER}" \
  --subnet "${TALOS_SUBNET}" \
  --exposed-ports "${NODEPORT_GITEA}:${NODEPORT_GITEA}/tcp,${NODEPORT_ARGOCD}:${NODEPORT_ARGOCD}/tcp,${NODEPORT_ZOT}:${NODEPORT_ZOT}/tcp,${NODEPORT_PORTAL}:${NODEPORT_PORTAL}/tcp,${NODEPORT_BACKSTAGE}:${NODEPORT_BACKSTAGE}/tcp,${NODEPORT_RUSTFS_S3}:${NODEPORT_RUSTFS_S3}/tcp,${NODEPORT_GRAFANA}:${NODEPORT_GRAFANA}/tcp,${NODEPORT_KOURIER}:${NODEPORT_KOURIER}/tcp,${NODEPORT_NATS}:${NODEPORT_NATS}/tcp" \
  "${patches[@]}"

# --- 2. kubeconfig ------------------------------------------------------------------
step "Merging kubeconfig"
# The controlplane always gets the first host address of TALOS_SUBNET (.2 —
# .1 is the gateway). Set it as the context's default node so every later
# talosctl command (yours included) works without a -n flag; on a fresh
# machine `talosctl kubeconfig` fails without this (found by rehearsal-in-CI).
TALOS_CP_IP="${TALOS_SUBNET_GATEWAY%.*}.2"
talosctl --context "${CLUSTER_NAME}" config node "${TALOS_CP_IP}"
talosctl --context "${CLUSTER_NAME}" kubeconfig --force
kubectl config use-context "admin@${CLUSTER_NAME}" >/dev/null
ok "kubectl context: admin@${CLUSTER_NAME}"

step "Waiting for the Kubernetes API"
for _ in $(seq 1 60); do
  kubectl get nodes >/dev/null 2>&1 && break
  sleep 2
done
kubectl get nodes >/dev/null 2>&1 || die "Kubernetes API did not come up within 2 minutes"
ok "API server is answering (nodes are NotReady until Cilium arrives — expected)"

# --- 3. Cilium ------------------------------------------------------------------------
step "Installing Cilium ${CILIUM_VERSION} (CNI + kube-proxy replacement)"
# Chart is vendored into scripts/manifests/ (re-vendor from CILIUM_HELM_REPO
# when bumping) so this needs no internet at the venue — principle 2.
# Values from the official Talos Cilium guide:
# https://docs.siderolabs.com/kubernetes-guides/cni/deploying-cilium
# k8sServiceHost=localhost:7445 is KubePrism, Talos' local API server balancer.
helm upgrade --install cilium \
  "${SCRIPT_DIR}/manifests/cilium-${CILIUM_VERSION}.tgz" \
  --namespace kube-system \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=localhost \
  --set k8sServicePort=7445 \
  --set cgroup.autoMount.enabled=false \
  --set cgroup.hostRoot=/sys/fs/cgroup \
  --set securityContext.capabilities.ciliumAgent="{CHOWN,KILL,NET_ADMIN,NET_RAW,IPC_LOCK,SYS_ADMIN,SYS_RESOURCE,DAC_OVERRIDE,FOWNER,SETGID,SETUID}" \
  --set securityContext.capabilities.cleanCiliumState="{NET_ADMIN,SYS_ADMIN,SYS_RESOURCE}"

# --- 4. Wait for Ready -------------------------------------------------------------------
step "Waiting for nodes to become Ready (Cilium rollout)"
wait_rollout kube-system daemonset/cilium
kubectl wait --for=condition=Ready nodes --all --timeout=300s
kubectl get nodes -o wide

echo
ok "Cluster '${CLUSTER_NAME}' is up — you now own a cloud. ☁️"
info "Next steps:"
echo "   ./scripts/bootstrap-gitops.sh   # module 2: Gitea + ArgoCD"
echo "   ./scripts/seed-gitea.sh         # module 2: push this repo to your cloud"
info "Useful:"
echo "   talosctl --context ${CLUSTER_NAME} dashboard   # Talos node dashboard"
echo "   ./scripts/destroy-cluster.sh                          # tear it all down"
