# Full solution

```bash
./scripts/create-cluster.sh

# The management plane is an API, not SSH:
talosctl -n 10.5.0.2 get machineconfig -o yaml | less   # /cni and /proxy to find the sections
talosctl -n 10.5.0.2 dashboard                           # q to quit
talosctl -n 10.5.0.2 get members
talosctl -n 10.5.0.2 services

# Kubernetes + Cilium:
kubectl get nodes -o wide
cilium status --wait
kubectl -n kube-system get ds                            # cilium yes, kube-proxy: absent
kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status | grep -i kubeproxy

cd lab/01-cluster && ./verify.sh
```
