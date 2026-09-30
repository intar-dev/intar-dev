package workflows

import (
	"list"

	"github.com/intar-dev/intar-dev/ci/gha"
)

"workflows": website: {
	name:       "Website"
	"run-name": "Website release main @ ${{ github.sha }}"

	// Deploys main: every push that changes what can be deployed, and a manual
	// dispatch, for a revision a push did not deploy. ci.yml's web lane checks
	// pull requests with the same build steps, and the deploy job refuses any
	// other ref. Maintenance turns on only while D1 migrations are pending.
	on: {
		workflow_dispatch: {}
		// What can be deployed and the lane itself: the web app without its
		// tests, the workspace manifests, and the deploy tooling.
		push: {
			branches: ["main"]
			paths: [
				"apps/web/**",
				"!apps/web/tests/**",
				"!apps/web/**/*.test.ts",
				"package.json",
				"bun.lock",
				"patches/**",
				"tsconfig.base.json",
				".github/workflows/website.yml",
				".github/actions/setup-cuenv/**",
				".github/actions/setup-runtime/**",
				"ci/workflows/website.cue",
				"ci/workflows/tasks.cue",
				"tools/workflows/website/**",
				"tools/deploy/**",
				"tools/database/**",
			]
		}
	}
	permissions: {
		actions:  "read"
		contents: "read"
	}
	// Each run waits for the one before it, deploy included, so an older
	// revision never deploys over a newer one. The deploy job's own group
	// differs: one shared group would deadlock the run with its own job.
	concurrency: gha.#ProductionConcurrency & {group: "website"}
	jobs: {
		validate: {
			name:              "Test and build"
			"runs-on":         gha.runner
			"timeout-minutes": lanes.web.timeout
			outputs: {
				artifact_id:     "${{ steps.artifact.outputs.artifact_id }}"
				artifact_digest: "${{ steps.artifact.outputs.artifact_digest }}"
			}
			steps: list.Concat([laneSteps.web, [{
				name: "Upload tested deployment artifact"
				// The deploy job takes this exact artifact from this run.
				if:   "github.ref == 'refs/heads/main'"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                   "website-dist-${{ github.sha }}"
					path:                   "apps/web/dist"
					"include-hidden-files": true
					overwrite:              true
					"if-no-files-found":    "error"
					"retention-days":       1
				}
			}, {
				name: "Record the tested artifact identity"
				id:   "artifact"
				if:   "github.ref == 'refs/heads/main'"
				env: GH_TOKEN: "${{ github.token }}"
				#StepTask & {#task: "website-record-artifact-identity"}
			}]])
		}
		deploy: {
			name: "Deploy production"
			needs: ["validate"]
			if:        "github.ref == 'refs/heads/main'"
			"runs-on": "namespace-profile-intar-dev"
			env: {
				CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
				CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				BUCKET:                "intar-dev-vm-image-registry-20260709"
			}
			environment: {
				name: "production"
				url:  "https://intar.dev"
			}
			"timeout-minutes": 45
			concurrency: gha.#ProductionConcurrency & {group: "website-production"}
			// Only the migration steps depend on data: they run while D1 migrations
			// are pending. The hold and release recognise a maintenance version that
			// a failed deploy left serving, so a re-run or a fix push completes the
			// migration and reopens the site without an input.
			steps: [{
				name: "Checkout exact main revision"
				uses: gha.pin."nscloud-checkout".ref
				with: "persist-credentials": false
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Verify exact-main deployment revision"
				#StepTask & {#task: "website-verify-deploy-revision"}
			}, {
				name: "Download tested deployment artifact"
				env: {
					GH_TOKEN:               "${{ github.token }}"
					TESTED_ARTIFACT_ID:     "${{ needs.validate.outputs.artifact_id }}"
					TESTED_ARTIFACT_DIGEST: "${{ needs.validate.outputs.artifact_digest }}"
				}
				#StepTask & {#task: "website-download-tested-artifact"}
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Set up Bun cache"
				uses: gha.pin."nscloud-cache".ref
				with: path: "~/.bun/install/cache"
			}, {
				name: "Install deployment dependencies"
				run:  "bun install --frozen-lockfile"
			}, {
				name:                "Pin and verify production configuration"
				"working-directory": "."
				#StepTask & {#task: "website-pin-production-config"}
			}, {
				name: "Resolve and inject the verified guest-tools pin"
				#StepTask & {#task: "website-pin-guest-tools"}
			}, {
				name: "Prepare runtime secrets"
				id:   "runtime-secrets"
				env: {
					CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
					STARGATE_EGRESS_IPV4_CIDRS:              "${{ secrets.STARGATE_EGRESS_IPV4_CIDRS }}"
				}
				#StepTask & {#task: "website-prepare-runtime-secrets"}
			}, {
				name: "Plan production D1 migrations"
				id:   "migrations"
				#StepTask & {#task: "website-plan-d1-migrations"}
			}, {
				name: "Rehearse pending migrations on disposable D1"
				if:   "steps.migrations.outputs.pending == 'true'"
				env: {
					// Step outputs travel through the environment, never interpolated
					// into the command line.
					APPLIED_MIGRATION_COUNT: "${{ steps.migrations.outputs.applied }}"
				}
				run: """
					bun tools/database/rehearse-removal-migration.ts \\
					  --applied "$APPLIED_MIGRATION_COUNT" \\
					  --evidence "${RUNNER_TEMP}/d1-removal-rehearsal.json"

					"""
			}, {
				name: "Capture pre-migration D1 evidence"
				if:   "steps.migrations.outputs.pending == 'true'"
				#StepTask & {#task: "website-capture-pre-migration-d1-evidence"}
			}, {
				name: "Hold the image registry collector"
				id:   "hold"
				env: {
					// The collector has no public route: the parent worker holds the
					// service binding, and the gate route on that worker is the only path
					// to it. The route sits behind the maintenance fence, so the hold
					// happens here, while the control plane still serves, or, behind a
					// maintenance version a failed deploy left serving, from the D1
					// admission row. A no-op when no collector version is deployed yet.
					CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				}
				#StepTask & {#task: "website-hold-registry-collector"}
			}, {
				name: "Enable maintenance for pending migrations"
				if:   "steps.migrations.outputs.pending == 'true'"
				#StepTask & {#task: "website-enable-maintenance"}
			}, {
				name: "Drain and recheck maintenance"
				if:   "steps.migrations.outputs.pending == 'true'"
				#StepTask & {#task: "website-drain-maintenance"}
			}, {
				name: "Apply pending D1 migrations"
				if:   "steps.migrations.outputs.pending == 'true'"
				env: {
					CLOUDFLARE_DATABASE_ID:   "${{ env.DATABASE_ID }}"
					MIGRATION_APPLY_EVIDENCE: "${{ runner.temp }}/production-d1-migrate.json"
				}
				#StepTask & {#task: "website-apply-d1-migrations"}
			}, {
				name: "Verify production D1 schema"
				#StepTask & {#task: "website-verify-d1-schema"}
			}, {
				name: "Deploy the image registry cleanup worker"
				#StepTask & {#task: "website-deploy-registry-cleanup"}
			}, {
				name: "Deploy production at 100 percent"
				#StepTask & {#task: "website-deploy-production"}
			}, {
				name: "Release the image registry collector"
				// The hold does not expire, so every run that reached it releases the
				// collector again, also after a failed deploy. Behind a maintenance
				// version that this failure left serving, the release leaves the hold
				// for the deploy that reopens the site.
				if: "always() && steps.hold.outcome != 'skipped'"
				env: CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				#StepTask & {#task: "website-release-registry-collector"}
			}, {
				name: "Remove runtime secret file"
				if:   "always() && steps.runtime-secrets.outcome != 'skipped'"
				run:  "rm -f \"${RUNNER_TEMP}/website-runtime-secrets.json\""
			}, {
				name: "Summarize the deployment"
				if:   "always()"
				env: TESTED_ARTIFACT_DIGEST: "${{ needs.validate.outputs.artifact_digest }}"
				#StepTask & {#task: "website-summarize-deploy"}
			}, {
				name: "Retain deployment evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name: "website-production-${{ github.sha }}-${{ github.run_id }}"
					path: """
						${{ runner.temp }}/release-static-pin.json
						${{ runner.temp }}/release-static-pin-evidence.json
						${{ runner.temp }}/production-d1-plan.json
						${{ runner.temp }}/d1-removal-rehearsal.json
						${{ runner.temp }}/production-d1-info.json
						${{ runner.temp }}/production-d1-bookmark.json
						${{ runner.temp }}/pre-migration-run-drain-audit.json
						${{ runner.temp }}/pre-migration-assignment-counts.json
						${{ runner.temp }}/pre-migration-enabled-scenarios.json
						${{ runner.temp }}/production-d1-migrate.log
						${{ runner.temp }}/production-d1-migrate.json
						${{ runner.temp }}/production-d1-verified.json
						${{ runner.temp }}/maintenance-after-drain-deployment.json
						${{ runner.temp }}/maintenance-after-drain.json
						${{ runner.temp }}/web-maintenance.json
						${{ runner.temp }}/web-production.json
						${{ runner.temp }}/registry-cleanup-hold.json
						${{ runner.temp }}/registry-cleanup-release.json
						${{ runner.temp }}/registry-cleanup-deploy.json
						${{ runner.temp }}/intar-registry-cleanup-deploy-${{ github.run_id }}/
						${{ runner.temp }}/intar-registry-cleanup-gate-${{ github.run_id }}/
						${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-maintenance/
						${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-standard/

						"""
					"if-no-files-found": "warn"
					"retention-days":    30
				}
			}]
		}
	}
}

