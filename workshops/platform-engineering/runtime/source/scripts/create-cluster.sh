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
need timeout
need tar
docker_running || die "Docker daemon is not reachable. Start Docker and re-run."

# Talos labels every node container with talos.cluster.name=<cluster>
if [[ -n "$(docker ps -aq --filter "label=talos.cluster.name=${CLUSTER_NAME}")" ]]; then
  die "A '${CLUSTER_NAME}' cluster already exists. Run ./scripts/destroy-cluster.sh first."
fi

# Talos runs kubelet as a nested container with shared rootfs propagation for
# Kubernetes volumes. Raise Linux's per-mount-namespace ceiling only for this
# disposable learner VM, verify it, and retain a guard against runaway growth.
readonly TALOS_DOCKER_MIN_MOUNT_MAX=262144
readonly TALOS_DOCKER_GUARD_MOUNTS=196608
talos_docker_original_mount_max="$(
  awk 'NR == 1 { print $1 }' /proc/sys/fs/mount-max 2>/dev/null || true
)"
[[ "${talos_docker_original_mount_max}" =~ ^[0-9]+$ ]] || {
  die "Linux did not report a numeric fs.mount-max."
}
if (( talos_docker_original_mount_max < TALOS_DOCKER_MIN_MOUNT_MAX )); then
  if (( EUID == 0 )); then
    printf '%s\n' "${TALOS_DOCKER_MIN_MOUNT_MAX}" > /proc/sys/fs/mount-max
  else
    need sudo
    printf '%s\n' "${TALOS_DOCKER_MIN_MOUNT_MAX}" \
      | sudo -n -- tee /proc/sys/fs/mount-max >/dev/null
  fi
fi
talos_docker_mount_max="$(
  awk 'NR == 1 { print $1 }' /proc/sys/fs/mount-max 2>/dev/null || true
)"
[[ "${talos_docker_mount_max}" =~ ^[0-9]+$ ]] \
  && (( talos_docker_mount_max >= TALOS_DOCKER_MIN_MOUNT_MAX )) || {
  die "Could not prepare Linux mount namespace capacity for Talos-in-Docker."
}
info "Talos mount namespace ceiling: ${talos_docker_mount_max} (was ${talos_docker_original_mount_max})"

# --- Machine config patches -----------------------------------------------------
# Disable the default CNI (flannel) and kube-proxy: Cilium replaces both.
# This is why Talos >= v1.13 is required — v1.12 hangs on cni:none (talos#12885).
CNI_PATCH="$(cat <<'EOF'
cluster:
  apiServer:
    image: registry.k8s.io/kube-apiserver:v1.36.2@sha256:0535dde1a857029209d7effe681c919a1580d2eb24eda4bd122d24e9a372e1b8
  controllerManager:
    image: registry.k8s.io/kube-controller-manager:v1.36.2@sha256:b3add29a00c3c4763c75a09ec94915e3d0d590b93b3850a97d52970fbd2b2c12
  scheduler:
    image: registry.k8s.io/kube-scheduler:v1.36.2@sha256:94dfc9f285718a06bb873947959b8514ed95dddaa7c74d765cc346fdfa684859
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
    image: ghcr.io/siderolabs/kubelet:v1.36.2@sha256:e594fcc880e6d2816b3334e4ddfd586b420ca8c3a4dd2b40e9de1571e69e559a
    extraArgs:
      pod-infra-container-image: registry.k8s.io/pause@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c
EOF
)"

# Talos rejects cluster.etcd configuration on worker machine configs, so
# keep its digest pin in a control-plane-only patch.
CONTROL_PLANE_PATCH="$(cat <<'EOF'
cluster:
  etcd:
    image: registry.k8s.io/etcd@sha256:3c2ced08f23b1183e8bd4613064c3fb6b8db5057a4d1f13c3518c76e357a07a8
EOF
)"

patches=(
  --config-patch "${CNI_PATCH}"
  --config-patch-controlplanes "${CONTROL_PLANE_PATCH}"
)

# The controlplane always gets the first host address of TALOS_SUBNET (.2;
# .1 is the Docker bridge gateway).
TALOS_CP_IP="${TALOS_SUBNET_GATEWAY%.*}.2"

