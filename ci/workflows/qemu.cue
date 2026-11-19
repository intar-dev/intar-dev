package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": qemu: {
	name:       "App QEMU"
	"run-name": "App QEMU @ ${{ github.sha }}"

	// Builds the QEMU the desktop app ships, on a runner of each target, from
	// the sources pinned in tools/workflows/qemu/sources.txt, and publishes
	// the files with those sources as the release qemu/v<set>. Nothing uses a
	// build until a reviewed change pins its checksum in
	// tools/workflows/qemu/pins.txt, so the release is only where the bytes
	// are kept. A change to the sources or the build script runs this on its
	// branch, pins the checksums it prints, and merges with them.
	on: workflow_dispatch: {}
	concurrency: {
		group:                "intar-qemu"
		"cancel-in-progress": false
	}
	permissions: contents: "read"
	jobs: {
		build: {
			name: "Build ${{ matrix.target }}"
			strategy: {
				matrix: include: [
					{target: "macos-arm64", runner: "macos-15"},
				]
				"fail-fast": false
			}
			"runs-on":         "${{ matrix.runner }}"
			"timeout-minutes": 60
			outputs: {
				set: "${{ steps.build.outputs.set }}"
				tag: "${{ steps.build.outputs.tag }}"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				{
					name: "Build QEMU"
					id:   "build"
					#StepTask & {#task: "qemu-build"}
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
			name: "Publish ${{ needs.build.outputs.tag }}"
			needs: ["build"]
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
						pattern:          "qemu-*"
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
						TAG:      "${{ needs.build.outputs.tag }}"
					}
					#StepTask & {#task: "qemu-publish"}
				},
			]
		}
	}
}

tasks: {
	"qemu-build": #Script & {_script:     "tools/workflows/qemu/build.sh"}
	"qemu-checksums": #Script & {_script: "tools/workflows/qemu/checksums.sh"}
	"qemu-publish": #Script & {_script:   "tools/workflows/qemu/publish.sh", _production: true}
}
