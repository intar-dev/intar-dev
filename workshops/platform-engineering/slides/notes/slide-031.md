The script takes 3–5 minutes — the lab explicitly says to READ it while it runs. It's short on purpose: everything it does, they could type.

Then the investigation questions in the README: what is the management plane if there's no SSH? Show the machine config document. Open the Talos dashboard. Show Cilium healthy — and prove kube-proxy doesn't exist, then explain who answers Service traffic.

Explain-back at the end: "tell your neighbor what is MISSING from these nodes, and why that's a feature."

Presenter/helper notes:
- Talos v1.13 pinned (never 1.12.x — known-bad in Docker); node memory limits are raised in the script.
- If Talos-in-Docker won't cooperate on someone's machine (rare, usually exotic firewall/nftables setups on Linux), don't debug past ~10 minutes: kind-fallback.sh gives them kind+Cilium and they rejoin from module 02 with everything else identical.
- Walk the solution on screen at ~30 min to re-sync the room.
