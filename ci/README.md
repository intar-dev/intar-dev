# CI and deployment workflows

Every workflow in `.github/workflows` except `scenario-publish.yml` is rendered
from CUE in this directory. Edit the CUE and run `cuenv sync codegen`; never
edit the YAML. `scenario-publish.yml` stays hand-written: callers pin it by
tag, and its path is part of the OIDC allowlist in
`apps/web/src/lib/github-oidc.ts`.

## Model

- **`ci/gha/`** is a typed GitHub Actions library. `#Workflow`, `#Job`, and
  `#Step` are closed, so a misspelt key fails the render. `#Uses` accepts only
  local actions and the pins in `ci/gha/pins.cue`, and the renderer writes each
  pin's tag back as its version comment. A workflow grants no permission
  unless it names one.
- **`ci/workflows/<name>.cue`** is one workflow, rendered to
  `.github/workflows/<name>.yml` by `render.cue`.
- **Tasks hold the logic.** A step runs a cuenv task, not an inline script:
  - Root tasks in `env.cue` (`cuenv task <name>`) are what a developer runs
    too: the lane steps, `verify`, `check`, and the like.
  - Workflow step tasks belong to the `intar-ci` project in `ci/env.cue`
    (`cuenv task -p ci --package ci <workflow>-<step>`). Each runs
    `tools/workflows/<workflow>/<step>.sh`. A step that uses production
    credentials or changes anything outside the runner is `_production: true`
    and refuses to start outside GitHub Actions.

## ci.yml

One workflow checks pull requests and every push to main:

1. **`changes`** runs `cuenv task ci-changes` (`tools/ci/changed-lanes.sh`),
   which prints `<lane>=true|false` for each lane. A pull request runs a lane
   when a file matching the lane's `inputs` or the `sharedInputs` in
   `ci/workflows/lanes.cue` changed. It diffs against the first parent of
   GitHub's merge commit, which is exactly the pull request. A push to main or
   a dispatch runs every lane.
2. **One job per lane** (`rust`, `security`, `images`, `web`, `docs`), skipped
   when its output is false. `web-ui` runs the Chromium smoke in the Playwright
   container when `web` runs.
3. **`release-plan`** lists the products the pull request would release: each
   whose manifest version differs from the base, or all of them when the
   release build itself changed (`tools/workflows/ci/release-plan.sh`).
   **`release-dry-run`** builds and smoke-tests each with `release.yml`'s build
   steps (`#ReleaseBuild` in `release.cue`), without the workspace gate the
   `rust` lane runs and without keeping the payload. Nothing is published.
4. **`ci-ok`** always runs. It fails when `changes` did not succeed or any job
   failed or was cancelled, and counts a skipped job as passed. It is the only
   check a ruleset needs to require.

`ci.yml` runs pull request code, so the render fails if it grants a write
permission or references a secret or the job token. Pull request runs are
grouped by number and cancelled by a newer push; main runs are never
cancelled.

Run a lane locally with `cuenv task lanes.<name>`, every lane with
`cuenv task ci`, and see which lanes your branch needs with
`cuenv task ci-changes`: locally it compares the working tree with the merge
base of `origin/main`.

### Adding a lane

1. Add it to `lanes` in `ci/workflows/lanes.cue`: its path globs, its setup
   steps after checkout and cuenv, its root tasks in order, and a timeout.
2. Run `cuenv sync codegen`. The `changes` output, the job, and the `ci-ok`
   dependency are generated from the lane.
3. Add the lane to the expectations in `tools/ci/changed-lanes.test.ts`.

## Deployment workflows

- **`website.yml` and `docs.yml`** deploy main: on a push that changes what
  they deploy, or a dispatch from main. Their build jobs use the lane's own
  steps (`laneSteps.web`, `laneSteps.docs`), so the pull request check and the
  deployed build cannot drift apart.
- **`release.yml`** maintains the release pull request and publishes merged
  releases; see "Releasing" in the root README.
- **`image-ops.yml`** and **`stargate-deploy.yml`** are dispatched by hand
  from main.

Production jobs queue behind each other and are never cancelled halfway. The
`production` and `release-pr` environments admit main only; that is a
repository setting, not part of the CUE.

## Checks on the workflows

- `cuenv task sync-check`: the rendered files match the CUE, the workflow set is
  exactly the rendered files plus `scenario-publish.yml`, and Dependabot's
  `exclude-paths` lists every rendered file.
- `cuenv task workflow-policy`: every external action is pinned to a commit with
  its tag comment, installed tools are pinned, and each rendered pin also sits
  in a file Dependabot scans.
- `cuenv task actionlint`: the rendered YAML and its shell.

The `security` lane runs all three.

## Bumping an action pin

Dependabot skips the rendered workflows, so every pin they use is also listed in
a file it scans: a composite action or `.github/actions/workflow-pins`. When a
Dependabot pull request bumps one there, change the same pin's `sha` and `tag`
in `ci/gha/pins.cue` in that pull request and run `cuenv sync codegen`. Until
then the workflow policy fails the pull request, because the rendered pin is no
longer in a scanned file.

## Rulesets

`.github/rulesets/` holds the ruleset bodies. They are not applied yet. Apply
one with `gh api -X POST repos/intar-dev/intar-dev/rulesets --input <file>`, and
replace an applied one with `gh api -X PUT
repos/intar-dev/intar-dev/rulesets/<id> --input <file>`.

- **`main.json`, stage A:** main cannot be deleted or force-pushed.
- **`main-stage-b.json`, stage B:** adds a pull request for every change
  (no approval needed, squash merge only), linear history, and `ci-ok` from
  the GitHub Actions app (integration 15368) on a branch that is up to date
  with main. Admins can bypass only through a pull request. Apply it in place
  of stage A once nothing pushes to main directly any more (the release
  workflow now works through its pull request) and `ci-ok` has been green on
  main for a while.
- **`release-tags.json`:** a `<prefix>/v*` release tag cannot be moved or
  deleted.

Also require approval before workflows run for a fork's pull request: pull
request runs write the shared Namespace caches.

## Returning to `cuenv sync ci`

cuenv's own CI generator produced the lanes before `ci.yml`. It could not pin
its checkout, key concurrency on the pull request number, or express the
`changes` gate. Switch back once cuenv ships a configurable checkout, pull
request concurrency, job `timeout-minutes` and `if`, a pull request trigger
without a branch filter, `permissions: {}`, and a gate job with per-lane change
conditions, and only when:

- its output passes the workflow policy without exemptions,
- `cuenv sync ci --check` is stable,
- the parsed output matches `ci.yml`, and
- the gate job is still named `ci-ok`, so the ruleset keeps working.
