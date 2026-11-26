package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": kernel: {
	name:       "Guest kernel"
	"run-name": "Guest kernel @ ${{ github.sha }}"

	// Compiles the guest kernel of both architectures, each on a runner of its
	// own, boots each, and publishes the two files as the release
	// kernel/v<set>. Image builds download them and check the SHA-256 pinned in
	// crates/intar-image-build/src/kernel.rs, so the release is only where the
	// bytes are kept: nothing reaches an image until a reviewed change pins it.
	//
	// Every week, and when started by hand, a run takes Debian's newest kernel
	// source of the pinned series. When that is newer than the pin, the run
	// builds, boots and publishes it and opens the pull request updates/kernel
	// with every pin moved. A week without a newer kernel rebuilds the pinned
	// one, which must give the published bytes again.
	//
	// A pull request that changes the kernel's inputs by hand runs the build
	// and the boot and publishes nothing: its summary prints the set and both
	// checksums, and the pull request pins them (pin.py). The build is
	// reproducible, so merging it publishes exactly those bytes: the push to
	// main rebuilds the set, refuses a file that is not the pinned one, and
	// publishes it. Nothing is published from a branch.
	on: {
		workflow_dispatch: {}
		schedule: [{cron: "41 4 * * 1"}]
		pull_request: {
			branches: ["main"]
			paths:    _inputs
		}
		push: {
			branches: ["main"]
			paths:    _inputs
		}
	}
	concurrency: gha.#PRConcurrency & {#name: "intar-kernel"}
	permissions: contents: "read"
	jobs: {
		check: {
			name:              "Check for a newer kernel"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 20
			outputs: {
				set:     "${{ steps.check.outputs.set }}"
				tag:     "${{ steps.check.outputs.tag }}"
				release: "${{ steps.check.outputs.release }}"
				pin:     "${{ steps.check.outputs.pin }}"
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				gha.#SetupRust & {with: "namespace-cache": "false"},
				{
					name: "Decide what this run does"
					id:   "check"
					#StepTask & {#task: "kernel-check"}
				},
				{
					name: "Keep the decision"
					uses: gha.pin."upload-artifact".ref
					with: {
						name:                "kernel-bump"
						path:                "${{ runner.temp }}/kernel-bump/latest.json"
						"if-no-files-found": "error"
						"retention-days":    7
					}
				},
			]
		}
		build: {
			name: "Build ${{ matrix.arch }}"
			needs: ["check"]
			strategy: {
				matrix: include: [
					{arch: "amd64", runner: gha.runners.chonky},
					{arch: "arm64", runner: gha.runners.arm64},
				]
				"fail-fast": false
			}
			"runs-on":         "${{ matrix.runner }}"
			"timeout-minutes": 120
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				// A published file must not depend on a cache another run wrote.
				gha.#SetupRust & {with: "namespace-cache": "false"},
				_takeBump,
				{
					name: "Take the kernel source this run builds"
					#StepTask & {#task: "kernel-apply-bump"}
				},
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
		// The boot runs on a runner of its own. On the arm64 profile a KVM guest
		// booted right after the kernel compile on the same runner stalls on its
		// first disk reads and times out, while the same file boots in seconds
		// on a fresh runner (#559). It boots the file build kept, so what is
		// published is exactly what booted.
		boot: {
			name: "Boot ${{ matrix.arch }}"
			needs: ["build"]
			strategy: {
				matrix: include: [
					{arch: "amd64", runner: gha.runners.chonky},
					{arch: "arm64", runner: gha.runners.arm64},
				]
				"fail-fast": false
			}
			"runs-on":         "${{ matrix.runner }}"
			"timeout-minutes": 30
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				gha.#SetupRust & {with: "namespace-cache": "false"},
				_takeBump,
				{
					name: "Take the kernel source this run builds"
					#StepTask & {#task: "kernel-apply-bump"}
				},
				{
					name: "Take the kernel"
					uses: gha.pin."download-artifact".ref
					with: {
						name: "kernel-${{ matrix.arch }}"
						path: "dist/"
					}
				},
				{
					name: "Boot the kernel"
					env: KERNEL_ARCH: "${{ matrix.arch }}"
					#StepTask & {#task: "kernel-smoke"}
				},
			]
		}
		// A set that is already published must hold exactly these bytes: that
		// is the weekly proof the pinned kernel still reproduces.
		publish: {
			name: "Publish ${{ needs.check.outputs.tag }}"
			needs: ["check", "build", "boot"]
			if:                "github.event_name != 'pull_request'"
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
						pattern:          "kernel-a*"
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
						TAG:      "${{ needs.check.outputs.tag }}"
					}
					#StepTask & {#task: "kernel-publish"}
				},
			]
		}
		// The release app's key is in the release-pr environment, which only
		// main can use: a run on another branch stops here.
		pin: {
			name: "Open the pull request that pins ${{ needs.check.outputs.tag }}"
			needs: ["check", "publish"]
			if:                "needs.check.outputs.pin == 'true'"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 30
			environment:       "release-pr"
			steps: [
				gha.#AppToken,
				gha.#Checkout & {with: token: "${{ steps.app-token.outputs.token }}"},
				gha.#SetupCuenv,
				gha.#SetupRust & {with: "namespace-cache": "false"},
				_takeBump,
				{
					name: "Take the kernel source this run builds"
					#StepTask & {#task: "kernel-apply-bump"}
				},
				{
					name: "Pin the published kernels and open the pull request"
					env: {
						GH_TOKEN:       "${{ steps.app-token.outputs.token }}"
						APP_SLUG:       "${{ steps.app-token.outputs.app-slug }}"
						TAG:            "${{ needs.check.outputs.tag }}"
						KERNEL_RELEASE: "${{ needs.check.outputs.release }}"
					}
					#StepTask & {#task: "kernel-pin-pr"}
				},
			]
		}
	}
}

// What decides the kernel's bytes, and so which changes run this workflow.
let _inputs = [
	"tools/workflows/kernel/**",
	".github/workflows/kernel.yml",
	"crates/intar-image-build/src/kernel.rs",
	"crates/intar-image-build/kernel/**",
]

// What the check job decided, for the jobs after it.
let _takeBump = {
	name: "Take the decision"
	uses: gha.pin."download-artifact".ref
	with: {
		name: "kernel-bump"
		path: "${{ runner.temp }}/kernel-bump"
	}
}

tasks: {
	"kernel-check": #Script & {_script:      "tools/workflows/kernel/check.sh"}
	"kernel-apply-bump": #Script & {_script: "tools/workflows/kernel/apply-bump.sh"}
	"kernel-build": #Script & {_script:      "tools/workflows/kernel/build.sh"}
	"kernel-smoke": #Script & {_script:      "tools/workflows/kernel/smoke.sh"}
	"kernel-checksums": #Script & {_script:  "tools/workflows/kernel/checksums.sh"}
	"kernel-publish": #Script & {_script:    "tools/workflows/kernel/publish.sh", _production: true}
	"kernel-pin-pr": #Script & {_script:     "tools/workflows/kernel/pin-pr.sh", _production: true}
}