cleanup_destroyed_cluster_contexts() {
  local contexts current_context other_context talosconfig_path

  if have kubectl; then
    kubectl config delete-context "admin@${CLUSTER_NAME}" >/dev/null 2>&1 || true
    kubectl config delete-cluster "${CLUSTER_NAME}" >/dev/null 2>&1 || true
    kubectl config delete-user "admin@${CLUSTER_NAME}" >/dev/null 2>&1 || true
  fi

  contexts="$(
    talosctl config contexts 2>/dev/null \
      | awk 'NR > 1 { if ($1 == "*") print $2; else print $1 }'
  )" || {
    warn "Could not enumerate talosconfig contexts after cluster removal"
    return 0
  }

  if ! grep -Fxq "${CLUSTER_NAME}" <<<"${contexts}"; then
    return 0
  fi

  current_context="$(
    talosctl config contexts 2>/dev/null \
      | awk 'NR > 1 && $1 == "*" { print $2; exit }'
  )" || current_context=""
  other_context="$(
    awk -v target="${CLUSTER_NAME}" 'NF && $0 != target { print; exit }' <<<"${contexts}"
  )"

  if [[ -n "${other_context}" ]]; then
    if [[ "${current_context}" == "${CLUSTER_NAME}" ]] \
      && ! talosctl config context "${other_context}" >/dev/null 2>&1; then
      warn "Could not switch away from talosconfig context '${CLUSTER_NAME}'; leaving it intact"
      return 0
    fi
    talosctl config remove "${CLUSTER_NAME}" -y >/dev/null 2>&1 \
      || warn "Could not remove stale talosconfig context '${CLUSTER_NAME}'"
    return 0
  fi

  # `talosctl config remove` intentionally refuses to remove the current/sole
  # context. This learner VM owns this one-context talosconfig, so remove only
  # that file; never touch a directory or follow a symlink.
  talosconfig_path="${TALOSCONFIG:-${HOME}/.talos/config}"
  case "${talosconfig_path}" in
    ""|"/"|"${HOME}")
      warn "Refusing unsafe talosconfig cleanup path '${talosconfig_path}'"
      return 0
      ;;
  esac
  if [[ -f "${talosconfig_path}" && ! -L "${talosconfig_path}" ]]; then
    rm -f -- "${talosconfig_path}"
  else
    warn "Dedicated talosconfig is not a regular file; leaving it intact"
  fi
}

mount_namespace_capacity_snapshot() {
  local -a privileged_shell

  if (( EUID == 0 )); then
    privileged_shell=(/bin/bash --noprofile --norc -s)
  else
    need sudo
    privileged_shell=(sudo -n -- /bin/bash --noprofile --norc -s)
  fi

  # Docker, containerd, and runc namespaces are root-owned and ptrace-gated.
  # Run this fixed signed helper as root so the guard measures the namespaces
  # which can actually exhaust fs.mount-max.
  "${privileged_shell[@]}" <<'INTAR_MOUNT_CAPACITY'
set -u
shopt -s nullglob
declare -A seen_namespaces=()
max_mount_count=0
max_mount_namespace=unknown
namespace_count=0

for mountinfo in /proc/[0-9]*/mountinfo; do
  pid="${mountinfo#/proc/}"
  pid="${pid%/mountinfo}"
  namespace="$(readlink "/proc/${pid}/ns/mnt" 2>/dev/null || true)"
  namespace="${namespace//[!0-9]/}"
  [[ -n "${namespace}" ]] || continue
  [[ -z "${seen_namespaces[${namespace}]:-}" ]] || continue
  mount_count="$(
    awk 'END { print NR }' "${mountinfo}" 2>/dev/null || true
  )"
  [[ "${mount_count}" =~ ^[0-9]+$ ]] || continue
  seen_namespaces["${namespace}"]=1
  namespace_count=$((namespace_count + 1))
  if (( mount_count > max_mount_count )); then
    max_mount_count="${mount_count}"
    max_mount_namespace="${namespace}"
  fi
done

