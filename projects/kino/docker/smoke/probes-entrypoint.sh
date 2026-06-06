#!/bin/sh
set -eu

cleanup() {
  if [ -n "${KINO_PID:-}" ]; then
    kill "${KINO_PID}" >/dev/null 2>&1 || true
  fi
  if [ -n "${K0S_PID:-}" ]; then
    kill "${K0S_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

k0s controller --single --ignore-pre-flight-checks &
K0S_PID=$!

echo "waiting for k0s API readiness..."
i=0
while [ "${i}" -lt 120 ]; do
  if k0s kubectl get nodes >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

if [ "${i}" -ge 120 ]; then
  echo "k0s did not become ready in time" >&2
  exit 1
fi

k0s kubeconfig admin >/etc/kino/kubeconfig
echo "waiting for default service account..."
j=0
while [ "${j}" -lt 120 ]; do
  if k0s kubectl -n default get serviceaccount default >/dev/null 2>&1; then
    break
  fi
  j=$((j + 1))
  sleep 1
done
if [ "${j}" -ge 120 ]; then
  echo "default service account did not become ready in time" >&2
  exit 1
fi

k0s kubectl run kino-check \
  --image=registry.k8s.io/pause:3.10 \
  --restart=Never \
  --labels=app=kino-check \
  --dry-run=client -o yaml \
  | k0s kubectl apply -f -

kino --config /etc/kino/kino.hcl &
KINO_PID=$!

wait "${KINO_PID}"
