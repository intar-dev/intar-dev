package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// Product releases straight from main; nothing is published to a package
// registry, and no pull request carries a version.
//
// On every push to main, which the merge queue makes only once CI passed for
// the commit, after a CI run dispatched from main passes for main's tip, or on
// a dispatch from main (afterCI in ci.cue):
//
//   - plan lists each product git-cliff finds releasable commits for since its
//     latest tag (tools/workflows/release/cliff.toml and products.json), at
//     the next version, and each tag a failed publish left unpublished;
//   - build packages each from its commit, with the version applied to the
//     checkout, and publish tags it only then, attests the payload and
//     publishes the release;
//   - kino stores a published Kino release in the registry, and redeploy
//     dispatches deploy.yml, which pins the website to the newest published
//     releases (tools/workflows/website/pin-releases.sh).
//
// A failed build tags nothing, and the next run plans it again; re-running or
// dispatching the workflow resumes a tag whose publish failed.
let _hasReleases = "needs.plan.outputs.matrix != '[]'"
let _releases = {
	matrix: include: "${{ fromJSON(needs.plan.outputs.matrix) }}"
	"fail-fast": false
}

let _gitCliff = {
	name: "Install git-cliff"
	uses: gha.pin."install-action".ref
	with: {
		tool:     "git-cliff@2.14.2"
		fallback: "none"
	}
}

"workflows": release: {
	name: "Release"
	on: afterCI.on & {workflow_dispatch: {}}
	// Every run that acts queues in one group, and a newer pending run replaces
	// an older one: it plans from main's tip and resumes a failed publish too. A
	// CI run this workflow ignores gets a group of its own, so it never
	// replaces one that publishes.
	concurrency: gha.#ProductionConcurrency & {
		group: "release-${{ (\(afterCI.if)) && 'main' || github.run_id }}"
	}
	jobs: {
		plan: {
			name:      "Plan releases"
			if:        afterCI.if
			"runs-on": "ubuntu-24.04"
			permissions: {
				// Whether CI passed on the commit a release builds, for build.
				actions:  "read"
				contents: "write"
			}
			outputs: matrix: "${{ steps.plan.outputs.matrix }}"
			steps: [
				gha.#Checkout & {with: "fetch-depth": 0},
				gha.#SetupCuenv,
				_gitCliff,
				{
					name: "Plan releases"
					id:   "plan"
					env: GH_TOKEN: "${{ github.token }}"
					#StepTask & {#task: "release-plan"}
				},
			]
		}

		// The payload is built from the planned commit alone, with read-only
		// access.
		build: #ReleaseBuild & {
			#plan:   "plan"
			#dryRun: false
			name:    "Build ${{ matrix.tag }}"
		}

		// Each product publishes on its own, so one failed build leaves only
		// its own draft for the next run. A product whose build failed has no
		// payload to download.
		publish: {
			name: "Publish ${{ matrix.tag }}"
			needs: ["plan", "build"]
			if:        "${{ !cancelled() && needs.plan.result == 'success' && \(_hasReleases) }}"
			strategy:  _releases
			"runs-on": "ubuntu-24.04"
			permissions: {
				contents:            "write"
				"id-token":          "write"
				attestations:        "write"
				"artifact-metadata": "write"
			}
			steps: [
				gha.#Checkout & {with: "fetch-depth": 0},
				gha.#SetupCuenv,
				{
					name: "Download release payload"
					uses: gha.pin."download-artifact".ref
					with: {
						name: "release-${{ matrix.prefix }}"
						path: "dist/"
					}
				},
				{
					name: "Attest build provenance"
					uses: gha.pin.attest.ref
					with: "subject-checksums": "dist/${{ matrix.binary }}_${{ matrix.version }}_checksums.txt"
				},
				{
					name: "Publish tagged GitHub release"
					env: {
						GH_TOKEN: "${{ github.token }}"
						TAG:        "${{ matrix.tag }}"
						TITLE:      "${{ matrix.project }} v${{ matrix.version }}"
						VERSION:    "${{ matrix.version }}"
						REF:        "${{ matrix.ref }}"
						CREATE_TAG: "${{ matrix.create_tag }}"
					}
					#StepTask & {#task: "release-publish-tagged-github-release"}
				},
			]
		}

		// After a Kino release, or on a dispatch, which retries a promote that
		// failed. The registry keeps what it stores, so storing again is
		// harmless. It shares image-ops' lock with the run gate.
		kino: {
			name: "Store the Kino release in the registry"
			needs: ["plan", "publish"]
			if:        "${{ !cancelled() && needs.plan.result == 'success' && (contains(needs.plan.outputs.matrix, '\"prefix\":\"kino\"') || github.event_name == 'workflow_dispatch') }}"
			"runs-on": gha.runners.smol
			concurrency: {
				group:                "intar-image-catalog-promotion"
				"cancel-in-progress": false
			}
			"timeout-minutes": 15
			environment:       "production"
			// gh reads the release and verifies its attestation.
			permissions: {
				attestations: "read"
				contents:     "read"
			}
			env: {
				GH_TOKEN:                  "${{ github.token }}"
				INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				REGISTRY_URL:              "https://intar.dev/registry/v1"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				gha.#SetupRuntime,
				{
					name: "Push the Kino artifact"
					#StepTask & {#task: "release-kino-promote"}
				},
			]
		}

		// The website deploy pins the newest published releases, so a run
		// that published one deploys again. deploy.yml checks that its
		// revision is main's tip and takes the build CI kept of main's inputs.
		redeploy: {
			name: "Deploy the website with the new releases"
			needs: ["plan", "publish", "kino"]
			if:        "${{ !cancelled() && needs.plan.result == 'success' && (\(_hasReleases) || github.event_name == 'workflow_dispatch') }}"
			"runs-on": "ubuntu-24.04"
			permissions: actions: "write"
			steps: [{
				name: "Dispatch the website deploy"
				env: GH_TOKEN: "${{ github.token }}"
				run: "gh workflow run deploy.yml --repo \"${GITHUB_REPOSITORY}\" --ref main"
			}]
		}
	}
}

