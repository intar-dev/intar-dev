The concept: CI is the last thing teams believe they can't self-host ("but we need GitHub Actions!"). Strip the branding and a build is just a pod doing elevated filesystem tricks, and a registry is a single binary.

The 2026 stack, accurately: Kaniko — the old in-cluster build answer — is archived/dead. Rootless BuildKit is its replacement. Zot is the CNCF registry, one small binary. Argo Workflows orchestrates: clone from the in-cluster Gitea, build with BuildKit, push to Zot, deploy. Every hop of git → build → push → deploy happens inside the laptop's cluster — zero external services.

One honest detail worth teaching: the builds namespace is labeled PSA-privileged, because rootless BuildKit needs an unconfined seccomp profile. Finding that label and understanding why it exists is part of the lab — security boundaries for builds are a real platform-team concern, not workshop trivia.

Honesty note from the lab README, worth repeating from the front: this is the least-rehearsed path in the workshop — rootless BuildKit on Talos has no published prior art. It's a presenter demo first, self-paced lab second. If it fights you, watch the demo, file the scars, move on.
