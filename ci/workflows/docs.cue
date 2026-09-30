package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": docs: {
	name:       "Docs"
	"run-name": "${{ github.event_name == 'pull_request' && format('Docs validate PR #{0}', github.event.pull_request.number) || github.event_name == 'workflow_dispatch' && (inputs.confirmation != 'DEPLOY DOCS' || github.ref != 'refs/heads/main') && format('Docs validate {0} @ {1}', github.ref_name, github.sha) || format('Docs deploy main @ {0}', github.sha) }}"

	// A push to main deploys. A manual dispatch validates, and deploys main only
	// with the confirmation, for when a push never started a run.
	on: {
		workflow_dispatch: inputs: confirmation: {
			description: "Type DEPLOY DOCS to deploy main from a manual dispatch"
			required:    false
			type:        "string"
		}
		pull_request: paths: [
			".github/workflows/docs.yml",
			".github/actions/setup-runtime/**",
			"apps/web/.node-version",
			"docs/**",
		]
		push: {
			branches: ["main"]
			paths: [
				".github/workflows/docs.yml",
				".github/actions/setup-runtime/**",
				"apps/web/.node-version",
				"docs/**"]
		}
	}
	permissions: contents: "read"
	concurrency: {
		group:                "docs-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'production' }}"
		"cancel-in-progress": "${{ github.event_name == 'pull_request' }}"
	}
	defaults: run: "working-directory": "docs"
	jobs: {
		build: {
			name:              "Test and build"
			"runs-on":         "namespace-profile-intar-dev"
			"timeout-minutes": 10
			steps: [{
				name: "Checkout"
				uses: gha.pin.checkout.ref
				with: "persist-credentials": false
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Install docs dependencies"
				run:  "bun install --frozen-lockfile"
			}, {
				name: "Build docs"
				run:  "bun run build"
			}, {
				name: "Validate Cloudflare deployment"
				run:  "bunx --no-install wrangler deploy --dry-run"
			}, {
				name: "Upload tested docs"
				if:   "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.confirmation == 'DEPLOY DOCS')"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                "docs-dist-${{ github.sha }}"
					path:                "docs/dist"
					overwrite:           true
					"if-no-files-found": "error"
					"retention-days":    1
				}
			}]
		}
		deploy: {
			name:              "Deploy production"
			if:                "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.confirmation == 'DEPLOY DOCS')"
			needs:             "build"
			"runs-on":         "namespace-profile-intar-dev"
			"timeout-minutes": 10
			environment: {
				name: "production"
				url:  "https://docs.intar.dev"
			}
			steps: [{
				name: "Checkout"
				uses: gha.pin.checkout.ref
				with: "persist-credentials": false
			}, {
				name: "Download tested docs"
				uses: gha.pin."download-artifact".ref
				with: {
					name: "docs-dist-${{ github.sha }}"
					path: "docs/dist"
				}
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Install docs deployment dependencies"
				run:  "bun install --frozen-lockfile"
			}, {
				name: "Deploy docs"
				env: {
					CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				}
				run: "bunx --no-install wrangler deploy"
			}]
		}
	}
}
