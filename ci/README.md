# CI and deployment workflows

| Workflow | What it does |
| --- | --- |
| [`ci.yml`](#ciyml) | Checks every pull request into main and the merge queue |
| [`pr-title.yml`](#ciyml) | Checks a pull request's title as it is edited |
| [`deploy.yml`](#deployment-workflows) | Deploys the website and the docs when the queue moves main |
| [`release.yml`](#deployment-workflows) | Releases every product a merge changed, stores Kino in the registry, and redeploys the website |
| [`image-ops.yml`](#deployment-workflows) | Operator dispatches: the run gate, storing a Kino release, the registry cleanup |
| [`kernel.yml`](#kernelyml) | Builds and pins the guest kernel |
| [`qemu.yml`](#qemuyml) | Builds and pins the desktop app's QEMU |
| `scenario-publish.yml`, `scenario-publish-image.yml` | Called by scenario repositories to build and publish their images. Hand-written |

To run what CI runs on your own computer: `cuenv task lanes.<name>` for one
lane, `cuenv task ci` for all of them, and `cuenv task ci-changes` to see
which lanes your branch needs.

Every workflow in `.github/workflows` except `scenario-publish.yml` and
`scenario-publish-image.yml` is rendered from CUE in this directory. Edit the
CUE and run `cuenv sync codegen`; never edit the YAML. Those two stay
hand-written: callers pin `scenario-publish.yml` by tag or commit, it calls
`scenario-publish-image.yml` for each image, and both paths are part of the
OIDC allowlist in `apps/web/src/lib/github-oidc.ts`.

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
   GitHub's merge commit, which is exactly the pull request. A dispatch runs
   every lane.

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
2. **One job per lane** (`rust`, `security`, `images`, `web`, `kino`, `app`,
   `docs`), skipped when its output is false. `kino` builds the kino guest
   with its size-optimised, fat-LTO profile, so only a change that reaches
   kino pays that minute. `app` checks the desktop app and its engine on the
   macOS runner, where the app runs, and builds its bundle there with the
   pinned QEMU; `rust` builds it on Linux only. `web-ui` runs the Chromium smoke in the Playwright
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
4. **`release-plan`**, on a pull request only, lists the products its change
   to the release build reaches (`tools/workflows/ci/release-plan.sh`): the
   one product a script of its own build is for, every product for the rest
   of the build, and none for the plan and publish scripts or a product's own
   code. The merge queue dry-runs nothing: `release.yml` builds each release
   after the merge, and tags it only once that build passed. **`release-dry-run`**
   builds and smoke-tests each with `release.yml`'s build steps
   (`#ReleaseBuild` in `release.cue`), without the gate its lane runs (the
   `rust` lane's for a Linux product, the `app` lane's for the desktop app)
   and without keeping the payload; it checks that what the build left in
   `dist/` is what a release could publish. Nothing is published.
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
with a freshly downloaded, signature-checked Zig; the desktop app's bundle
takes its QEMU from the pinned release, by its SHA-256.

The agent's release builds on a GitHub-hosted runner for Landlock, out of reach
of that volume. After `release.yml` builds an agent release on main, it saves
the Cargo target directory and downloads to a GitHub Actions cache keyed by the
toolchain and `Cargo.lock`. The release dry run only restores it, from the
newest key with the same toolchain; pull requests and merge groups can read
main's caches but never write them, and the release itself never restores one.

A daily scheduled run runs only the `security` lane, whose audits are the only
check that sees a newly published advisory for code no pull request touched.

`ci.yml` and `pr-title.yml` run pull request code, so the render fails if
either grants a write permission or references a secret or the job token.
Pull request runs are grouped by number and cancelled by a newer push; merge
group, scheduled and dispatched runs are never cancelled.

Locally, `cuenv task ci-changes` compares the working tree with the merge base
of `origin/main`.

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
  commit and run that built it. A push that did not change a lane's inputs
  leaves production on the build it serves, without redeploying it
  (`release.yml` dispatches a deploy when a release changes the pins); a push
  that changed them, or a dispatch, without a build fails. A re-run deploys
  only while its revision is main's tip.
  - `gh workflow run deploy.yml --ref main` deploys main's tip again, for
    example after a configuration change.
  - When the build has expired (90 days), `gh workflow run ci.yml --ref main`
    builds every lane again and deploys once it passes.
  - Break glass: when CI keeps failing outside a deploy's own lane, for
    example on a newly published advisory in `security`,
    `gh workflow run deploy.yml --ref main -f break_glass=true` also takes a
    build whose own lane jobs passed in a run that failed elsewhere (`web
    build`, or `web` with its Chromium smoke; `docs`).
- **`release.yml`**, on every push to main, plans each product git-cliff
  finds releasable commits for since its latest tag, builds it from the merged
  commit with the version applied to the checkout, and then tags and
  publishes it. After a Kino release it stores the artifact in the registry,
  in image-ops' lock group, and after any release it dispatches `deploy.yml`.
  A dispatch from main resumes a tag whose publish failed and stores the
  newest Kino again. See "Releasing" in `RELEASING.md`. A build reruns the
  workspace gate only for a commit that never passed CI in the merge queue or
  a dispatch from main.
- **`deploy.yml`'s pins:** `deploy-web` resolves the scenario compiler, the
  desktop app's update and the Kino pins from the published releases
  (`tools/deploy/release-pins.ts`) and writes them into the deployment
  configuration. It takes only a release that is not a prerelease, whose tag
  is on main, and whose files carry release.yml's attestation from main; a
  Kino only once the registry stores its artifact.
- **`image-ops.yml`** is dispatched by hand from main: the run gate and the
  registry cleanup. No workflow rolls a tool out to a host; see "Rolling out" in
  `RELEASING.md`.

Production jobs queue behind each other and are never cancelled halfway. The
`production` and `release-pr` environments admit main only; that is a
repository setting, not part of the CUE.

## kernel.yml

The guest kernel is compiled here, not on the builder: for arm64 an x86
builder would compile it under emulation, for hours.

- **`build`** runs once per architecture on a runner of that architecture
  (the large amd64 profile and the arm64 one, see `runners` in `ci/gha/gha.cue`).
  `tools/workflows/kernel/build.sh` writes the build script, profile and init
  script with `cargo run -p intar-image-build --example kernel_inputs`, runs
  the script in the pinned Debian image, and packs the result the same way
  every time. When the source's kernel set is the pinned one, the file must
  have the pinned checksum, or the job fails: that is the reproducibility
  check.
- **`boot`** runs `smoke.sh` on a fresh runner of the same architecture: it
  boots the file `build` kept in QEMU, in the same pinned image, to an
  `/sbin/init` on a virtio disk that prints the kernel's release. It is a job
  of its own because on the arm64 profile a KVM guest booted right after the
  compile, on the same runner, stalls on its first disk reads.
- **`publish`** attests both files and publishes them as the release
  `kernel/v<set>`: draft, upload, compare, publish, never "latest". A set
  that is already published must hold these exact bytes. It runs on the
  schedule, on a dispatch and on a push to main, never for a pull request.
- **`check`** and **`pin`** make the weekly update. On the schedule and on a
  dispatch, `check` asks Debian for the newest kernel source of the pinned
  series (`latest.sh`) and, when one is newer, moves the source pins in this
  run's checkout (`bump.py`); the other jobs apply the same bump. After the
  publish, `pin` writes the set, the two checksums and the platform digest
  (`pin.py`), runs the crate's tests, and opens the pull request
  `updates/kernel` as the release app. Merging it releases the builder, and
  every lab is rebuilt after that builder is rolled out, so it is merged when
  that is wanted.

A week without a newer kernel rebuilds the pinned one, and `publish` then
checks that the bytes are the published ones.

A change to the profile by hand goes the other way round, and nothing is
published from a branch. The pull request's run runs `check` and `build` and
publishes nothing; the build summary prints the set and both checksums, and
`python3 tools/workflows/kernel/pin.py <amd64> <arm64>` pins them in the pull
request, which then passes the crate's tests. The build is reproducible, so
the push that merges it builds the same bytes, `build` refuses any other
file, and `publish` releases the set. A push never takes a newer Debian
source: that is the weekly run's job.

The set id covers every input that decides a file's bytes: both profiles, both
Debian images, the job count and the packing recipe. Image builds download
their file by the SHA-256 pinned in `crates/intar-image-build/src/kernel.rs`,
so the pins, changed only through review, are all an image trusts; the release
is where the bytes are kept.

To change the kernel (version, profile, toolchain image): make the change on a
branch, where the pin test now fails; dispatch the workflow on that branch
(`gh workflow run kernel.yml --ref <branch>`); put the set and the two
checksums it prints into `kernel.rs`; dispatch it once more, which must
reproduce them; merge.

## qemu.yml

The QEMU the desktop app ships (`apps/jumper` runs no other). It has the shape
of `kernel.yml`, for one target so far, macOS on Apple silicon.

- **`check`** decides what the run does. On the schedule and on a dispatch it
  looks for the newest stable release on download.qemu.org (`latest.sh`); a
  newer tarball must carry a valid signature of the QEMU release key
  (`qemu-release-key.asc`, the key qemu.org names) before `bump.sh` puts its
  URL and SHA-256 into `sources.txt`.
- **`build`** runs `build.sh` on a runner of the target: QEMU with glib and
  libslirp linked in, one system emulator and `qemu-img`, the licence texts,
  and a second file with the exact sources. `smoke.sh` then boots the pinned
  guest kernel with that QEMU until the guest finds its virtio disk.
- **`publish`** runs when the set these sources build is not the one in
  `pins.txt` and is not published yet: it attests the files and publishes
  them as the release `qemu/v<set>`. A set is a digest of `sources.txt` and
  `build.sh`; a second build of a set does not give the same bytes, so a
  published set is never replaced.
- **`pin`** writes the release's checksums into `pins.txt` and opens the pull
  request `updates/qemu` as the release app.

`cuenv task jumper-qemu` downloads the pinned archive for a development build
and refuses any other file. A pull request that changes the build runs
`check` and `build` and publishes nothing.

## Checks on the workflows

- `cuenv task sync-check`: the rendered files match the CUE, the workflow set is
  exactly the rendered files plus `scenario-publish.yml` and
  `scenario-publish-image.yml`, and Dependabot's
  `exclude-paths` lists every rendered file.
- `cuenv task workflow-policy`: every external action is pinned to a commit with
  its tag comment, installed tools are pinned, and each rendered pin also sits
  in a file Dependabot scans.
- `cuenv task actionlint`: the rendered YAML and its shell.

The `security` lane runs all three.

It also runs `cuenv task md-links` (`tools/ci/check-md-links.ts`): a relative
link in a tracked Markdown file must name a file that exists. The docs site's
pages, web links and `#anchors` are not checked.

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
