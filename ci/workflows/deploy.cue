package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// Deploys the builds CI tested on main. Once a CI run on main passes for main's
// tip (afterCI in ci.cue), `resolve` finds the build each lane uploaded in that
// run, and the website and the docs deploy it. A lane that did not run uploaded
// nothing, and its deploy skips. A dispatch from main deploys main's tip from
// its latest successful CI run.
"workflows": deploy: {
	name:       "Deploy"
	"run-name": "Deploy main @ ${{ github.event.workflow_run.head_sha || github.sha }}"
	on: afterCI.on & {workflow_dispatch: {}}
	jobs: {
		resolve: {
			name:              "Find the tested builds"
			if:                afterCI.if
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 5
			permissions: {
				actions:  "read"
				contents: "read"
			}
			outputs: {
				for key in ["run_id", "web_artifact", "web_digest", "docs_artifact", "docs_digest"] {
					(key): "${{ steps.builds.outputs.\(key) }}"
				}
			}
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				{
					name: "Find the tested builds"
					id:   "builds"
					env: {
						GH_TOKEN:  "${{ github.token }}"
						CI_RUN_ID: "${{ github.event.workflow_run.id }}"
					}
					#StepTask & {#task: "deploy-find-builds"}
				},
			]
		}
		"deploy-web": {
			name:      "Deploy the website"
			needs:     "resolve"
			if:        "needs.resolve.outputs.web_artifact != ''"
			"runs-on": "namespace-profile-intar-dev"
			permissions: {
				actions:  "read"
				contents: "read"
			}
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
			}, _verifyRevision, _downloadBuild & {
				name: "Download tested deployment artifact"
				with: {
					"artifact-ids": "${{ needs.resolve.outputs.web_artifact }}"
					path:           "apps/web/dist"
				}
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
				env: TESTED_ARTIFACT_DIGEST: "${{ needs.resolve.outputs.web_digest }}"
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

		"deploy-docs": {
			name:              "Deploy the docs"
			needs:             "resolve"
			if:                "needs.resolve.outputs.docs_artifact != ''"
			"runs-on":         "namespace-profile-intar-dev"
			"timeout-minutes": 10
			permissions: {
				actions:  "read"
				contents: "read"
			}
			environment: {
				name: "production"
				url:  "https://docs.intar.dev"
			}
			concurrency: gha.#ProductionConcurrency & {group: "docs-production"}
			defaults: run: "working-directory": "docs"
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				_verifyRevision & {"working-directory": "."},
				_downloadBuild & {
					name: "Download tested docs"
					with: {
						"artifact-ids": "${{ needs.resolve.outputs.docs_artifact }}"
						path:           "docs/dist"
					}
				},
				gha.#SetupRuntime,
				{
					name: "Install docs deployment dependencies"
					run:  "bun install --frozen-lockfile"
				},
				{
					name: "Deploy docs"
					env: {
						CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
						CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
					}
					run: "bunx --no-install wrangler deploy"
				},
			]
		}
	}
}

// Both deploys refuse a revision other than the one checked out, and a re-run
// once main has moved on.
let _verifyRevision = {
	name: "Verify exact-main deployment revision"
	env: GH_TOKEN: "${{ github.token }}"
	#StepTask & {#task: "deploy-verify-revision"}
}

// The lane's build from the CI run resolve found, by the artifact id it
// checked. The action fails when the download's SHA-256 differs from the
// digest GitHub recorded at the upload.
let _downloadBuild = {
	uses: gha.pin."download-artifact".ref
	with: {
		"run-id":          "${{ needs.resolve.outputs.run_id }}"
		"github-token":    "${{ github.token }}"
		"digest-mismatch": "error"
	}
}

// The run steps above, one script each; see tasks.cue. The website deploy's
// own steps keep their website- names and live in tools/workflows/website. A
// production step uses production credentials or changes something outside the
// runner.
tasks: {
	"deploy-find-builds": #Script & {_script: "tools/workflows/deploy/find-builds.sh"}
	"deploy-verify-revision": #Script & {_script: "tools/workflows/deploy/verify-revision.sh"}
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
