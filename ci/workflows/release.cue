package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// Product releases through a release pull request; nothing is published to a
// package registry.
//
// On every push to main, release-pr rebuilds release/next with the bumps
// git-cliff finds since each product's latest tag
// (tools/workflows/release/cliff.toml and products.json).
//
// Once CI passes on main's tip (afterCI in ci.cue), or on a dispatch from main:
//
//   - plan tags each product whose manifest version is new, opens its draft
//     release, and lists every draft for the build;
//   - build packages each draft from its tag, and publish attests the payload
//     and publishes the draft;
//   - web-pins opens the website pin pull request once the image CLI version
//     on main is published.
//
// A draft left by a failed run is rebuilt by the next run, so re-running or
// dispatching the workflow resumes it.
let _hasReleases = "needs.plan.outputs.matrix != '[]'"
let _releases = {
	matrix: include: "${{ fromJSON(needs.plan.outputs.matrix) }}"
	"fail-fast": false
}

// The intar-release GitHub App's token: its pushes and pull requests run CI,
// which a GITHUB_TOKEN push does not. Its key lives in the release-pr
// environment, which only main can use.
let _appToken = {
	name: "Create the release app token"
	id:   "app-token"
	uses: gha.pin."create-github-app-token".ref
	with: {
		"client-id":                "${{ vars.RELEASE_APP_CLIENT_ID }}"
		"private-key":              "${{ secrets.RELEASE_APP_PRIVATE_KEY }}"
		"permission-contents":      "write"
		"permission-pull-requests": "write"
	}
}
let _appEnv = {
	GH_TOKEN: "${{ steps.app-token.outputs.token }}"
	APP_SLUG: "${{ steps.app-token.outputs.app-slug }}"
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
	on: afterCI.on & {
		push: branches: ["main"]
		workflow_dispatch: {}
	}
	// A push only updates the release pull request, so it queues apart from the
	// runs that tag and publish. A CI run this workflow ignores gets a group of
	// its own: GitHub keeps one pending run per group, and the ignored run must
	// not replace one that publishes.
	concurrency: gha.#ProductionConcurrency & {
		group: "release-${{ github.event_name == 'push' && 'pr' || (\(afterCI.if)) && 'publish' || github.run_id }}"
	}
	jobs: {
		plan: {
			name:      "Plan releases"
			if:        afterCI.if
			"runs-on": "ubuntu-24.04"
			permissions: {
				// Whether CI passed on a draft's tag, for build.
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

		"release-pr": {
			name:        "Update the release pull request"
			if:          "github.event_name == 'push'"
			"runs-on":   "ubuntu-24.04"
			environment: "release-pr"
			steps: [
				_appToken,
				gha.#Checkout & {with: {
					"fetch-depth": 0
					token:         "${{ steps.app-token.outputs.token }}"
				}},
				gha.#SetupCuenv,
				_gitCliff,
				{
					name: "Update the release pull request"
					env:  _appEnv
					#StepTask & {#task: "release-update-pr"}
				},
			]
		}

		// The payload is built from the tag alone, with read-only access.
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
						TAG:      "${{ matrix.tag }}"
						TITLE:    "${{ matrix.project }} v${{ matrix.version }}"
					}
					#StepTask & {#task: "release-publish-tagged-github-release"}
				},
			]
		}

		// Every run checks the pins, not only a run that published the image
		// CLI: when another product's build fails, the run that resumes it no
		// longer lists the published image CLI. web-pins.sh does nothing until
		// that version is published, or once the website pins it.
		"web-pins": {
			name: "Pin the website to the new image CLI"
			needs: ["plan", "publish"]
			if:          "${{ !cancelled() && needs.plan.result == 'success' }}"
			"runs-on":   "ubuntu-24.04"
			environment: "release-pr"
			steps: [
				_appToken,
				gha.#Checkout & {with: {
					"fetch-depth": 0
					token:         "${{ steps.app-token.outputs.token }}"
				}},
				gha.#SetupCuenv,
				{
					name: "Open the website pin pull request"
					env:  _appEnv
					#StepTask & {#task: "release-web-pins"}
				},
			]
		}
	}
}

// One product's build from a plan job's matrix. release.yml builds each draft
// from its tag and keeps the payload for publish. ci.yml's release dry run
// builds the pull request with the same steps, minus the workspace gate its
// rust lane runs and the payload upload, since nothing publishes it.
#ReleaseBuild: gha.#Job & {
	#plan!:   string
	#dryRun!: bool
	let _checkout = {
		if !#dryRun {ref: "${{ matrix.tag }}"}
	}
	needs: #plan
	if:    "needs.\(#plan).outputs.matrix != '[]'"
	strategy: {
		matrix: include: "${{ fromJSON(needs.\(#plan).outputs.matrix) }}"
		"fail-fast": false
	}
	"runs-on": "${{ matrix.runner }}"
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
		gha.#SetupRust & {with: {
			targets:           "aarch64-unknown-linux-musl"
			"namespace-cache": "${{ matrix.runner != 'ubuntu-24.04' }}"
		}},
		// CI's rust lane runs the workspace gate on every push to main. A tag
		// whose commit CI never passed there, such as a release merge that a
		// quicker push overtook, a dispatch, or a draft left from before, runs
		// it here.
		if !#dryRun {
			gha.#Run & {
				name:  "Run checks"
				if:    "matrix.ci_passed != true"
				#task: "verify"
			}
		},
		{
			name: "Build release artifacts"
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

// Every release step runs only in GitHub Actions: they tag, publish, open pull
// requests, or reconfigure the runner as root.
tasks: {
	"release-plan": #Script & {_script: "tools/workflows/release/plan-release.sh", _production: true}
	"release-update-pr": #Script & {_script: "tools/workflows/release/update-release-pr.sh", _production: true}
	"release-preflight-jailed-release-runner": #Script & {_script: "tools/workflows/release/preflight-jailed-release-runner.sh", _production: true}
	"release-build-release-artifacts": #Script & {_script: "tools/workflows/release/build-release-artifacts.sh", _production: true}
	"release-privileged-agent-package-smoke": #Script & {_script: "tools/workflows/release/privileged-agent-package-smoke.sh", _production: true}
	"release-smoke-test-image-cli-package": #Script & {_script: "tools/workflows/release/smoke-test-image-cli-package.sh", _production: true}
	"release-publish-tagged-github-release": #Script & {_script: "tools/workflows/release/publish-tagged-github-release.sh", _production: true}
	"release-web-pins": #Script & {_script: "tools/workflows/release/web-pins.sh", _production: true}
}
