The offline rule is the first platform-engineering lesson of the day. If the platform
cannot recover without reaching the internet, it is a client of someone else's platform.

Intar's trusted publication builder puts the pinned repository, toolchain, and all
non-optional images into checkpoint 00, cold-boots it, and verifies it before a session
may use the revision. Learners never run setup scripts or compensate for a missing image.

The fixed guest contract is Debian 13, 4 vCPU, 16 GiB RAM, and 100 GiB disk. Talos in
Docker, Cilium/eBPF, privileged build workloads, and every declared browser adapter must
work in that actual guest kernel.
