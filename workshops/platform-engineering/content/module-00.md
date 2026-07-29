# Module 00 — Workspace and registry pre-flight

## The goal

Prove that this learner's Debian 13 server has the pinned toolchain, a usable
Docker daemon, enough CPU and memory, and an HTTPS path to every declared
external registry. Intar performs the slow installation and manifest checks
while applying checkpoint 00; no laptop setup or local image mirror is used.

## The task

From `/opt/platform-engineering-workshop`:

```bash
cd lab/00-setup
./verify.sh
```

If it fails, keep the complete output and request help. A missing tool, an
unreachable registry, or an undersized Docker runtime is a provisioning
failure—not something the learner should repair by installing unpinned
software. The facilitator can recreate the workspace from checkpoint 00.

## Check your work

The verifier checks Debian 13 on x86-64, Docker, at least four CPUs and 15 GiB
of usable memory, the pinned CLI set, the signed source installation, and the
registry-preflight marker written only after every digest in
`scripts/images.lock` was resolved over HTTPS.

## Explain-back

Tell your neighbor why a content-addressed image reference prevents tag drift,
and why it still does not remove the workshop's dependency on working DNS,
TLS, registry availability, and provider rate limits.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/00-setup/verify.sh`. Layered hints and the solution are released separately by Intar.
