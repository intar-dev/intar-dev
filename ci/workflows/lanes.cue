package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// The CI lanes. ci.yml runs each lane as one job when a file matching its
// inputs or sharedInputs changed, and every lane on a push to main or a
// dispatch. `cuenv task lanes.<name>` runs the same steps locally, and
// `cuenv task ci` runs every lane (see env.cue).
lanes: [string]: close({
	// Path globs, matched as git :(glob) pathspecs by tools/ci/changed-lanes.sh:
	// ** crosses directories, and **/Cargo.toml matches the root one too.
	inputs: [...string]
	// Setup after the checkout and cuenv.
	setup: [...gha.#Step]
	// Root tasks, run in order.
	steps: [...string]
	timeout: int
	// The build the lane checks, which deploy.yml deploys: on main, ci.yml
	// uploads this directory as the artifact <lane>-dist-<sha>.
	dist?: {
		path!: string
		// Whether the upload keeps dotfiles.
		hidden!: bool
	}
})

// A change to one of these runs every lane: they define the lanes, the tasks
// the lanes run, and the gate.
sharedInputs: [
	"env.cue",
	"cue.mod/**",
	"ci/**",
	".github/workflows/ci.yml",
	".github/actions/setup-cuenv/**",
	"tools/ci/changed-lanes.sh",
]

lanes: {
	rust: {
		setup: [gha.#SetupRust]
		steps: ["installer-tests", "verify", "check-generated-contracts", "build-kino-guest"]
		timeout: 45
		inputs: [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"rustfmt.toml",
			"tools/image-build/**",
			".github/actions/setup-rust/**",
			// deploy/personal-metal/test_installer.py reads release.yml and the
			// release artifact build step.
			".github/workflows/release.yml",
			"tools/workflows/release/build-release-artifacts.sh",
			"package.json",
			"bun.lock",
			"content/scenarios/base-images.hcl",
			"crates/**",
			"deploy/personal-metal/**",
			"apps/web/public/install.sh",
			"apps/web/src/generated/**",
		]
	}

	// Script lint runs before the audits: a dependency audit must not stop the
	// shell correctness check of the host deployment scripts.
	security: {
		setup: [gha.#SetupRust, gha.#SetupRuntime]
		steps: ["host-scripts", "whitespace", "sync-check", "install-js", "workflow-policy", "security", "actionlint"]
		timeout: 30
		inputs: [
			".github/**",
			".cargo/audit.toml",
			"**/Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"bun.lock",
			"**/package.json",
			"apps/web/.node-version",
			"apps/web/public/_headers",
			"apps/web/vitest.workers.config.ts",
			"apps/web/wrangler.jsonc",
			"apps/web/wrangler.local.jsonc",
			"deploy/stargate/**",
			"docs/public/_headers",
			"docs/wrangler.jsonc",
			// The Rust audit must still run for a Rust source change: it is the
			// only audit that sees a newly published advisory.
			"crates/**",
			"tools/ci/**",
			"tools/workflows/**",
			"tools/image-build/**",
		]
	}

	images: {
		setup: [gha.#SetupRust]
		steps: ["validate-images", "render-images"]
		timeout: 30
		inputs: [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"tools/image-build/**",
			".github/actions/setup-rust/**",
			"crates/intar-builder/**",
			"crates/intar-contracts/**",
			"crates/intar-contracts-typegen/**",
			"crates/intar-image-*/**",
			"content/scenarios/base-images.hcl",
			"builder.*.hcl",
			"content/courses/**",
			"apps/web/migrations/**",
			"apps/web/src/control-plane/auth.ts",
			"apps/web/src/control-plane/bridge-v8.ts",
			"apps/web/src/control-plane/host-runtime-do.ts",
			"apps/web/src/control-plane/image-registry.ts",
			"apps/web/src/generated/**",
			"apps/web/src/lib/build-scheduler*.ts",
			"apps/web/src/lib/desired-state*.ts",
			"apps/web/src/lib/host-runtime-wake.ts",
			"apps/web/src/lib/scenario-hosts.ts",
			"apps/web/src/db/schema.ts",
			"apps/web/src/pages/api/agent/hosts.ts",
		]
	}

	// deploy.yml deploys the build this lane checks, with the deploy tooling
	// below; ci/workflows/deploy.cue is a shared input.
	web: {
		setup: [gha.#SetupRuntime, gha.#BunCache]
		steps: ["install-js", "test.js", "build.js", "check-web-artifact"]
		timeout: 30
		dist: {path: "apps/web/dist", hidden: true}
		inputs: [
			".github/workflows/deploy.yml",
			".github/actions/setup-runtime/**",
			"tools/workflows/deploy/**",
			"tools/workflows/website/**",
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			"package.json",
			"bun.lock",
			"patches/**",
			"tsconfig.base.json",
			"tools/check-import-boundaries.ts",
			"tools/database/**",
			"tools/deploy/**",
			"tools/vm-boot-benchmark/**",
			"tools/*.py",
			// tools/test_published_image_verifier.py, which test.js runs, loads it.
			"tools/image-build/verify-published-image.py",
			"crates/intar-image-scenario/**",
			"apps/web/**",
		]
	}

	// deploy.yml deploys the build this lane checks.
	docs: {
		setup: [gha.#SetupRuntime]
		steps: ["check-docs"]
		timeout: 10
		dist: {path: "docs/dist", hidden: false}
		inputs: [
			".github/workflows/deploy.yml",
			".github/actions/setup-runtime/**",
			"tools/workflows/deploy/**",
			"apps/web/.node-version",
			"docs/**",
		]
	}
}

// Each lane's job steps, which `cuenv task lanes.<name>` runs locally too.
laneSteps: {
	for name, lane in lanes {
		(name): [
			gha.#Checkout & {uses: gha.pin."nscloud-checkout".ref},
			gha.#SetupCuenv,
			for step in lane.setup {step},
			for task in lane.steps {gha.#Run & {name: task, #task: task}},
		]
	}
}

// The Chromium smoke, a job of its own because it runs in the Playwright
// container. `cuenv task test-ui-smoke` runs the same test locally.
chromiumSmoke: {
	name:      "Chromium smoke"
	"runs-on": gha.runner
	container: {
		image:   "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27"
		options: "--ipc=host"
	}
	steps: [{
		name: "Checkout"
		uses: gha.pin.checkout.ref
		with: "persist-credentials": false
	}, {
		name: "Set up Node"
		uses: gha.pin."setup-node".ref
		with: "node-version-file": "apps/web/.node-version"
	}, {
		name:                "Install Bun setup prerequisite"
		"working-directory": "apps/web"
		run:                 "apt-get update && apt-get install --yes --no-install-recommends unzip=6.0-28ubuntu4.1"
	}, {
		name: "Set up Bun"
		uses: gha.pin."setup-bun".ref
		with: "bun-version": "1.3.14"
	}, {
		name: "Install dependencies"
		run:  "bun install --frozen-lockfile"
	}, {
		name:                "Run Chromium smoke"
		"working-directory": "apps/web"
		env: {
			CI:   "true"
			HOME: "/root"
		}
		run: "bunx playwright test tests/ui/smoke.spec.ts --project=chromium-smoke"
	}, {
		name: "Upload smoke report"
		if:   "always()"
		uses: gha.pin."upload-artifact".ref
		with: {
			name: "website-smoke-${{ github.run_attempt }}"
			path: """
				.tmp/website-playwright/playwright-report
				.tmp/website-playwright/test-results

				"""
			"if-no-files-found": "warn"
			"retention-days":    7
		}
	}]
}
