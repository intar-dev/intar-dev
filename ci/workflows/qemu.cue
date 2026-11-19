package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": qemu: {
	name:       "App QEMU"
	"run-name": "App QEMU @ ${{ github.sha }}"

	// The QEMU the desktop app ships: built on a runner of each target from
	// the sources pinned in tools/workflows/qemu/sources.txt, and booted with
	// the pinned guest kernel.
	//
	// Every week, and when started by hand, a run takes the newest stable QEMU
	// release (checked against the QEMU release key), builds and boots it, and,
	// when the result is not the set pinned in pins.txt, publishes the files
	// with their sources as the release qemu/v<set> and opens the pull request
	// updates/qemu that pins it. A week without a new QEMU still builds and
	// boots the pinned sources, so a runner or toolchain change that breaks
	// the build is seen. A pull request that changes the build runs it too,
	// and publishes nothing.
	on: {
		workflow_dispatch: {}
		schedule: [{cron: "23 4 * * 1"}]
		pull_request: {
			branches: ["main"]
			paths: ["tools/workflows/qemu/**", ".github/workflows/qemu.yml", "crates/intar-image-build/src/kernel.rs"]
		}
	}
	concurrency: gha.#PRConcurrency & {#name: "intar-qemu"}
	permissions: contents: "read"
	jobs: {
		check: {
			name:              "Check for a newer QEMU"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 15
			outputs: {
				version: "${{ steps.check.outputs.version }}"
				set:     "${{ steps.check.outputs.set }}"
				tag:     "${{ steps.check.outputs.tag }}"
				publish: "${{ steps.check.outputs.publish }}"
				pin:     "${{ steps.check.outputs.pin }}"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				{
					name: "Decide what this run does"
					id:   "check"
					env: GH_TOKEN: "${{ github.token }}"
					#StepTask & {#task: "qemu-check"}
				},
				_keepSources,
			]
		}
		build: {
			name: "Build ${{ matrix.target }}"
			needs: ["check"]
			strategy: {
				matrix: include: [
					{target: "macos-arm64", runner: "macos-15"},
				]
				"fail-fast": false
			}
			"runs-on":         "${{ matrix.runner }}"
			"timeout-minutes": 60
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				_takeSources,
				{
					name: "Build QEMU"
					#StepTask & {#task: "qemu-build"}
				},
				{
					name: "Boot a guest"
					#StepTask & {#task: "qemu-smoke"}
				},
				{
					name: "Keep the files"
					uses: gha.pin."upload-artifact".ref
					with: {
						name:                "qemu-${{ matrix.target }}"
						path:                "dist/"
						"if-no-files-found": "error"
						"compression-level": 0
						"retention-days":    7
					}
				},
			]
		}
		publish: {
			name: "Publish ${{ needs.check.outputs.tag }}"
			needs: ["check", "build"]
			if:                "needs.check.outputs.publish == 'true'"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 15
			permissions: {
				contents:            "write"
				"id-token":          "write"
				attestations:        "write"
				"artifact-metadata": "write"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				{
					name: "Download the files"
					uses: gha.pin."download-artifact".ref
					with: {
						pattern:          "qemu-*-*"
						path:             "dist/"
						"merge-multiple": true
					}
				},
				{
					name: "Write the checksums"
					#StepTask & {#task: "qemu-checksums"}
				},
				{
					name: "Attest build provenance"
					uses: gha.pin.attest.ref
					with: "subject-checksums": "dist/intar-qemu_checksums.txt"
				},
				{
					name: "Publish the QEMU release"
					env: {
						GH_TOKEN: "${{ github.token }}"
						TAG:      "${{ needs.check.outputs.tag }}"
					}
					#StepTask & {#task: "qemu-publish"}
				},
			]
		}
		// The release app's key is in the release-pr environment, which only
		// main can use: a run on another branch stops here.
		pin: {
			name: "Open the pull request that pins ${{ needs.check.outputs.tag }}"
			needs: ["check", "build", "publish"]
			if:                "${{ !cancelled() && needs.check.outputs.pin == 'true' && needs.build.result == 'success' && (needs.publish.result == 'success' || needs.publish.result == 'skipped') }}"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 10
			environment:       "release-pr"
			steps: [
				gha.#AppToken,
				gha.#Checkout & {with: token: "${{ steps.app-token.outputs.token }}"},
				gha.#SetupCuenv,
				_takeSources,
				{
					name: "Pin the published QEMU and open the pull request"
					env: {
						GH_TOKEN:     "${{ steps.app-token.outputs.token }}"
						APP_SLUG:     "${{ steps.app-token.outputs.app-slug }}"
						TAG:          "${{ needs.check.outputs.tag }}"
						QEMU_VERSION: "${{ needs.check.outputs.version }}"
					}
					#StepTask & {#task: "qemu-pin-pr"}
				},
			]
		}
	}
}

// The sources.txt the check job decided on, bumped or not, for the jobs after it.
let _keepSources = {
	name: "Keep the sources list"
	uses: gha.pin."upload-artifact".ref
	with: {
		name:                "qemu-sources"
		path:                "tools/workflows/qemu/sources.txt"
		"if-no-files-found": "error"
		"retention-days":    7
	}
}
let _takeSources = {
	name: "Take the sources list"
	uses: gha.pin."download-artifact".ref
	with: {
		name: "qemu-sources"
		path: "tools/workflows/qemu/"
	}
}

tasks: {
	"qemu-check": #Script & {_script:     "tools/workflows/qemu/check.sh"}
	"qemu-build": #Script & {_script:     "tools/workflows/qemu/build.sh"}
	"qemu-smoke": #Script & {_script:     "tools/workflows/qemu/smoke.sh"}
	"qemu-checksums": #Script & {_script: "tools/workflows/qemu/checksums.sh"}
	"qemu-publish": #Script & {_script:   "tools/workflows/qemu/publish.sh", _production: true}
	"qemu-pin-pr": #Script & {_script:    "tools/workflows/qemu/pin-pr.sh", _production: true}
}
