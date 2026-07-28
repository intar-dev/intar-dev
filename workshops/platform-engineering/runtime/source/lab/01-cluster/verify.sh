#!/usr/bin/env bash
# Module 01 — verify the Talos + Cilium cluster.
set -euo pipefail

FAILED=0
ok()   { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }

# --- Docker containers -----------------------------------------------------
# Filter on the talosctl-applied label — a name prefix would also match the
# cloudbox-mirror registry container.
CONTAINERS="$(docker ps -q --filter "label=talos.cluster.name=cloudbox" 2>/dev/null | wc -l | tr -d ' ')"
if [ "${CONTAINERS:-0}" -ge 2 ]; then
  ok "cloudbox Talos node containers are running (${CONTAINERS})"
else
  fail "expected 2 running Talos node containers, found ${CONTAINERS:-0} — run ./scripts/create-cluster.sh"
fi

# --- kubectl reachability --------------------------------------------------
if kubectl version >/dev/null 2>&1; then
  ok "kubectl reaches the API server"
else
  fail "kubectl cannot reach the cluster — did create-cluster.sh finish? Try: talosctl kubeconfig -n 10.5.0.2"
  echo; echo "❌ Cannot check further without API access."; exit 1
fi

# --- Nodes Ready -----------------------------------------------------------
NODES_TOTAL="$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')"
NODES_READY="$(kubectl get nodes --no-headers 2>/dev/null | awk '$2 == "Ready"' | wc -l | tr -d ' ')"
if [ "$NODES_TOTAL" -eq 2 ] && [ "$NODES_READY" -eq 2 ]; then
  ok "2/2 nodes Ready"
else
  fail "want 2 Ready nodes, have ${NODES_READY}/${NODES_TOTAL} — 'kubectl describe node' the NotReady one; if CNI-related, check the cilium pods"
fi

# --- Cilium DaemonSet healthy ----------------------------------------------
DESIRED="$(kubectl -n kube-system get ds cilium -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 0)"
READY="$(kubectl -n kube-system get ds cilium -o jsonpath='{.status.numberReady}' 2>/dev/null || echo 0)"
if [ "${DESIRED:-0}" -gt 0 ] && [ "$DESIRED" = "$READY" ]; then
  ok "Cilium DaemonSet healthy (${READY}/${DESIRED})"
else
  fail "Cilium DaemonSet not healthy (${READY}/${DESIRED} ready) — kubectl -n kube-system get pods -l k8s-app=cilium; describe the bad pod"
fi

# --- Cilium operator -------------------------------------------------------
if kubectl -n kube-system wait --for=condition=Available deploy/cilium-operator --timeout=5s >/dev/null 2>&1; then
  ok "cilium-operator Available"
else
  fail "cilium-operator not Available — kubectl -n kube-system logs deploy/cilium-operator"
fi

# --- kube-proxy must be absent ---------------------------------------------
KP="$(kubectl -n kube-system get pods --no-headers 2>/dev/null | awk '/kube-proxy/ {n++} END {print n+0}')"
if [ "${KP:-0}" -eq 0 ]; then
  ok "no kube-proxy pods (Cilium eBPF handles Services)"
else
  fail "found ${KP} kube-proxy pod(s) — this cluster should be kube-proxy-free; was it created with ./scripts/create-cluster.sh?"
fi

# --- Cilium says it replaces kube-proxy -------------------------------------
if kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status --brief >/dev/null 2>&1; then
  KPR="$(kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status 2>/dev/null | grep -i 'KubeProxyReplacement' | head -1 || true)"
  if echo "$KPR" | grep -qiE 'true|strict'; then
    ok "Cilium KubeProxyReplacement active"
  else
    fail "Cilium does not report KubeProxyReplacement active (${KPR:-no output}) — check the Helm values used by create-cluster.sh"
  fi
else
  fail "could not exec into a cilium pod to check status — kubectl -n kube-system get pods -l k8s-app=cilium"
fi

# --- CoreDNS up (proves pod networking + Services actually work) ------------
if kubectl -n kube-system wait --for=condition=Available deploy/coredns --timeout=5s >/dev/null 2>&1; then
  ok "CoreDNS Available (pod networking + Services work end to end)"
else
  fail "CoreDNS not Available — usually a CNI problem; kubectl -n kube-system get pods and look at coredns events"
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "❌ $FAILED check(s) failed. Worst case is always fine: ./scripts/destroy-cluster.sh && ./scripts/create-cluster.sh"
  exit 1
fi
echo "✅ Module 01 complete — you own a cloud. Two-minute explain-back, then on to GitOps."
