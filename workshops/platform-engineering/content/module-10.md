# Module 10 — Day-2 operations: roll back a bad release

## The goal

At the end of this module, `gitops/components/demo/demo-web.yaml` in your
`cloudbox/platform` repo contains a forward revert of the bad release, ArgoCD has
reconciled that Git history into namespace `demo`, and every `demo-web` replica is
healthy. `./verify.sh` proves both the repository and the live rollout.

## Prerequisites and interface contract

This is a stretch module. Its only prerequisites are the cluster module and the GitOps
module (module 02) — you need Gitea + ArgoCD running and the `demo` Application
(`gitops/apps/demo.yaml`, watching `gitops/components/demo/` in your platform repo) from
module 02 already enabled. Module 10 needs nothing from the build/serverless/portal
stretch modules (06-09).

The workload this module breaks, `demo-web`, is **owned by this lab, not hand-copied by
you**: the first time you run `./inject.sh 1`, `./inject.sh 2`, or `./inject.sh 3`, it seeds
`gitops/components/demo/demo-web.yaml` (a plain Deployment + Service running the same
pre-pulled `ghcr.io/knative/helloworld-go` image module 06 uses — no in-cluster build
required) into your `cloudbox/platform` repo and pushes it, then asks you to wait for
ArgoCD and run the same scenario again to actually inject the fault. A push to
`cloudbox/platform:main` is the deploy trigger throughout — there is no BuildKit or
rebuild step in this exercise.

`cloudbox/demo-app` (the repo `scripts/seed-gitea.sh` seeds from `apps/demo-app`) is
**not** used by this module — it is Go source for module 07's separate in-cluster build
golden path and carries no deploy manifests. If you find yourself investigating it while
working this scenario, that's a dead end (see the scenario's spoiler once you're stuck).

## Why this matters

Bad releases rarely introduce a manifest labeled `BROKEN`. They look like routine
automation changes, reach Git, and produce symptoms several layers away. Day-2
operations starts by observing the failure, writing a falsifiable diagnosis, and proving
it before acting.

These scenarios are the human-only path; no agent is required. The operating model still
applies: **the agent gets eyes; Git keeps the hands**. Whether a human or agent finds the
cause, `git revert` and push is the only durable write path. A live `kubectl edit` is not
a repair—ArgoCD self-healing will restore whatever Git says.

Work through at least one scenario by hand first — that's where the triage muscle memory
lives. Once you've done that, "Escalate to the agent" below reruns the same kind of
investigation through Kagent, the platform's own read-only agent, in two beats: a fully
digest-pinned model that flails, then a one-line `ModelConfig` change that fixes it.

## The setup

| # | Scenario | Needs | Flavor |
|---|----------|-------|--------|
| 1 | `01-bad-release-rollback` | module 02's `demo` Application | a plausible release that crashes every new replica |
| 2 | `02-oomkill-crashloop` | module 02's `demo` Application | a plausible rightsizing commit that OOMKills every replica on a cadence |
| 3 | `03-dockerhub-imagepull` | module 02's `demo` Application | a plausible registry-migration commit that pulls from Docker Hub instead of the GHCR mirror |

```bash
./inject.sh 1        # first run: seeds the demo-web baseline, then stops
./inject.sh 1        # second run (after ArgoCD converges): pushes the bad release commit
./restore.sh 1       # apply the canonical Git revert / give up gracefully
./inject.sh 2        # first run: seeds the same baseline if it is not present
./inject.sh 2        # second run (after ArgoCD converges): pushes the rightsizing commit
./restore.sh 2       # revert the memory-rightsizing commit / give up gracefully
./inject.sh 3        # first run: seeds the same baseline if it is not present
./inject.sh 3        # second run (after ArgoCD converges): pushes the registry commit
./restore.sh 3       # revert the Docker Hub registry commit / give up gracefully
./restore.sh clean   # revert every currently injected scenario
```

The scenario directory has `description.md`—**that is the spoiler**. Do not open it
until you have committed to a diagnosis. `fix.sh` is the canonical scripted repair.

## The task

The guided path below uses scenario 1; scenarios 2 and 3 follow the same observe,
diagnose, prove, and Git-revert loop using their own setup-table commands and hints.

1. Run `./inject.sh 1`. The first run only seeds the `demo-web` baseline and tells you to
   wait for ArgoCD; run it again once `kubectl -n demo rollout status deploy/demo-web`
   reports success, to actually push the bad release.
2. Find the first visible symptom in namespace `demo`.
3. Write a one-sentence diagnosis before changing anything: “The new pods crash because
   X changed Y.”
4. Verify or falsify that sentence with live evidence. Follow the pod state to Events,
   logs, the Deployment configuration, rollout history, and finally Git history as needed.
5. Revert the commit that introduced the fault and push the revert to
   `cloudbox/platform:main`. Do not edit or patch the live Deployment.
6. Run `./verify.sh` and keep investigating until both Git and the live rollout pass.

## Hints

### Scenario 1: bad release rollback

### Scenario 2: OOMKill crashloop

### Scenario 3: Docker Hub sneaks in

## Optional agent-assisted investigation on the CX43 path

Every scenario above has a fourth rung on the escalation ladder, beyond the three hints:
Kagent, the platform's own read-only agent, streaming a live investigation into a "Case
file" on the demo component's page in the Console. This is the module's second half — the
same fault, worked twice, with one field changed in between.

