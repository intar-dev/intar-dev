package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": kernel: {
	name:       "Guest kernel"
	"run-name": "Guest kernel @ ${{ github.sha }}"

	// Compiles the guest kernel of both architectures, each on a runner of its
	// own, and publishes the two files as the release kernel/v<set>. Image
	// builds download them and check the SHA-256 pinned in
	// crates/intar-image-build/src/kernel.rs, so the release is only where the
	// bytes are kept: nothing reaches an image until a reviewed change pins it.
	// A change to the kernel's inputs runs this on its branch, pins the
	// checksums it prints, and merges with them.
	on: {
		workflow_dispatch: {}
		// ponytail: only until this workflow is on main; a dispatch on a branch
		// does the same once it is.
		push: branches: ["kernel-build/**"]
	}
	// One run at a time: a second run for the same set would meet the first
	// one's half-filled draft.
	concurrency: {
		group:                "intar-kernel"
		"cancel-in-progress": false
	}
	permissions: contents: "read"
	jobs: {
		build: {
			name: "Build ${{ matrix.arch }}"
			strategy: {
				matrix: include: [
					{arch: "amd64", runner: "namespace-profile-intar-dev"},
					{arch: "arm64", runner: "namespace-profile-intar-dev-arm64"},
				]
				"fail-fast": false
			}
			"runs-on":         "${{ matrix.runner }}"
			"timeout-minutes": 120
			outputs: {
				set: "${{ steps.build.outputs.set }}"
				tag: "${{ steps.build.outputs.tag }}"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				// A published file must not depend on a cache another run wrote.
				gha.#SetupRust & {with: "namespace-cache": "false"},
				{
					name: "Build the kernel"
					id:   "build"
					env: KERNEL_ARCH: "${{ matrix.arch }}"
					#StepTask & {#task: "kernel-build"}
				},
				{
					name: "Keep the kernel"
					uses: gha.pin."upload-artifact".ref
					with: {
						name:                "kernel-${{ matrix.arch }}"
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
					name: "Download the kernels"
					uses: gha.pin."download-artifact".ref
					with: {
						pattern:          "kernel-*"
						path:             "dist/"
						"merge-multiple": true
					}
				},
				{
					name: "Write the checksums"
					#StepTask & {#task: "kernel-checksums"}
				},
				{
					name: "Attest build provenance"
					uses: gha.pin.attest.ref
					with: "subject-checksums": "dist/intar-kernel_checksums.txt"
				},
				{
					name: "Publish the kernel release"
					env: {
						GH_TOKEN: "${{ github.token }}"
						TAG:      "${{ needs.build.outputs.tag }}"
					}
					#StepTask & {#task: "kernel-publish"}
				},
			]
		}
	}
}

tasks: {
	"kernel-build": #Script & {_script:     "tools/workflows/kernel/build.sh"}
	"kernel-checksums": #Script & {_script: "tools/workflows/kernel/checksums.sh"}
	"kernel-publish": #Script & {_script:   "tools/workflows/kernel/publish.sh", _production: true}
}