// The run steps above, one script each; see tasks.cue. A production step
// uses production credentials or changes something outside the runner.
tasks: {
	"website-record-artifact-identity": #Script & {_script: "tools/workflows/website/record-artifact-identity.sh"}
	"website-verify-deploy-revision": #Script & {_script: "tools/workflows/website/verify-deploy-revision.sh"}
	"website-download-tested-artifact": #Script & {_script: "tools/workflows/website/download-tested-artifact.sh"}
	"website-pin-production-config": #Script & {_script: "tools/workflows/website/pin-production-config.sh"}
	"website-pin-guest-tools": #Script & {_script: "tools/workflows/website/pin-guest-tools.sh", _production: true}
	"website-prepare-runtime-secrets": #Script & {_script: "tools/workflows/website/prepare-runtime-secrets.sh", _production: true}
	"website-plan-d1-migrations": #Script & {_script: "tools/workflows/website/plan-d1-migrations.sh", _production: true}
	"website-capture-pre-migration-d1-evidence": #Script & {_script: "tools/workflows/website/capture-pre-migration-d1-evidence.sh", _production: true}
	"website-hold-registry-collector": #Script & {_script: "tools/workflows/website/hold-registry-collector.sh", _production: true}
	"website-enable-maintenance": #Script & {_script: "tools/workflows/website/enable-maintenance.sh", _production: true}
	"website-drain-maintenance": #Script & {_script: "tools/workflows/website/drain-maintenance.sh", _production: true}
	"website-apply-d1-migrations": #Script & {_script: "tools/workflows/website/apply-d1-migrations.sh", _production: true}
	"website-verify-d1-schema": #Script & {_script: "tools/workflows/website/verify-d1-schema.sh", _production: true}
	"website-deploy-registry-cleanup": #Script & {_script: "tools/workflows/website/deploy-registry-cleanup.sh", _production: true}
	"website-deploy-production": #Script & {_script: "tools/workflows/website/deploy-production.sh", _production: true}
	"website-release-registry-collector": #Script & {_script: "tools/workflows/website/release-registry-collector.sh", _production: true}
	"website-summarize-deploy": #Script & {_script: "tools/workflows/website/summarize-deploy.sh"}
}