(( namespace_count > 0 )) || {
  echo "No privileged mount namespaces were readable." >&2
  exit 1
}
printf 'readable_mount_namespaces=%s max_namespace_mounts=%s max_namespace_id=%s' \
  "${namespace_count}" "${max_mount_count}" "${max_mount_namespace}"
INTAR_MOUNT_CAPACITY
}

host_capacity_snapshot() {
  local docker_available_inodes docker_available_kib mount_max namespace_capacity
  local run_available_inodes run_available_kib

  docker_available_kib="$(
    df -Pk /var/lib/docker 2>/dev/null | awk 'NR == 2 { print $4 }' || true
  )"
  docker_available_inodes="$(
    df -Pi /var/lib/docker 2>/dev/null | awk 'NR == 2 { print $4 }' || true
  )"
  run_available_kib="$(
    df -Pk /run 2>/dev/null | awk 'NR == 2 { print $4 }' || true
  )"
  run_available_inodes="$(
    df -Pi /run 2>/dev/null | awk 'NR == 2 { print $4 }' || true
  )"
  mount_max="$(
    awk 'NR == 1 { print $1 }' /proc/sys/fs/mount-max 2>/dev/null || true
  )"
  if ! namespace_capacity="$(mount_namespace_capacity_snapshot)"; then
    return 1
  fi
  printf 'docker_available_kib=%s docker_available_inodes=%s run_available_kib=%s run_available_inodes=%s mount_max=%s %s' \
    "${docker_available_kib:-unknown}" \
    "${docker_available_inodes:-unknown}" \
    "${run_available_kib:-unknown}" \
    "${run_available_inodes:-unknown}" \
    "${mount_max:-unknown}" \
    "${namespace_capacity}"
}

mount_capacity_sampler_pid=""
mount_capacity_sampler_file=""
mount_capacity_peak_count=0
mount_capacity_peak_snapshot="unavailable"
mount_capacity_sampler_failed=0

start_mount_capacity_sampler() {
  local initial_snapshot

  mount_capacity_sampler_file="$(
    umask 077
    mktemp "${TMPDIR:-/tmp}/${CLUSTER_NAME}-mount-capacity.XXXXXX"
  )" || die "Could not reserve a private mount-capacity sampler path."
  if ! initial_snapshot="$(host_capacity_snapshot)"; then
    rm -f "${mount_capacity_sampler_file}"
    mount_capacity_sampler_file=""
    die "Could not inspect privileged mount namespace capacity."
  fi
  printf '%s\n' "${initial_snapshot}" >> "${mount_capacity_sampler_file}"

  (
    while true; do
      if ! host_capacity_snapshot; then
        printf '%s\n' "sampler_error=privileged_mount_snapshot_failed"
        exit 0
      fi
      printf '\n'
      sleep 5
    done
  ) >> "${mount_capacity_sampler_file}" 2>/dev/null &
  mount_capacity_sampler_pid=$!
}

stop_mount_capacity_sampler() {
  local count peak_line

  if [[ -n "${mount_capacity_sampler_pid}" ]]; then
    kill "${mount_capacity_sampler_pid}" >/dev/null 2>&1 || true
    wait "${mount_capacity_sampler_pid}" >/dev/null 2>&1 || true
    mount_capacity_sampler_pid=""
  fi
  if [[ -n "${mount_capacity_sampler_file}" && -f "${mount_capacity_sampler_file}" ]]; then
    if grep -Fxq "sampler_error=privileged_mount_snapshot_failed" \
      "${mount_capacity_sampler_file}"; then
      mount_capacity_sampler_failed=1
    fi
    peak_line="$(
      awk '
        {
          count = -1
          for (field = 1; field <= NF; field++) {
            if ($field ~ /^max_namespace_mounts=[0-9]+$/) {
              split($field, pair, "=")
              count = pair[2] + 0
            }
          }
          if (count > peak) {
            peak = count
            line = $0
          }
        }
        END {
          if (line != "") {
            print peak "\t" line
          }
        }
      ' "${mount_capacity_sampler_file}"
    )"
    if [[ -n "${peak_line}" ]]; then
      count="${peak_line%%$'\t'*}"
      [[ "${count}" =~ ^[0-9]+$ ]] && mount_capacity_peak_count="${count}"
      mount_capacity_peak_snapshot="${peak_line#*$'\t'}"
    fi
    rm -f "${mount_capacity_sampler_file}"
    mount_capacity_sampler_file=""
  fi
}

