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

One workflow checks pull requests into main and the merge queue. A pull
request runs every check its change needs, so it shows the full picture, and
ci-ok must pass before it may queue. The merge queue then reruns only what
main changed under it. Main moves only through the queue, which
fast-forwards it to the merge group's commit, so a push to main runs no CI:
that exact commit already passed.

1. **`changes`** runs `cuenv task ci-changes` (`tools/ci/changed-lanes.sh`),
   which prints `<lane>=true|false` for each lane. A pull request runs a lane
   when a file matching the lane's `inputs` or the `sharedInputs` in
   `ci/workflows/lanes.cue` changed. It diffs against the first parent of
   GitHub's merge commit, which is exactly the pull request. The release pull
   request (`release/next`, committed by the release app), rebuilt after
   every merge, runs no lane: the merge queue checks it in full. A dispatch
   runs every lane.

   A merge group runs a lane only when it changed the lane's inputs against
   its base sha **and** main changed them in a commit after the pull
   request's merge base with main. The pull request's own run checked the
   lane against a main at least that new, so otherwise the lane's inputs are
   the ones it checked, and a lane's result depends only on its inputs (the
   same assumption the diff selection makes). Usually a merge group runs only
   `changes` and `ci-ok`. It finds the pull request's head from GitHub's queue
   branch (`pr-<number>-…`) and the public `refs/pull/<number>/head`, and
   uses it only when merging it onto the base gives the group's exact tree;
   when it cannot, or the head comes from the release app, it runs every lane
   the group changed. The checkout holds only the group's commit and its base,
   so it first fetches main's history without file contents, where the merge
   base lies. The `changes` log says which way it went, and why.
2. **One job per lane** (`rust`, `security`, `images`, `web`, `kino`,
   `docs`), skipped when its output is false. `kino` builds the kino guest
   with its size-optimised, fat-LTO profile, so only a change that reaches
   kino pays that minute. `web-ui` runs the Chromium smoke in the Playwright
   container when `web` runs.
