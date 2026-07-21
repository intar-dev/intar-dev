# Hint 2: The machine config, dashboard, and members

- Machine config (the *entire OS* as one document):
  `talosctl -n 10.5.0.2 get machineconfig -o yaml | less` — look for the `cluster.network.cni`
  and `cluster.proxy` sections; that's where we told Talos "no default CNI, no kube-proxy".
- Live dashboard: `talosctl -n 10.5.0.2 dashboard` (q to quit).
- Talos' own view of the cluster: `talosctl -n 10.5.0.2 get members`.
- Also fun: `talosctl -n 10.5.0.2 services` — count how few moving parts a node has.
