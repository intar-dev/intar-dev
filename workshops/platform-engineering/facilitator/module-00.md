# Facilitator notes — module 00

This is an Intar capacity and image-contract gate, not laptop setup. Open the lobby 30
minutes before the scheduled start, ask learners to check in, then bulk-provision the
checked-in roster from checkpoint 00. The guest is Debian 13 with 4 vCPU, 16 GiB RAM,
100 GiB disk, the pinned toolchain, repository, and all non-optional images already
baked and cold-boot verified.

Learners do not run `dev-setup.sh`, `cloudbox-init.sh`, `apt`, or image pulls. Their only
setup work is opening the Intar workspace terminal and running the pinned verifier at
`/opt/platform-engineering-workshop/lab/00-setup/verify.sh`.

---

The offline rule remains the first platform-engineering lesson: if a platform cannot
recover without reaching the internet, it is a client of someone else's platform. Here
the trusted publication builder performs the expensive networked assembly once;
checkpoint 00 makes the live learner path deterministic and offline.

Use the control room while provisioning. Treat allocation failures, missing cached
images, a failed verifier, or a missing guest capability as platform incidents. Helpers
can inspect via a learner-approved browser-terminal grant; they should not install a
workaround. Restore checkpoint 00 or reprovision on an eligible organization runner.

---

Set the pre-flight timer visibly. Ask learners to prove four things: the expected tools
exist, Docker sees the declared resources, the local mirror answers, and `verify.sh` is
green. Learners already green can inspect module 01 or help a neighbor through Intar's
**Need help** queue.

Do not advance until the control room shows enough verified workspaces for the core
session. A learner who joins late was already on the roster: provision them from
checkpoint 00, or from a facilitator-selected predecessor checkpoint and record the
skipped technical work as caught up.
