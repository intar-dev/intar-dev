The script takes 3–5 minutes — the lab explicitly says to READ it while it runs. It's short on purpose: everything it does, they could type.

Then the investigation questions in the README: what is the management plane if there's no SSH? Show the machine config document. Open the Talos dashboard. Show Cilium healthy — and prove kube-proxy doesn't exist, then explain who answers Service traffic.

Explain-back at the end: "tell your neighbor what is MISSING from these nodes, and why that's a feature."

Presenter/helper notes:
- Talos v1.13 pinned (never 1.12.x — known-bad in Docker); node memory limits are raised in the script.
- If Talos-in-Docker, Cilium/eBPF, or privileged Docker fails in a learner guest, treat it as an image/kernel contract failure. Use **Need help**, restore checkpoint 00/01, or reprovision on an eligible runner. Do not switch the lab to kind; the published image must prove the intended stack.
- Walk the solution on screen at ~30 min to re-sync the room.
