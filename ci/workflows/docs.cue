package workflows

import (
	"list"

	"github.com/intar-dev/intar-dev/ci/gha"
)

"workflows": docs: {
	name:       "Docs"
	"run-name": "${{ github.ref != 'refs/heads/main' && format('Docs validate {0} @ {1}', github.ref_name, github.sha) || format('Docs deploy main @ {0}', github.sha) }}"

	// A push to main deploys. A manual dispatch from main deploys too, for when a
	// push never started a run; from another branch it only builds. ci.yml's
	// docs lane checks pull requests with the same build steps.
	on: {
		workflow_dispatch: {}
		push: {
			branches: ["main"]
			paths: [
				".github/workflows/docs.yml",
				".github/actions/setup-cuenv/**",
				".github/actions/setup-runtime/**",
				"apps/web/.node-version",
				"docs/**"]
		}
	}
	permissions: contents: "read"
	concurrency: gha.#ProductionConcurrency & {group: "docs-production"}
	jobs: {
		build: {
			name:              "Test and build"
			"runs-on":         gha.runner
			"timeout-minutes": lanes.docs.timeout
			steps: list.Concat([laneSteps.docs, [{
				name: "Upload tested docs"
				if:   "github.ref == 'refs/heads/main'"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                "docs-dist-${{ github.sha }}"
					path:                "docs/dist"
					overwrite:           true
					"if-no-files-found": "error"
					"retention-days":    1
				}
			}]])
		}
		deploy: {
			name:              "Deploy production"
			if:                "github.ref == 'refs/heads/main'"
			needs:             "build"
			"runs-on":         "namespace-profile-intar-dev"
			"timeout-minutes": 10
			environment: {
				name: "production"
				url:  "https://docs.intar.dev"
			}
			defaults: run: "working-directory": "docs"
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
