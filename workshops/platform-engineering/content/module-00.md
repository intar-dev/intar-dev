# Module 00 — Workspace pre-flight

## The goal

At the end of this module your persistent Debian 13 Intar workspace is provably ready
for the whole workshop: the pinned tools work, Docker has the declared resources, and
every required container image is already available locally. You prove it with the
pinned manual verifier exiting 0.

## Why this matters

The workshop runtime must not depend on venue or home internet. Intar built and cold-
booted checkpoint 00 before this session with the repository, toolchain, and all
non-optional images already inside the guest. That is also platform-engineering lesson
#1: a platform you cannot recover without reaching someone else's service is not fully
under your control.

Do **not** install tools, run `apt`, or pull images. A missing prerequisite is an image
contract failure, not learner setup work.

## The task

1. Check in from the Intar workshop room and wait for your facilitator to provision the
   workspace from checkpoint 00.
2. Open **Workspace terminal**. This is a shell inside your own persistent Debian 13 VM.
3. Inspect the baked contract:

   ```bash
   cd /opt/platform-engineering-workshop
   git --version
   kubectl version --client
   talosctl version --client
   docker info --format 'CPUs={{.NCPU}} Memory={{.MemTotal}}'
   curl -fsS http://localhost:5001/v2/_catalog | jq .
   ```

   `localhost` here means the Intar guest itself. It is appropriate for terminal/API
   checks; browser applications are opened with the released Intar app buttons instead.

4. Run the pinned verifier:

   ```bash
   cd /opt/platform-engineering-workshop/lab/00-setup
   ./verify.sh
   ```

5. If it is not green, click **Need help** and share the failing check. Do not repair the
   base image by installing or downloading anything. A helper can confirm the contract;
   the facilitator can restore checkpoint 00 or reprovision the workspace.

## Hints

## Check your work

```bash
cd /opt/platform-engineering-workshop/lab/00-setup
./verify.sh
```

It checks the Docker daemon and declared resources, free disk, each pinned CLI
(`talosctl`, `kubectl`, `helm`, `cilium`, `jq`, `git`, `curl`), the repository pre-flight,
and the local `cloudbox-mirror` registry on port 5001. Nothing in the check should fetch
from the internet.

## Explain-back

Tell your neighbor: why does this workshop refuse to install tools or pull images during
the session? (One reason is reliability; the other is the platform-sovereignty message.)

## Going deeper

- Inspect the pre-baked image catalog:
  `curl -fsS http://localhost:5001/v2/_catalog | jq .`
- Read `scripts/install.sh` without running its install path. A pre-flight gate is itself
  a platform artifact. What would your team's version check?
- Compare the declared VM resources in the workshop room with `docker info`. Which layer
  owns each limit?

## Optional AI assistance

An external assistant can help interpret an error, but it is never required and the
workshop does not assume network access or an API key. The verifier, hints, helper flow,
and checkpoint recovery are the complete offline path.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/00-setup/verify.sh`. Layered hints and the solution are released separately by Intar.
