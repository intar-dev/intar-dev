# Hint 2: Commands for the "network is lying to me" faults

```bash
kubectl -n  get endpoints           # who does the Service ACTUALLY route to?
kubectl -n  get pods --show-labels       # do labels match what selectors assume?
kubectl get ciliumnetworkpolicies,netpol -A  # who restricts traffic?
kubectl -n kube-system exec ds/cilium -c cilium-agent -- \
  cilium-dbg monitor --type drop             # watch the datapath drop packets, live
```