trap stop_mount_capacity_sampler EXIT

collect_failed_cluster_logs() {
  local archive archive_members destroy_status failure_capacity

  stop_mount_capacity_sampler
  failure_capacity="$(host_capacity_snapshot 2>/dev/null || true)"
  [[ -n "${failure_capacity}" ]] || failure_capacity="unavailable"
  warn "Host capacity at failure: ${failure_capacity}"
  warn "Peak host capacity during cluster bootstrap: ${mount_capacity_peak_snapshot}"

  archive="$(
    umask 077
    mktemp "${TMPDIR:-/tmp}/${CLUSTER_NAME}-failure.XXXXXX"
  )" || {
    warn "Could not reserve a private Talos log archive path"
    warn "Host capacity captured before cleanup: ${failure_capacity}; cluster_bootstrap_peak: ${mount_capacity_peak_snapshot}"
    return 0
  }

  warn "Collecting Talos logs and removing the failed cluster"
  destroy_status=0
  timeout --signal=KILL 120s talosctl cluster destroy \
    --name "${CLUSTER_NAME}" \
    --save-cluster-logs-archive-path "${archive}" \
    || destroy_status=$?

  archive_members=""
  if archive_members="$(tar -tzf "${archive}" 2>/dev/null)" \
    && grep -Eq '(^|/)[^/]+\.log$' <<<"${archive_members}"; then
    warn "Last high-signal Talos log lines (credentials redacted):"
    tar -xOzf "${archive}" 2>/dev/null \
      | LC_ALL=C tr -cd '\11\12\15\40-\176' \
      | grep -Ei 'apid|bootstrap|certificate|error|fail|fatal|handshake|killed|oom|panic|timeout' \
      | redact_talos_diagnostic_line \
      | cut -c1-500 \
      | tail -n 80 \
      || true
  else
    warn "Talos did not produce a valid log archive"
  fi

  rm -f "${archive}"

  if (( destroy_status == 0 )); then
    cleanup_destroyed_cluster_contexts
  else
    warn "Talos failed-cluster removal exited with status ${destroy_status}; preserving its contexts"
  fi

  # The checkpoint runner retains a bounded output tail. Repeat the captured
  # pre-cleanup values last so lengthy Talos logs cannot evict the evidence.
  warn "Host capacity captured before cleanup: ${failure_capacity}; cluster_bootstrap_peak: ${mount_capacity_peak_snapshot}"
}

