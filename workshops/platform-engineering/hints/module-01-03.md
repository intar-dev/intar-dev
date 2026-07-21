# Hint 3: Proving the Cilium / no-kube-proxy story

- Cilium health, without any extra tools:
  `kubectl -n kube-system get pods -l k8s-app=cilium` and
  `cilium status --wait` (the CLI reads cluster state).
- kube-proxy is absent: `kubectl -n kube-system get ds,pods | grep -c kube-proxy` should
  find nothing. Yet `kubectl get svc -A` shows Services with ClusterIPs that work.
- Ask Cilium who handles Services:
  `kubectl -n kube-system exec ds/cilium -c cilium-agent -- cilium-dbg status | grep -i kubeproxy` —
  look for `KubeProxyReplacement: True`. eBPF programs attached in the kernel are doing
  what iptables rules used to do.
- One more: Cilium reaches the API server via `localhost:7445` — that's Talos **KubePrism**,
  a node-local API-server load balancer. Find it in the machine config.