// One product's build from a plan job's matrix. release.yml builds each
// release from its planned commit and keeps the payload for publish. ci.yml's release dry run
// builds the merge group or pull request with the same steps, minus the
// workspace gate its rust lane runs and the payload upload, since nothing
// publishes it.
// The agent's release target directory and Cargo downloads, keyed by the
// toolchain and the lockfile; an older lockfile's cache still holds most
// dependencies.
_agentCache: {
	path: """
		target/x86_64-unknown-linux-musl
		~/.cargo/registry/index
		~/.cargo/registry/cache
		~/.cargo/git/db
		"""
	restoreKeys: "intar-agent-release-${{ hashFiles('rust-toolchain.toml') }}-"
	key:         "\(restoreKeys)${{ hashFiles('Cargo.lock') }}"
}

#ReleaseBuild: gha.#Job & {
	#plan!:   string
	#dryRun!: bool
	let _checkout = {
		if !#dryRun {ref: "${{ matrix.ref }}"}
	}
	needs: #plan
	if:    "needs.\(#plan).outputs.matrix != '[]'"
	strategy: {
		matrix: include: "${{ fromJSON(needs.\(#plan).outputs.matrix) }}"
		"fail-fast": false
	}
	"runs-on": "${{ matrix.runner }}"
	// The app's signing certificate and notary key live in the macos-signing
	// environment, which only main can use; no other build, and no dry run,
	// sees them.
	if !#dryRun {
		environment: "${{ matrix.project == 'intar-desktop' && 'macos-signing' || '' }}"
	}
	permissions: contents: "read"
	steps: [
		gha.#Checkout & {
			name: "Checkout on Namespace"
			if:   "matrix.runner != 'ubuntu-24.04'"
			uses: gha.pin."nscloud-checkout".ref
			with: _checkout
		},
		// The jailed agent release needs a host kernel with Landlock
		// enabled, which Namespace's runner kernel disables at boot.
		gha.#Checkout & {
			name: "Checkout jailed agent release"
			if:   "matrix.runner == 'ubuntu-24.04'"
			with: _checkout
		},
		gha.#SetupCuenv,
		{
			name: "Preflight jailed release runner"
			if:   "matrix.project == 'intar-agent'"
			#StepTask & {#task: "release-preflight-jailed-release-runner"}
		},
		// Versions live in tags: the checkout gets the version it builds, in
		// the manifest and Cargo.lock, and nothing commits it.
		{
			name: "Set the release version"
			env: {
				MANIFEST: "${{ matrix.manifest }}"
				PACKAGE:  "${{ matrix.package }}"
				VERSION:  "${{ matrix.version }}"
			}
			#StepTask & {#task: "release-apply-version"}
		},
		// Pull request runs write the runner's caches, so the payload release.yml
		// publishes is built from its commit without them.
		gha.#SetupRust & {with: {
			targets: "aarch64-unknown-linux-musl"
			"namespace-cache": [
				if #dryRun {"${{ matrix.runner != 'ubuntu-24.04' }}"},
				"false",
			][0]
		}},
		// The agent builds on a GitHub-hosted runner, out of reach of the
		// Namespace cache. A dry run starts from the Cargo build of main's last
		// agent release (_agentCache); the release itself never reads one.
		if #dryRun {
			name: "Restore the agent release's Cargo cache"
			if:   "matrix.project == 'intar-agent'"
			uses: gha.pin."cache-restore".ref
			with: {
				path:           _agentCache.path
				key:            _agentCache.key
				"restore-keys": _agentCache.restoreKeys
			}
		},
		// CI checked the commit in the merge queue that landed it, its lanes in
		// that run or, for inputs main had not changed, in the pull request's.
		// A commit CI never passed there, such as one dispatched by hand, runs
		// the gate here.
		// The workspace gate is the rust lane's, on Linux; the app's is its own
		// lane's, on a Mac.
		if !#dryRun {
			gha.#Run & {
				name:  "Run checks"
				if:    "matrix.ci_passed != true && matrix.project != 'intar-desktop'"
				#task: "verify"
			}
		},
		if !#dryRun {
			gha.#Run & {
				name:  "Run the app's Clippy"
				if:    "matrix.ci_passed != true && matrix.project == 'intar-desktop'"
				#task: "clippy-app"
			}
		},
		if !#dryRun {
			gha.#Run & {
				name:  "Run the app's tests"
				if:    "matrix.ci_passed != true && matrix.project == 'intar-desktop'"
				#task: "test-app"
			}
		},
		// The app is a macOS bundle with its own build; every other product is a
		// Linux archive.
		{
			name: "Build the app's bundle"
			if:   "matrix.project == 'intar-desktop'"
			env: {
				VERSION: "${{ matrix.version }}"
				if !#dryRun {
					MACOS_CERT_P12_BASE64:             "${{ secrets.MACOS_CERT_P12_BASE64 }}"
					MACOS_CERT_PASSWORD:               "${{ secrets.MACOS_CERT_PASSWORD }}"
					MACOS_PROVISIONING_PROFILE_BASE64: "${{ secrets.MACOS_PROVISIONING_PROFILE_BASE64 }}"
					ASC_KEY_ID:                        "${{ secrets.ASC_KEY_ID }}"
					ASC_ISSUER_ID:                     "${{ secrets.ASC_ISSUER_ID }}"
					ASC_KEY_P8:                        "${{ secrets.ASC_KEY_P8 }}"
				}
			}
			#StepTask & {#task: "release-build-jumper-macos"}
		},
		{
			name: "Build release artifacts"
			if:   "matrix.project != 'intar-desktop'"
			env: {
				PACKAGE: "${{ matrix.package }}"
				BINARY:  "${{ matrix.binary }}"
				VERSION: "${{ matrix.version }}"
			}
			#StepTask & {#task: "release-build-release-artifacts"}
		},
		gha.#Run & {
			name:  "Test personal-host installer"
			if:    "matrix.project == 'intar-agent'"
			#task: "installer-tests"
		},
		{
			name: "Run privileged agent package smoke"
			if:   "matrix.project == 'intar-agent'"
			env: VERSION: "${{ matrix.version }}"
			#StepTask & {#task: "release-privileged-agent-package-smoke"}
		},
		{
			name: "Smoke-test image CLI release package"
			if:   "matrix.project == 'intar-image-cli'"
			env: VERSION: "${{ matrix.version }}"
			#StepTask & {#task: "release-smoke-test-image-cli-package"}
		},
		// A tag older than this check has no such task: it is
		// built as it always was.
		{
			name: "Check the release payload"
			if:   "hashFiles('tools/workflows/release/check-release-payload.sh') != ''"
			env: {
				BINARY:  "${{ matrix.binary }}"
				VERSION: "${{ matrix.version }}"
			}
			#StepTask & {#task: "release-check-release-payload"}
		},
		// release.yml runs on main, so this cache is main's and every pull
		// request and merge group may read it; none of them writes one.
		if !#dryRun {
			name: "Save the agent's Cargo cache"
			if:   "matrix.project == 'intar-agent'"
			uses: gha.pin."cache-save".ref
			with: {
				path: _agentCache.path
				key:  _agentCache.key
			}
		},
		if !#dryRun {
			name: "Preserve exact release payload"
			uses: gha.pin."upload-artifact".ref
			with: {
				name:                "release-${{ matrix.prefix }}"
				path:                "dist/"
				"if-no-files-found": "error"
				"compression-level": 0
				overwrite:           true
				"retention-days":    7
			}
		},
	]
}

