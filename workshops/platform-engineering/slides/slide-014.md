# Layer 1 — the metal & the network

RoleWe runRejectedThe tradeoff

K8s OS**talos** **Talos v1.13.6**kubeadm · minikube · kindNo shell, no SSH, no drift — you lose the escape hatch on purpose
CNI + proxy**cilium** **Cilium 1.19.5**flannel + kube-proxyeBPF datapath, kube-proxy-free — needs kernel ≥5.10

- **Talos** is one `machineconfig` document managed over a gRPC API — the node *is* a declarative resource. kind stays in the repo as the strictly-more-robust fallback; it's a mutable node you can shell into, which is exactly what Talos refuses to be.
- **Cilium** replaces kube-proxy entirely: no growing pile of iptables rules, identity-based policy, `kubeProxyReplacement` via KubePrism on `:7445`. Service traffic is answered by eBPF programs in-kernel — there is no kube-proxy pod to find.