retry_transient_talos_bootstrap() {
  local attempt bootstrap_output bootstrap_status deadline remaining request_timeout retry_sleep

  deadline=$((SECONDS + 600))
  step "Retrying the transient Talos bootstrap handshake"
  if ! timeout --signal=KILL 5s talosctl cluster show --name "${CLUSTER_NAME}" >/dev/null 2>&1; then
    fail "Talos did not preserve cluster state after the transient bootstrap failure"
    return 1
  fi
  if ! timeout --signal=KILL 5s talosctl --context "${CLUSTER_NAME}" config info >/dev/null 2>&1; then
    fail "Talos did not preserve context '${CLUSTER_NAME}' after the transient bootstrap failure"
    return 1
  fi

  attempt=0
  while (( SECONDS < deadline )); do
    attempt=$((attempt + 1))
    remaining=$((deadline - SECONDS))
    request_timeout=5
    if (( remaining < request_timeout )); then
      request_timeout="${remaining}"
    fi
    (( request_timeout > 0 )) || break

    # Do not send bootstrap while apid is still between listeners.
    if ! timeout --signal=KILL "${request_timeout}s" talosctl \
      --context "${CLUSTER_NAME}" \
      --nodes "${TALOS_CP_IP}" \
      version >/dev/null 2>&1; then
      remaining=$((deadline - SECONDS))
      (( remaining > 0 )) || break
      if (( attempt == 1 || attempt % 12 == 0 )); then
        info "Waiting for Talos API (attempt ${attempt}; ${remaining}s remain)"
      fi
      retry_sleep=5
      if (( remaining < retry_sleep )); then
        retry_sleep="${remaining}"
      fi
      sleep "${retry_sleep}"
      continue
    fi

    remaining=$((deadline - SECONDS))
    (( remaining > 0 )) || break
    request_timeout=5
    if (( remaining < request_timeout )); then
      request_timeout="${remaining}"
    fi

    bootstrap_output=""
    bootstrap_status=0
    bootstrap_output="$(
      timeout --signal=KILL "${request_timeout}s" talosctl \
        --context "${CLUSTER_NAME}" \
        --nodes "${TALOS_CP_IP}" \
        bootstrap 2>&1
    )" || bootstrap_status=$?

    if (( bootstrap_status == 0 )); then
      ok "Talos bootstrap retry succeeded"
      return 0
    fi

    if is_provisional_talos_bootstrap_already_exists "${bootstrap_output}"; then
      warn "etcd is already initialized; treating this as provisional until the Kubernetes API check"
      return 0
    fi

    if is_retry_talos_bootstrap_unavailable_eof "${bootstrap_output}"; then
      remaining=$((deadline - SECONDS))
      (( remaining > 0 )) || break
      warn "Talos bootstrap handshake is still transient (attempt ${attempt}; ${remaining}s remain)"
      retry_sleep=5
      if (( remaining < retry_sleep )); then
        retry_sleep="${remaining}"
      fi
      sleep "${retry_sleep}"
      continue
    fi

    if is_retryable_talos_bootstrap_timeout_status "${bootstrap_status}"; then
      remaining=$((deadline - SECONDS))
      (( remaining > 0 )) || break
      warn "Talos bootstrap request hit its ${request_timeout}-second bound (attempt ${attempt}; ${remaining}s remain)"
      retry_sleep=5
      if (( remaining < retry_sleep )); then
        retry_sleep="${remaining}"
      fi
      sleep "${retry_sleep}"
      continue
    fi

    fail "Talos bootstrap retry returned a non-transient error:"
    printf '%s\n' "${bootstrap_output}" >&2
    return 1
  done

  fail "Talos bootstrap did not recover before its 600-second deadline"
  return 1
}

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
cluster_create_log="$(mktemp)"
cluster_create_status=0
start_mount_capacity_sampler
talosctl cluster create docker \
  --name "${CLUSTER_NAME}" \
  --image "${TALOS_IMAGE}" \
  --kubernetes-version "${KUBERNETES_VERSION}" \
  --workers 1 \
  --memory-controlplanes "${TALOS_MEMORY_CONTROLPLANE}" \
  --memory-workers "${TALOS_MEMORY_WORKER}" \
  --subnet "${TALOS_SUBNET}" \
  --exposed-ports "${NODEPORT_GITEA}:${NODEPORT_GITEA}/tcp,${NODEPORT_ARGOCD}:${NODEPORT_ARGOCD}/tcp,${NODEPORT_ZOT}:${NODEPORT_ZOT}/tcp,${NODEPORT_PORTAL}:${NODEPORT_PORTAL}/tcp,${NODEPORT_BACKSTAGE}:${NODEPORT_BACKSTAGE}/tcp,${NODEPORT_RUSTFS_S3}:${NODEPORT_RUSTFS_S3}/tcp,${NODEPORT_RUSTFS_CONSOLE}:${NODEPORT_RUSTFS_CONSOLE}/tcp,${NODEPORT_GRAFANA}:${NODEPORT_GRAFANA}/tcp,${NODEPORT_KOURIER}:${NODEPORT_KOURIER}/tcp,${NODEPORT_NATS}:${NODEPORT_NATS}/tcp" \
  "${patches[@]}" \
  2>&1 | tee "${cluster_create_log}" || {
    cluster_create_pipeline_status=("${PIPESTATUS[@]}")
    cluster_create_status="${cluster_create_pipeline_status[0]}"
    if (( cluster_create_status == 0 )); then
      cluster_create_status="${cluster_create_pipeline_status[1]}"
    fi
  }

