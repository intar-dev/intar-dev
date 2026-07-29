# Fault 01 — spoiler

**Symptom:** the `web` pod in `faultlab-01` remains in
`ErrImageNeverPull` even though its image is pinned to the reviewed BusyBox
digest.

**Root cause:** the Deployment sets `imagePullPolicy: Never`. A fresh Talos
node has not imported that digest into its own containerd store, so kubelet is
explicitly forbidden from retrieving it from the external registry.

Follow `kubectl get pods` with `kubectl describe pod`; the Event text names
the policy failure. Fix the Deployment source by changing the policy to
`IfNotPresent` while keeping the exact digest. This retains the workshop's
immutable external-image contract and teaches the same Events-first diagnostic
path without introducing a floating or misspelled tag.
