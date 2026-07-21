# Module 01 — Your own cloud: Talos Linux + Cilium

## The goal

At the end of this module a two-node Kubernetes cluster called **cloudbox** runs inside
your Intar guest: Talos Linux nodes (in Docker), networked by Cilium's eBPF datapath, with **no
kube-proxy and no SSH anywhere**. You can prove it with `kubectl get nodes` showing two
Ready nodes and `./verify.sh` green — and, more importantly, you can explain what's
*missing* from these nodes and why.

## Why this matters

Every cloud provider runs an OS under your Kubernetes that you never see. Today you own
that layer. Talos Linux is an immutable, API-only operating system built solely to run
Kubernetes: no shell, no SSH, no package manager — the entire machine is one declarative
config document managed over a gRPC API (`talosctl`). Cilium replaces both the CNI *and*
kube-proxy with eBPF programs in the kernel. This combination is what "production-grade"
looks like in 2026 — and it fits in the dedicated 16 GiB workspace.

## The task

1. Create the cluster:

   ```bash
   ./scripts/create-cluster.sh
   ```

   While it runs (~3–5 min), read the script. It is short on purpose — everything it does,
   you could type.

2. Now **prove to yourself what you just built**. Find answers to these, using `talosctl`
   and `kubectl` (hints below if you want them):

   - There is no SSH. What *is* the management plane? Show the machine's config document
     without logging into anything.
   - Open the Talos dashboard for a node. What is the machine doing right now?
   - Which cluster members does Talos itself know about (not Kubernetes — Talos)?
   - Kubernetes says both nodes are `Ready`. What is doing the networking? Show that
     Cilium is healthy — and show that **kube-proxy does not exist** in this cluster.
     Who answers Service traffic then?

3. Run `./verify.sh`.

## Hints

## Check your work

```bash
./verify.sh
```

It checks: the cloudbox Docker containers exist; both nodes are `Ready`; the Cilium
DaemonSet is fully available; Cilium reports kube-proxy replacement active; and no
kube-proxy is running anywhere.

## Explain-back

Tell your neighbor: this node has no SSH and no package manager. Name two concrete
*operational* problems that design deletes (think: patching, drift, attack surface, "who
changed what").

## Going deeper

- Break a node on purpose: `docker pause cloudbox-worker-1`, watch `kubectl get nodes -w`
  and the Talos dashboard react, then `docker unpause` it.
- `talosctl -n 10.5.0.2 read /proc/version` — you can read files via the API, but try to
  *write* something. What stops you?
- Compare `kubectl -n kube-system get pods` on this cluster with any managed-cloud cluster
  you have access to. What's missing here, and what does the cloud hide from you there?

## If it goes wrong

The cluster is cattle: `./scripts/destroy-cluster.sh && ./scripts/create-cluster.sh` is
safe and takes ~5 minutes because the images are local. If Talos-in-Docker, Cilium/eBPF,
or a privileged workload fails in the Intar guest, click **Need help**. That is a
dedicated image/kernel contract failure; restore the checkpoint or reprovision instead
of changing the lab to a kind fallback.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/01-cluster/verify.sh`. Layered hints and the solution are released separately by Intar.
