Talos in one breath: an operating system built solely to run Kubernetes. There is no shell to SSH into, no package manager to drift, no /etc to hand-edit. The ENTIRE machine is one declarative config document — the machineconfig — and the only way to manage the node is talosctl talking to a gRPC API. The OS is managed exactly like a Kubernetes resource: declare, apply, reconcile.

Why this matters: the attack surface and the snowflake surface both collapse. This is what production-grade looks like in 2026 — and it runs as nested Docker workloads inside the dedicated Debian 13 Intar guest.

Cilium: does the pod networking in eBPF programs in the kernel, and also REPLACES kube-proxy entirely. In the lab they'll verify there is no kube-proxy pod anywhere — and figure out who answers Service traffic instead (eBPF programs attached in-kernel).

The lab is deliberately investigative: create the cluster with one script, then prove to yourself what you built — show a machineconfig without logging in anywhere, open the Talos dashboard, ask Talos (not Kubernetes) who its members are, show Cilium healthy and kube-proxy absent.
