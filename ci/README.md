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

One workflow checks pull requests and the merge queue. Main moves only
through the merge queue, which fast-forwards it to the merge group's commit,
so a push to main runs no CI: that exact commit already passed. Each check
runs once per change it can see: on each push to a pull request, then once
more in the merge group, which also holds what merged since.

1. **`changes`** runs `cuenv task ci-changes` (`tools/ci/changed-lanes.sh`),
   which prints `<lane>=true|false` for each lane. A pull request runs a lane
   when a file matching the lane's `inputs` or the `sharedInputs` in
   `ci/workflows/lanes.cue` changed. It diffs against the first parent of
   GitHub's merge commit, which is exactly the pull request. A merge group
   diffs against its base sha, the commit it merges onto. The release pull
   request (`release/next`), rebuilt after every merge, runs no lane: the
   merge queue checks it once. A dispatch runs every lane.
2. **One job per lane** (`rust`, `security`, `images`, `web`, `kino`,
   `docs`), skipped when its output is false. `kino` builds the kino guest
   with its size-optimised, fat-LTO profile, so only a change that reaches
   kino pays that minute. `web-ui` runs the Chromium smoke in the Playwright
   container when `web` runs. Every merge group runs the lanes with a `dist`
   (`web`, `docs`) and uploads the build each checked as `<lane>-dist-<sha>`,
   which `deploy.yml` deploys: the queue merges up to five groups at once and
   pushes only the last one's commit, whose diff need not hold an earlier
   group's change. A dispatch from main uploads them too.
3. **`release-plan`** lists the products a change would release: in the merge
   queue, each whose manifest version differs from the base; in the merge queue
   and on a pull request, all of them when the release build itself changed
   (`tools/workflows/ci/release-plan.sh`). So the release pull request
   dry-runs once, in the queue, not on each rebuild. **`release-dry-run`**
   builds and smoke-tests each with `release.yml`'s build steps
   (`#ReleaseBuild` in `release.cue`), without the workspace gate the `rust`
   lane runs and without keeping the payload. Nothing is published.
4. **`pr-title`** runs in the merge group and fails unless the squash commit's
   subject, the pull request title that lands on main, is a Conventional
   Commit with one scope (`tools/ci/check-pr-title.sh`, `cuenv task
   pr-title`): git-cliff versions the releases from those commits.
   `pr-title.yml` runs the same check on the pull request title as it is
   opened, pushed or edited. It is not required, and editing the title or
   description runs nothing else, so no lane runs twice for one commit. The
   title reaches the script through the environment, never as script text.
5. **`ci-ok`** always runs. It fails when `changes` did not succeed or any job
   failed or was cancelled, and counts a skipped job as passed. It is the only
   check a ruleset needs to require.

Each lane that writes much to the Namespace cache has a volume of its own
(`cacheTag` in `lanes.cue`, the runner label
`namespace-profile-intar-dev;overrides.cache-tag=<tag>`, listed in
`.github/actionlint.yaml`). Parallel jobs on one volume fork different
generations and the last commit wins, so on the shared volume the `rust` lane
rebuilt most crates on two runs in three. Pull request runs write these
caches, so nothing that ships reads them: the merge group's web build installs
without the Bun cache, and `release.yml` builds each product from its tag
without the Rust cache and with a freshly downloaded, signature-checked Zig.

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

- **`deploy.yml`** deploys what CI built and tested. `resolve` finds each
  lane's build in the tip's merge group or dispatched CI run
  (`tools/workflows/deploy/find-builds.sh`), and `deploy-web` and
  `deploy-docs` download it by that artifact id, which fails on a digest
  mismatch, and deploy it. A lane that did not run uploaded no build, so its
  deploy skips; every merge group and dispatch runs both. A re-run deploys
  only while its revision is main's tip.
  - `gh workflow run deploy.yml --ref main` deploys main's tip from its latest
    successful CI run, for example after a guest-tools promotion.
  - When that run's builds have expired (14 days), or no CI run passed for the
    tip, `gh workflow run ci.yml --ref main` builds everything again and
    deploys once it passes.
  - Break glass: when CI on the tip keeps failing outside a deploy's own lane,
    for example on a newly published advisory in `security`,
    `gh workflow run deploy.yml --ref main -f break_glass=true` deploys each
    build whose own lane jobs passed in the tip's latest finished CI run
    (`web` with its Chromium smoke, `docs`).
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

- **`main.json`:** main cannot be deleted or force-pushed, requires `ci-ok`
  from the GitHub Actions app (integration 15368), and merges through the
  merge queue (squash, up to five entries). Nobody can bypass it: deploy.yml
  and release.yml treat every push to main as a merge group whose CI passed.
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
