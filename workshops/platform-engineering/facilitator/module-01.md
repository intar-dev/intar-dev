# Facilitator notes — module 01

The first real module, and the biggest identity shift of the day: every cloud provider runs an operating system under your Kubernetes that you never get to see. For the next 35 minutes, attendees take ownership of that layer.


---

Talos in one breath: an operating system built solely to run Kubernetes. There is no shell to SSH into, no package manager to drift, no /etc to hand-edit. The ENTIRE machine is one declarative config document — the machineconfig — and the only way to manage the node is talosctl talking to a gRPC API. The OS is managed exactly like a Kubernetes resource: declare, apply, reconcile.

Why this matters: the attack surface and the snowflake surface both collapse. This is what production-grade looks like in 2026 — and it runs as nested Docker workloads inside the dedicated Debian 13 Intar guest.

Cilium: does the pod networking in eBPF programs in the kernel, and also REPLACES kube-proxy entirely. In the lab they'll verify there is no kube-proxy pod anywhere — and figure out who answers Service traffic instead (eBPF programs attached in-kernel).

The lab is deliberately investigative: create the cluster with one script, then prove to yourself what you built — show a machineconfig without logging in anywhere, open the Talos dashboard, ask Talos (not Kubernetes) who its members are, show Cilium healthy and kube-proxy absent.


---

The script takes 3–5 minutes — the lab explicitly says to READ it while it runs. It's short on purpose: everything it does, they could type.

Then the investigation questions in the README: what is the management plane if there's no SSH? Show the machine config document. Open the Talos dashboard. Show Cilium healthy — and prove kube-proxy doesn't exist, then explain who answers Service traffic.

Explain-back at the end: "tell your neighbor what is MISSING from these nodes, and why that's a feature."

Presenter/helper notes:
- Talos v1.13 pinned (never 1.12.x — known-bad in Docker); node memory limits are raised in the script.
- If Talos-in-Docker, Cilium/eBPF, or privileged Docker fails in a learner guest, treat it as an image/kernel contract failure. Use **Need help**, restore checkpoint 00/01, or reprovision on an eligible runner. Do not switch the lab to kind; the published image must prove the intended stack.
- Walk the solution on screen at ~30 min to re-sync the room.
