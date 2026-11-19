package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": "image-probe": {
	name:       "Image build probe"
	"run-name": "Image build probe @ ${{ github.sha }}"

	// A measurement that is not meant to merge: on its own branch's pull
	// request it builds two lab images natively on a runner of each
	// architecture and reports KVM, the processor and the times.
	on: pull_request: branches: ["main"]
	concurrency: {
		group:                "image-probe-${{ github.ref }}"
		"cancel-in-progress": true
	}
	permissions: contents: "read"
	jobs: build: {
		name: "Build ${{ matrix.arch }}"
		if:   "github.head_ref == 'ci/image-build-probe'"
		strategy: {
			matrix: include: [
				{arch: "amd64", runner: "namespace-profile-intar-dev"},
				{arch: "arm64", runner: "namespace-profile-intar-dev-arm64"},
			]
			"fail-fast": false
		}
		"runs-on":         "${{ matrix.runner }}"
		"timeout-minutes": 90
		steps: [
			gha.#Checkout,
			gha.#SetupCuenv,
			gha.#SetupRust,
			{
				name: "Build two lab images"
				env: PROBE_ARCH: "${{ matrix.arch }}"
				#StepTask & {#task: "image-probe-build"}
			},
		]
	}
}

tasks: "image-probe-build": #Script & {_script: "tools/workflows/image-probe/build.sh"}