**Say the honest-spec line out loud before you start:** beat 1 runs a real model on your
host, *beside* the whole running cluster. That needs the **32 GB "comfortable" spec from module 00**. On
the **16 GB minimum spec, beat 1 does not fit next to the running stack** — skip straight
to "Beat 2" below. That is not a lesser path; it costs no extra RAM, and it's the one
that actually fits your machine.

### Use the hosted-model path

CX43 has 16 GiB RAM, so Intar intentionally omits the source workshop's
host-side Ollama beat. Enable Kagent through the GitOps catalog as described,
then replace its default ModelConfig with the hosted provider configuration in
Beat 2 before opening an investigation. The human-only fault diagnosis and
verification path above remains complete and needs no model or API key.

### Beat 2: one `ModelConfig` push, and it actually diagnoses

Beat 2 is this module's **documented exception to the digest-pinned-after-pre-pull rule** —
the one place in the workshop that needs the venue network (decided and recorded in the
module spec: small local models genuinely can't do multi-step triage, and on 16 GB
machines beat 1 doesn't fit at all). If the network is down, beat 1 still works on
32 GB machines, and the module's scenario path needs no network anywhere.

Sign up for a free [OpenCode Zen](https://opencode.ai/auth) key during module 00 prep if
you haven't yet (see that module's README). "Free" here is explicit and time-boxed —
Zen's free models are labeled **"for a limited time."** If they're gone by the time you
read this, skip straight to the fallback paragraph below.

Create the Secret imperatively — an API key is the one thing in this whole workshop that
never goes in Git (and `read -s` below keeps it out of your shell history too):

```bash
read -rsp 'OpenCode API key: ' OPENCODE_API_KEY; echo
kubectl create secret generic kagent-zen -n kagent \
  --from-literal="OPENCODE_API_KEY=$OPENCODE_API_KEY"
unset OPENCODE_API_KEY
```

(The prompt hides what you type. If you paste nothing, `kubectl` happily creates the
Secret with an **empty** key and beat 2 fails later with an opaque auth error — check
with `kubectl -n kagent get secret kagent-zen -o jsonpath='{.data}'` if in doubt.)

Then switch the *same* ModelConfig, via git, to Zen's OpenAI-compatible endpoint. Pick
whichever model is currently marked free at
[opencode.ai/docs/zen](https://opencode.ai/docs/zen/) (at the time of writing:
`deepseek-v4-flash-free`, `mimo-v2.5-free`, `nemotron-3-ultra-free`):

```bash
cd platform   # the same clone from above, or a fresh `git clone .../cloudbox/platform.git`
$EDITOR gitops/components/kagent/kagent.yaml   # find `kind: ModelConfig`, replace spec:
```

```yaml
spec:
  provider: OpenAI
  model: deepseek-v4-flash-free
  apiKeySecret: kagent-zen
  apiKeySecretKey: OPENCODE_API_KEY
  openAI:
    baseUrl: "https://opencode.ai/zen/v1"
```

```bash
git add gitops/components/kagent/kagent.yaml
git commit -m "kagent: switch beat 2 to OpenCode Zen"
git push
```

Wait for ArgoCD to converge (`kubectl -n argocd get application kagent`), then open a new
investigation on the same fault (if you skipped beat 1, inject any scenario from the
setup table first). Same evidence, same read-only tool server — now the
verdict comes with a real hypothesis and an explicit kill-test. Verify that kill-test
against the live cluster yourself, then fix the fault the only way this module ever fixes
anything: `git revert` and push.

**No Zen key, or the free tier is gone?** Same shape, your own key. Create the Secret the
same way (`kubectl create secret generic kagent-byo -n kagent --from-literal="API_KEY=$YOUR_KEY"`
— one line, quoted), then set `apiKeySecret: kagent-byo` / `apiKeySecretKey: API_KEY` in
the ModelConfig and either `provider: Anthropic` with a current Claude model and
`anthropic: {}`, or `provider: OpenAI` with a current GPT model and `openAI: {}` — no
`baseUrl` needed for either; that field only exists to redirect the generic OpenAI
provider at Zen's endpoint instead of OpenAI's own. Full field reference:
[kagent supported providers](https://kagent.dev/docs/kagent/supported-providers).

## Check your work

```bash
./verify.sh
```

The check fails while Git still contains the poisoned value. Once Git is clean, it also
requires the live Deployment rollout to complete and rejects crashlooping or repeatedly
restarting pods. These checks are intentionally separate: a live-only fix cannot bypass
the platform's Git-only write path.

## Explain-back

Tell your neighbor which observation connected the pod's restart loop to the exact Git
diff, and why reverting Git is safer here than editing the live Deployment—even if the
live edit appears to work for a minute.

## Going deeper

- Watch `kubectl -n demo get rs,pods -w` during a reinjection. Explain why the old
  ReplicaSet remains and what availability the rolling-update strategy preserves.
- Inspect the Deployment conditions before and after its progress deadline. Distinguish
  “available through old replicas” from “the new rollout succeeded.”
- Ask a read-only agent for a diagnosis and the command that would falsify it. Give it
  cluster eyes, but keep the revert and push in the human-controlled Git path.

> Run the pinned manual verifier at `/opt/platform-engineering-workshop/lab/10-day2-ops/verify.sh`. Layered hints and the solution are released separately by Intar.