cluster_create_output="$(tail -c 65536 "${cluster_create_log}")"
rm -f "${cluster_create_log}"

if (( cluster_create_status != 0 )); then
  if is_initial_talos_bootstrap_unavailable_eof "${cluster_create_output}" \
    && retry_transient_talos_bootstrap; then
    warn "Recovered the Talos v1.13 bootstrap handshake race"
  else
    collect_failed_cluster_logs
    die "Talos cluster creation failed"
  fi
fi

# --- 2. kubeconfig ------------------------------------------------------------------
step "Merging kubeconfig"
# Set the controlplane as the context's default node so every later
# talosctl command (yours included) works without a -n flag; on a fresh
# machine `talosctl kubeconfig` fails without this (found by rehearsal-in-CI).
if ! talosctl --context "${CLUSTER_NAME}" config node "${TALOS_CP_IP}"; then
  collect_failed_cluster_logs
  die "Could not select the Talos controlplane node"
fi

kubeconfig_ready=0
kubeconfig_deadline=$((SECONDS + 120))
while (( SECONDS < kubeconfig_deadline )); do
  if timeout --signal=KILL 10s talosctl --context "${CLUSTER_NAME}" kubeconfig --force; then
    kubeconfig_ready=1
    break
  fi
  sleep 5
done
if (( kubeconfig_ready == 0 )); then
  collect_failed_cluster_logs
  die "Could not retrieve kubeconfig from the Talos controlplane within 2 minutes"
fi
if ! kubectl config use-context "admin@${CLUSTER_NAME}" >/dev/null; then
  collect_failed_cluster_logs
  die "Could not select the Kubernetes context"
fi
ok "kubectl context: admin@${CLUSTER_NAME}"

step "Waiting for the Kubernetes API readyz and node list"
kubernetes_api_ready=0
kubernetes_api_deadline=$((SECONDS + 300))
while (( SECONDS < kubernetes_api_deadline )); do
  if timeout --signal=KILL 10s kubectl get --raw=/readyz >/dev/null 2>&1 \
    && timeout --signal=KILL 10s kubectl get nodes >/dev/null 2>&1; then
    kubernetes_api_ready=1
    break
  fi
  sleep 5
done
if (( kubernetes_api_ready == 0 )); then
  collect_failed_cluster_logs
  die "Kubernetes API readyz and node list did not become available within 5 minutes"
fi
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

stop_mount_capacity_sampler
final_capacity="$(host_capacity_snapshot)" \
  || die "Could not inspect final privileged mount namespace capacity."
final_mount_count="$(
  sed -n 's/.*max_namespace_mounts=\([0-9][0-9]*\).*/\1/p' \
    <<<"${final_capacity}"
)"
[[ "${final_mount_count}" =~ ^[0-9]+$ ]] \
  || die "Final mount namespace capacity did not contain a numeric maximum."
info "Peak mount capacity during cluster bootstrap: ${mount_capacity_peak_snapshot}"
info "Final host capacity after cluster bootstrap: ${final_capacity}"
if (( mount_capacity_sampler_failed != 0 )); then
  collect_failed_cluster_logs
  die "Privileged mount namespace sampling failed during Talos bootstrap."
fi
if (( mount_capacity_peak_count >= TALOS_DOCKER_GUARD_MOUNTS \
  || final_mount_count >= TALOS_DOCKER_GUARD_MOUNTS )); then
  collect_failed_cluster_logs
  die "Talos mount propagation approached the guarded namespace ceiling."
fi

echo
ok "Cluster '${CLUSTER_NAME}' is up — you now own a cloud. ☁️"
info "Next steps:"
echo "   ./scripts/bootstrap-gitops.sh   # module 2: Gitea + ArgoCD"
echo "   ./scripts/seed-gitea.sh         # module 2: push this repo to your cloud"
info "Useful:"
echo "   talosctl --context ${CLUSTER_NAME} dashboard   # Talos node dashboard"
echo "   ./scripts/destroy-cluster.sh                          # tear it all down"