3. **Builds for `deploy.yml`.** A pull request's run executes branch code, so
   production never takes its upload. A merge group that changes a lane with
   a `dist` builds it: `docs` runs its lane, which is its build, and `web`
   runs `web build` (`install-js`, `build.js`, `check-web-artifact`; the pull
   request's run tested those inputs) unless the `web` lane reruns anyway.
   A dispatch from main runs and uploads every lane. Each build is named
   `<lane>-dist-<inputs hash>` (`cuenv task ci-lane-inputs`,
   `tools/ci/lane-inputs.sh`: the mode, blob and path of every tracked file
   the lane's globs match), so `deploy.yml` finds the build of main's exact
   inputs in whichever run built them.
4. **`release-plan`** lists the products a change would release
   (`tools/workflows/ci/release-plan.sh`): in the merge queue, each whose
   manifest version differs from the base, so the release pull request
   dry-runs once, in the queue, not on each rebuild; on a pull request, all of
   them when the release build itself changed. The queue dry-runs such a
   change again only when it reruns the `rust` lane, whose inputs hold the
   release build and every product. **`release-dry-run`**
   builds and smoke-tests each with `release.yml`'s build steps
   (`#ReleaseBuild` in `release.cue`), without the workspace gate the `rust`
   lane runs and without keeping the payload. Nothing is published.
5. **`pr-title`** runs in the merge group and fails unless the squash commit's
   subject, the pull request title that lands on main, is a Conventional
   Commit with one scope (`tools/ci/check-pr-title.sh`, `cuenv task
   pr-title`): git-cliff versions the releases from those commits.
   `pr-title.yml` runs the same check on the pull request title as it is
   opened, pushed or edited. It is not required, and editing the title or
   description runs nothing else, so no lane runs twice for one commit. The
   title reaches the script through the environment, never as script text.
6. **`ci-ok`** always runs. It fails when `changes` did not succeed or any job
   failed or was cancelled, and counts a skipped job as passed. It is the only
   check a ruleset needs to require.

Every Namespace job shares one cache volume. Pull request runs write it, so
nothing that ships reads it: only pull request runs use the Bun cache, and
`release.yml` builds each product from its tag without the Rust cache and
with a freshly downloaded, signature-checked Zig.

A daily scheduled run runs only the `security` lane, whose audits are the only
check that sees a newly published advisory for code no pull request touched.

`ci.yml` and `pr-title.yml` run pull request code, so the render fails if
either grants a write permission or references a secret or the job token.
Pull request runs are grouped by number and cancelled by a newer push; merge
group, scheduled and dispatched runs are never cancelled.

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

`deploy.yml` and `release.yml` run on every push to main, which only the merge
queue makes, once the merge group's CI run passed for that same commit. They
take that run by the commit (`afterCI` in `ci.cue`), not on its `workflow_run`:
the run completes before the queue moves main, so it would still see the old
tip. After a CI run dispatched from main, they act only when it passed for the
commit that is still main's tip. A run for an older commit is left to the run
for the newer one, and a failed CI run deploys and publishes nothing.

- **`deploy.yml`** deploys what CI built and tested. `resolve`
  (`tools/workflows/deploy/find-builds.sh`) hashes main's inputs for `web` and
  `docs` and takes, for each, the newest unexpired `<lane>-dist-<hash>` from a
  `ci.yml` run for a merge group into main or a dispatch from main whose
  commit is on main and which passed; it waits for such a run still
  completing. `deploy-web` and `deploy-docs` download that build by artifact
  id, which fails on a digest mismatch, deploy it, and the summary names the
  commit and run that built it. A push that did not change a lane's inputs,
  with no build of them kept, leaves production on the build it serves; a push
  that changed them, or a dispatch, without a build fails. A re-run deploys
  only while its revision is main's tip.
  - `gh workflow run deploy.yml --ref main` deploys main's tip again, for
    example after a guest-tools promotion.
  - When the build has expired (14 days), `gh workflow run ci.yml --ref main`
    builds every lane again and deploys once it passes.
  - Break glass: when CI keeps failing outside a deploy's own lane, for
    example on a newly published advisory in `security`,
    `gh workflow run deploy.yml --ref main -f break_glass=true` also takes a
    build whose own lane jobs passed in a run that failed elsewhere (`web
    build`, or `web` with its Chromium smoke; `docs`).
- **`release.yml`**, on every push to main, tags and publishes merged
  releases, then rebuilds the release pull request; a dispatch from main
  resumes the drafts. See "Releasing" in the root README. A build reruns the
  workspace gate only for a tag whose commit never passed CI in the merge
  queue or a dispatch from main.
- **`image-ops.yml`** is dispatched by hand from main. No workflow rolls a
  tool out to a host; see "Rolling out" in the root README.

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

`.github/rulesets/` holds the bodies of the applied rulesets. Change one in a
pull request, then replace the applied one with `gh api -X PUT
repos/intar-dev/intar-dev/rulesets/<id> --input <file>`; list the ids with
`gh api repos/intar-dev/intar-dev/rulesets`.

- **`main.json`:** main cannot be deleted or force-pushed, takes every change
  through a pull request (squash only, no approval needed), requires `ci-ok`
  from the GitHub Actions app (integration 15368), and merges through the
  merge queue (squash, up to five entries). Nobody can bypass it: deploy.yml
  and release.yml treat every push to main as a merge group whose CI passed,
  and the pull request rule keeps a commit whose `ci-ok` passed elsewhere, such
  as a dispatched run, from being pushed straight to main.
- **`release-tags.json`:** a `<prefix>/v*` release tag cannot be moved or
  deleted.

Also require approval before workflows run for a fork's pull request: pull
request runs write the shared Namespace caches.

## Merge settings

git-cliff versions the releases from main's commits, so each must be a pull
request title that `pr-title` checked. That takes squash merges named after the
title. The repository is set that way: squash merges only, the squash commit
titled after the pull request (`squash_merge_commit_title=PR_TITLE`), and no
merge or rebase merges. Auto-merge is allowed (`allow_auto_merge`), so a pull
request can be set to squash-merge once `ci-ok` passes, and merged branches are
deleted (`delete_branch_on_merge`). Check it with `gh api
repos/intar-dev/intar-dev --jq '{allow_squash_merge, allow_merge_commit,
allow_rebase_merge, squash_merge_commit_title, allow_auto_merge,
delete_branch_on_merge}'`. The merge queue squashes too.

The `main` ruleset requires `ci-ok` and merges through a merge queue: each
pull request is squashed onto main's tip and `ci.yml` checks that commit as a
`merge_group` event, with `changes` diffing it against the group's base sha,
before it lands. Check it with `gh api repos/intar-dev/intar-dev/rulesets
--jq '.[] | select(.name == "main") | .id'` and that ruleset's `rules`.

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