// Every release step but the version edit runs only in GitHub Actions: they
// tag, publish, or reconfigure the runner as root.
tasks: {
	"release-plan": #Script & {_script: "tools/workflows/release/plan-release.sh", _production: true}
	"release-apply-version": #Script & {_script: "tools/workflows/release/apply-release-version.sh"}
	"release-preflight-jailed-release-runner": #Script & {_script: "tools/workflows/release/preflight-jailed-release-runner.sh", _production: true}
	"release-build-release-artifacts": #Script & {_script: "tools/workflows/release/build-release-artifacts.sh", _production: true}
	"release-build-jumper-macos": #Script & {_script: "tools/workflows/release/build-jumper-macos.sh", _production: true}
	"release-check-release-payload": #Script & {_script: "tools/workflows/release/check-release-payload.sh"}
	"release-privileged-agent-package-smoke": #Script & {_script: "tools/workflows/release/privileged-agent-package-smoke.sh", _production: true}
	"release-smoke-test-image-cli-package": #Script & {_script: "tools/workflows/release/smoke-test-image-cli-package.sh", _production: true}
	"release-kino-promote": #Script & {_script: "tools/workflows/release/kino-promote.sh", _production: true}
	"release-publish-tagged-github-release": #Script & {_script: "tools/workflows/release/publish-tagged-github-release.sh", _production: true}
}
