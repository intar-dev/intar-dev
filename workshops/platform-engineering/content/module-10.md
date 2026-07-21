# Module 10 — Day-2 operations: roll back a bad release

## The goal

At the end of this module, `gitops/components/demo/demo-web.yaml` in your
`cloudbox/platform` repo contains a forward revert of the bad release, Argo CD has
reconciled that Git history into namespace `demo`, and every `demo-web` replica is
healthy. `./verify.sh` proves both the repository and the live rollout.

## Prerequisites and offline contract

This is a stretch module. Its only prerequisites are module 01's cluster and module 02's
Gitea + Argo CD path, including the `demo` Application. It needs nothing from modules
06–09 and its complete verified path runs inside the Intar guest with the baked images.

The workload this module breaks, `demo-web`, is owned by the lab. The first run of
`./inject.sh 1`, `2`, or `3` seeds its healthy Deployment and Service into your
`cloudbox/platform` repo. After Argo CD converges, run the same injection again to push
the fault. A push to `cloudbox/platform:main` is the deploy trigger throughout; there is
no external CI, image pull needed for the healthy path, or live-console repair.

`cloudbox/demo-app` is not used by this module. It is application source for module 07,
not the GitOps configuration that owns `demo-web`.

## Why this matters

Bad releases rarely introduce a manifest labeled `BROKEN`. They look like routine
automation changes, reach Git, and produce symptoms several layers away. Day-2
operations starts by observing the failure, writing a falsifiable diagnosis, and proving
it before acting.

The required path is deliberately human and deterministic: **signal → evidence → Git
diff → forward revert → verification**. A live `kubectl edit` is not a repair—Argo CD
self-healing will restore whatever Git says.

## The setup

| # | Scenario | Needs | Flavor |
|---|----------|-------|--------|
| 1 | `01-bad-release-rollback` | module 02's `demo` Application | a plausible release that crashes every new replica |
| 2 | `02-oomkill-crashloop` | module 02's `demo` Application | a plausible rightsizing commit that OOMKills every replica on a cadence |
| 3 | `03-dockerhub-imagepull` | module 02's `demo` Application | an unmirrored image reference that deterministically fails while the workspace is offline |

```bash
./inject.sh 1        # first run: seed the healthy demo-web baseline
./inject.sh 1        # second run, after convergence: push the bad release
./restore.sh 1       # canonical Git revert / give up gracefully
./inject.sh 2        # same two-run pattern for the OOM fault
./restore.sh 2
./inject.sh 3        # the invalid external-registry reference is the fault
./restore.sh 3
./restore.sh clean   # revert every currently injected scenario
```

The scenario directory has `description.md`—that is the spoiler. Do not open it until
you have committed to a diagnosis. `fix.sh` is the canonical scripted repair.

## The task

The guided path uses scenario 1; scenarios 2 and 3 use the same loop.

1. Run `./inject.sh 1`. The first run only seeds the healthy baseline. Wait for
   `kubectl -n demo rollout status deploy/demo-web`, then run it again to push the fault.
2. Open the released **Cloudbox Console** app and inspect the `demo` application signal.
   In the terminal, find the first visible symptom in namespace `demo`.
3. Write a one-sentence diagnosis before changing anything: "The new pods crash because
   X changed Y."
4. Verify or falsify it with live evidence. Follow pod state to Events, logs, Deployment
   configuration, rollout history, and Git history as needed.
5. Clone or enter your guest-local Gitea repository, revert the commit that introduced
   the fault, and push the forward revert to `cloudbox/platform:main`. Do not edit or
   patch the live Deployment.
6. Run `./verify.sh` and keep investigating until both Git and the live rollout pass.

Everything above is offline and sufficient for verified completion.

## Optional: compare an AI diagnosis

This extension is **not part of module completion**, is not checked by `verify.sh`, and
must never delay the room. The workshop supplies hints, solution reveal, helper consent,
and checkpoint recovery as the complete offline support path.

If you independently have network access and an external model credential, you may
enable the baked Kagent capability through GitOps and connect a provider to compare its
read-only diagnosis with yours. Open investigations only through the released
**Cloudbox Console** app. Do not expose Kagent's API or UI as another workspace port.

The safety model is worth inspecting even when you skip the model call:

- `kagent-tools.rbac.readOnly: true` and the tool server's `--read-only` flag give the
  agent eyes but no Kubernetes write path.
- Treat every hypothesis as untrusted until one explicit observation confirms it.
- The human performs the Git revert; there is no auto-remediation path.
- Never paste a secret into Git. External provider cost, terms, availability, and
  connectivity are outside the workshop contract.

The rule remains: **the agent gets eyes; Git keeps the hands**.

## Hints

### Scenario 1: bad release rollback

### Scenario 2: OOMKill crashloop

### Scenario 3: an unmirrored image reference

## Check your work

```bash
./verify.sh
```

The check fails while Git still contains the poisoned value. Once Git is clean, it also
requires the live Deployment rollout to complete and rejects crashlooping or repeatedly
restarting pods. These checks are separate on purpose: a live-only fix cannot bypass the
platform's Git-only write path.

## Explain-back

Tell your neighbor which observation connected the pod's restart loop to the exact Git
diff, and why reverting Git is safer here than editing the live Deployment—even if the
live edit appears to work for a minute.

## Going deeper

- Watch `kubectl -n demo get rs,pods -w` during reinjection. Explain why the old
  ReplicaSet remains and what availability the rolling-update strategy preserves.
- Inspect Deployment conditions before and after its progress deadline. Distinguish
  "available through old replicas" from "the new rollout succeeded."
- Optionally ask any read-only agent for a diagnosis and the command that would falsify
  it. Keep the evidence check and Git revert human-controlled.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/10-day2-ops/verify.sh`. Layered hints and the solution are released separately by Intar.
