package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": website: {
	name: "Website"
	"run-name": """
		${{ github.event_name == 'pull_request'
		    && format('Website validate PR #{0}', github.event.pull_request.number)
		    || format('Website release main @ {0}', github.sha) }}
		"""

	// One lane for the website: validate and smoke on every change, then release
	// the tested artifact. A push to main deploys it. A manual dispatch may deploy
	// deliberately (maintenance on or off, or the registry delete campaign) or
	// validate only, which is what the default operation does.
	on: {
		workflow_dispatch: inputs: {
			operation: {
				description: "validate runs the checks only, deploy releases this revision"
				required:    false
				default:     "validate"
				type:        "choice"
				options: [
					"validate",
					"deploy",
				]
			}
			maintenance: {
				description: "auto follows pending migrations, on holds the control plane closed for a deliberate release, off returns the release to service"
				required:    false
				default:     "auto"
				type:        "choice"
				options: [
					"auto",
					"on",
					"off",
				]
			}
			registry_cleanup_mode: {
				description: "Image registry cleanup worker mode for this release"
				required:    false
				default:     "preserve"
				type:        "choice"
				options: [
					"preserve",
					"report-only",
					"delete",
				]
			}
		}
		push: {
			branches: ["main"]
			paths: [
				".github/workflows/website.yml",
				".github/actions/setup-runtime/**",
				".github/actions/setup-cuenv/**",
				"ci/workflows/website.cue",
				"ci/workflows/tasks.cue",
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
				"tools/vm-boot-benchmark.py",
				"tools/test_vm_boot_benchmark.py",
				"crates/intar-image-scenario/**",
				"apps/web/**",
			]
		}
		pull_request: paths: [
			".github/workflows/website.yml",
			".github/actions/setup-runtime/**",
			".github/actions/setup-cuenv/**",
			"ci/workflows/website.cue",
			"ci/workflows/tasks.cue",
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
			"tools/vm-boot-benchmark.py",
			"tools/test_vm_boot_benchmark.py",
			"crates/intar-image-scenario/**",
			"apps/web/**"]
	}
	permissions: {
		actions:  "read"
		contents: "read"
	}
	concurrency: {
		// Validation never shares a group with the deploy job, which waits for this
		// run: one shared group could deadlock both.
		group:                "website-validate-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || 'main' }}"
		"cancel-in-progress": "${{ github.event_name == 'pull_request' }}"
	}
	jobs: {
		validate: {
			name:      "Test and build"
			"runs-on": "namespace-profile-intar-dev"
			outputs: {
				artifact_id:     "${{ steps.artifact.outputs.artifact_id }}"
				artifact_digest: "${{ steps.artifact.outputs.artifact_digest }}"
			}
			steps: [{
				name: "Checkout"
				uses: gha.pin."nscloud-checkout".ref
				with: "persist-credentials": false
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Set up Bun cache"
				uses: gha.pin."nscloud-cache".ref
				with: path: "~/.bun/install/cache"
			}, {
				name: "Install dependencies"
				run:  "bun install --frozen-lockfile"
			}, {
				name: "Check web contracts"
				#StepTask & {#task: "website-check-web-contracts"}
			}, {
				name:                "Test"
				"working-directory": "apps/web"
				run:                 "bun run test"
			}, {
				name:                "Build"
				"working-directory": "apps/web"
				run:                 "bun run build"
			}, {
				name: "Verify the image registry cleanup worker artifact"
				#StepTask & {#task: "website-verify-registry-cleanup-artifact"}
			}, {
				name: "Upload tested deployment artifact"
				// The release workflow pushes its version commit with GITHUB_TOKEN,
				// and GitHub suppresses workflow triggers for that token, so a release
				// SHA can reach main with no Website run. A manual dispatch of this
				// same workflow on that same main revision is the supported way to
				// produce the tested artifact, and the deploy lane accepts either
				// event as long as the revision matches exactly.
				if:   "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'"
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
				if:   "github.ref == 'refs/heads/main' && github.event_name != 'pull_request'"
				env: GH_TOKEN: "${{ github.token }}"
				#StepTask & {#task: "website-record-artifact-identity"}
			}]
		}
		ui: {
			name:      "Chromium smoke"
			"runs-on": "namespace-profile-intar-dev"
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
		plan: {
			name: "Plan the release"
			needs: [
				"validate",
				"ui",
			]
			if:        "github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.operation == 'deploy'))"
			"runs-on": "namespace-profile-intar-dev"
			env: BUCKET: "intar-dev-vm-image-registry-20260709"
			environment: {
				name: "production"
				url:  "https://intar.dev"
			}
			"timeout-minutes": 30
			outputs: {
				static_pin_json:       "${{ steps.pin.outputs.static_pin_json }}"
				maintenance:           "${{ steps.request.outputs.maintenance }}"
				registry_cleanup_mode: "${{ steps.request.outputs.registry_cleanup_mode }}"
				artifact_id:           "${{ needs.validate.outputs.artifact_id }}"
				artifact_digest:       "${{ needs.validate.outputs.artifact_digest }}"
			}
			steps: [{
				name: "Validate the release request"
				id:   "request"
				env: {
					EVENT_NAME:             "${{ github.event_name }}"
					REQUESTED_MAINTENANCE:  "${{ inputs.maintenance || 'auto' }}"
					REQUESTED_CLEANUP_MODE: "${{ inputs.registry_cleanup_mode || 'preserve' }}"
				}
				run: """
					set -euo pipefail
					test "${GITHUB_REF}" = refs/heads/main
					case "${EVENT_NAME}" in
					  push)
					    # A push releases what the tests proved. It never closes the
					    # plane on its own and never asks for the delete campaign, so an
					    # unattended release can not change the runtime contract or
					    # remove registry objects.
					    test "${REQUESTED_MAINTENANCE}" = auto
					    test "${REQUESTED_CLEANUP_MODE}" = preserve
					    ;;
					  workflow_dispatch) ;;
					  *)
					    echo "unsupported release event: ${EVENT_NAME}" >&2
					    exit 1
					    ;;
					esac
					case "${REQUESTED_MAINTENANCE}" in
					  auto|on|off) ;;
					  *) echo 'maintenance must be auto, on, or off' >&2; exit 1 ;;
					esac
					case "${REQUESTED_CLEANUP_MODE}" in
					  preserve|report-only|delete) ;;
					  *) echo 'registry_cleanup_mode must be preserve, report-only, or delete' >&2; exit 1 ;;
					esac
					{
					  printf 'maintenance=%s\\n' "${REQUESTED_MAINTENANCE}"
					  printf 'registry_cleanup_mode=%s\\n' "${REQUESTED_CLEANUP_MODE}"
					} >> "${GITHUB_OUTPUT}"
					printf 'maintenance=%s registry_cleanup_mode=%s\\n' \\
					  "${REQUESTED_MAINTENANCE}" "${REQUESTED_CLEANUP_MODE}"

					"""
			}, {
				name: "Checkout exact main revision"
				uses: gha.pin."nscloud-checkout".ref
				with: "persist-credentials": false
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Install locked workspace tools"
				run:  "bun install --frozen-lockfile"
			}, {
				name: "Resolve the verified guest-tools pin"
				id:   "pin"
				env: {
					GH_TOKEN:              "${{ github.token }}"
					MAINTENANCE_MODE:      "${{ steps.request.outputs.maintenance }}"
					CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				}
				#StepTask & {#task: "website-resolve-guest-tools-pin"}
			}, {
				name: "Activate the D1 upload admission switch for a delete release"
				// An explicit prerequisite: only a dispatch that asked for delete turns
				// this on. It runs before the deploy job closes the plane, because the
				// registry sits behind the maintenance fence.
				if: "steps.request.outputs.registry_cleanup_mode == 'delete'"
				env: REGISTRY_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				#StepTask & {#task: "website-activate-upload-admission"}
			}, {
				name: "Retain release evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name: "website-release-${{ github.sha }}-${{ github.run_id }}"
					path: """
						${{ runner.temp }}/release-static-pin.json
						${{ runner.temp }}/release-static-pin-evidence.json
						${{ runner.temp }}/registry-cleanup-activation.json

						"""
					"if-no-files-found": "warn"
					"retention-days":    30
				}
			}]
		}
		deploy: {
			name: "Deploy production"
			needs: ["plan"]
			"runs-on": "namespace-profile-intar-dev"
			env: {
				CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
				CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
			}
			environment: {
				name: "production"
				url:  "https://intar.dev"
			}
			// Preparation is the plan job now, so this bound covers the deployment
			// phases plus the delete campaign's sixty minutes.
			"timeout-minutes": 90
			concurrency: {
				group:                "website-production"
				"cancel-in-progress": false
			}
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
					TESTED_ARTIFACT_ID:     "${{ needs.plan.outputs.artifact_id }}"
					TESTED_ARTIFACT_DIGEST: "${{ needs.plan.outputs.artifact_digest }}"
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
				name: "Inject the verified ABI 2 guest-tools pin"
				env: {
					GUEST_TOOLS_PIN_JSON: "${{ needs.plan.outputs.static_pin_json }}"
					MAINTENANCE_MODE:     "${{ needs.plan.outputs.maintenance }}"
				}
				#StepTask & {#task: "website-inject-guest-tools-pin"}
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
				if:   "steps.migrations.outputs.pending == 'true' || needs.plan.outputs.maintenance != 'auto'"
				env: {
					// Both cutover operations, the pin deploy and the return to service,
					// require the drained gate and a whole-fleet zero state. The normal
					// migration path keeps only its original run and artifact checks.
					REQUIRE_DRAINED_GATE: "${{ needs.plan.outputs.maintenance != 'auto' }}"
				}
				#StepTask & {#task: "website-capture-pre-migration-d1-evidence"}
			}, {
				name: "Inspect the image registry cleanup deployment"
				id:   "registry-cleanup-state"
				env: REGISTRY_CLEANUP_INTENT: "${{ needs.plan.outputs.registry_cleanup_mode }}"
				#StepTask & {#task: "website-inspect-registry-cleanup"}
			}, {
				name:                "Prepare the parent bootstrap configuration"
				"working-directory": "."
				if:                  "(steps.registry-cleanup-state.outputs.child_present != 'true')"
				#StepTask & {#task: "website-prepare-bootstrap-config"}
			}, {
				name:                "Prepare maintenance configuration"
				"working-directory": "."
				if:                  "(steps.migrations.outputs.pending == 'true' || needs.plan.outputs.maintenance == 'on')"
				#StepTask & {#task: "website-prepare-maintenance-config"}
			}, {
				name: "Hold the image registry collector before the migration"
				// A reopen already holds a paused collector, and the control plane is
				// still closed at this point, so its hold would travel to a fenced
				// route. The release step below is what the reopen needs.
				if: "(needs.plan.outputs.maintenance != 'off')"
				env: {
					// The collector has no public route: the parent worker holds the
					// service binding, and the gate route on that worker is the only path
					// to it. The route sits behind the maintenance fence, so the hold
					// happens here, while the control plane still serves. A no-op when no
					// collector version is deployed yet.
					CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				}
				#StepTask & {#task: "website-hold-registry-collector"}
			}, {
				name: "Enable maintenance for pending migrations"
				if:   "(steps.migrations.outputs.pending == 'true' || needs.plan.outputs.maintenance == 'on')"
				env: WEB_DEPLOY_LABEL: "maintenance"
				run: """
					tools/deploy/deploy-web.sh \\
					  "${MAINTENANCE_DEPLOYMENT_CONFIG}" \\
					  "${DATABASE_ID}" \\
					  "${ACTIVATION_SECRETS_FILE}" \\
					  "${RUNNER_TEMP}/web-maintenance.json"

					"""
			}, {
				name: "Drain and recheck maintenance"
				if:   "(steps.migrations.outputs.pending == 'true' || needs.plan.outputs.maintenance == 'on')"
				#StepTask & {#task: "website-drain-maintenance"}
			}, {
				name: "Deploy the parent revision for the first cleanup rollout"
				if:   "(steps.registry-cleanup-state.outputs.child_present != 'true' && steps.migrations.outputs.pending != 'true' && needs.plan.outputs.maintenance == 'auto')"
				env: WEB_DEPLOY_LABEL: "bootstrap"
				#StepTask & {#task: "website-deploy-bootstrap-parent"}
			}, {
				name: "Apply pending D1 migrations"
				if:   "(steps.migrations.outputs.pending == 'true')"
				env: {
					CLOUDFLARE_DATABASE_ID:   "${{ env.DATABASE_ID }}"
					MIGRATION_APPLY_EVIDENCE: "${{ runner.temp }}/production-d1-migrate.json"
				}
				#StepTask & {#task: "website-apply-d1-migrations"}
			}, {
				name: "Verify production D1 schema"
				#StepTask & {#task: "website-verify-d1-schema"}
			}, {
				name: "Verify the deployed image registry cleanup worker"
				// The reopen operation runs with the control plane already closed and in
				// a fresh runner, so the hold evidence that a delete-capable child
				// deploy requires can never exist here. This gate decides instead: when
				// the collector that serves is already this revision in this mode, the
				// reopen keeps it, releases it, and lets the campaign prove the delete
				// authority from the open parent. When it would have to replace a
				// delete-capable collector, it refuses with the operation to run instead
				// of deadlocking on evidence the fenced control plane can not produce.
				id: "registry-cleanup-child"
				if: "(needs.plan.outputs.maintenance == 'off')"
				env: REGISTRY_CLEANUP_OPERATION: "reopen"
				#StepTask & {#task: "website-verify-deployed-registry-cleanup"}
			}, {
				name: "Deploy the image registry cleanup worker"
				// A reopen verifies the deployed collector instead of replacing it: the
				// verification step above sets skip, and the reopen then only reopens
				// the parent, releases the collector, and runs the campaign. A skipped
				// verification step leaves skip empty, so every other path still deploys.
				if: "(steps.registry-cleanup-child.outputs.skip != 'true')"
				#StepTask & {#task: "website-deploy-registry-cleanup"}
			}, {
				name: "Deploy production at 100 percent"
				env: WEB_DEPLOY_LABEL: "standard"
				run: """
					tools/deploy/deploy-web.sh \\
					  "${DEPLOYMENT_CONFIG}" \\
					  "${DATABASE_ID}" \\
					  "${ACTIVATION_SECRETS_FILE}" \\
					  "${RUNNER_TEMP}/web-production.json"

					"""
			}, {
				name: "Release the image registry collector"
				// A cutover keeps the control plane closed, so the collector stays held
				// and the reopen operation releases it after its maintenance-off deploy.
				// A paused collector can not retire anything, and it can not refuse a
				// learner either.
				if: "(always() && needs.plan.outputs.maintenance != 'on')"
				env: CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				#StepTask & {#task: "website-release-registry-collector"}
			}, {
				name: "Verify the report-only collector through the parent binding"
				// The rollout verification of the report-only phase: the parent now
				// serves with maintenance off and the collector has been released, so
				// one plan call proves the first report child binding. The collector
				// must report that it read the maintenance flag from the control plane
				// version that serves traffic, and that version must be open, and the
				// plan must be complete and fault free. That is the evidence a later
				// delete release needs from the report-only rollout before it turns
				// deletes on. A plan is a read, so it deletes nothing.
				if: "(always() && needs.plan.outputs.maintenance != 'on' && env.REGISTRY_CLEANUP_MODE == 'report-only')"
				env: CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				#StepTask & {#task: "website-verify-report-only-collector"}
			}, {
				name: "Run the image registry cleanup to completion"
				// The release that turns deletes on, and the reopen that follows a
				// cutover, clear the backlog in the same rollout: a report-only
				// collector never deletes, so this step runs only in delete mode. The
				// campaign is bounded by passes and by wall clock inside the script,
				// and it proves the result with a fresh report whose keyset digest is
				// the one the finished campaign recorded.
				if: "(always() && needs.plan.outputs.maintenance != 'on' && env.REGISTRY_CLEANUP_MODE == 'delete')"
				env: {
					CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
					// A full plan takes roughly 90 seconds plus its post-scan, so the
					// script's 15-minute manual default can not finish a large backlog.
					// CI gets 60 minutes here, inside the job's 75. Early completion still
					// returns immediately.
					REGISTRY_CLEANUP_RUN_DEADLINE_MS: "3600000"
				}
				#StepTask & {#task: "website-run-registry-cleanup"}
			}, {
				name: "Remove runtime secret file"
				if:   "always() && steps.runtime-secrets.outcome != 'skipped'"
				run:  "rm -f \"${RUNNER_TEMP}/website-runtime-secrets.json\""
			}, {
				name: "Retain deployment evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name: "website-production-${{ github.sha }}-${{ github.run_id }}"
					path: """
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
						${{ runner.temp }}/registry-cleanup-run.json
						${{ runner.temp }}/registry-cleanup-preview.json
						${{ runner.temp }}/registry-cleanup-child.json
						${{ runner.temp }}/registry-cleanup-deploy.json
						${{ runner.temp }}/registry-cleanup-state.json
						${{ runner.temp }}/registry-cleanup-active-deployment.json
						${{ runner.temp }}/registry-cleanup-active-version.json
						${{ runner.temp }}/registry-cleanup-mode.json
						${{ runner.temp }}/web-bootstrap.json
						${{ runner.temp }}/intar-registry-cleanup-deploy-${{ github.run_id }}/
						${{ runner.temp }}/intar-registry-cleanup-gate-${{ github.run_id }}/
						${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-maintenance/
						${{ runner.temp }}/intar-web-deploy-${{ github.run_id }}-standard/

						"""
					"if-no-files-found": "warn"
					"retention-days":    14
				}
			}]
		}
	}
}

// The run steps above, one script each; see tasks.cue. A production step
// uses production credentials or changes something outside the runner.
tasks: {
	"website-check-web-contracts": #Script & {_script: "tools/workflows/website/check-web-contracts.sh"}
	"website-verify-registry-cleanup-artifact": #Script & {_script: "tools/workflows/website/verify-registry-cleanup-artifact.sh"}
	"website-record-artifact-identity": #Script & {_script: "tools/workflows/website/record-artifact-identity.sh"}
	"website-resolve-guest-tools-pin": #Script & {_script: "tools/workflows/website/resolve-guest-tools-pin.sh", _production: true}
	"website-activate-upload-admission": #Script & {_script: "tools/workflows/website/activate-upload-admission.sh", _production: true}
	"website-verify-deploy-revision": #Script & {_script: "tools/workflows/website/verify-deploy-revision.sh"}
	"website-download-tested-artifact": #Script & {_script: "tools/workflows/website/download-tested-artifact.sh"}
	"website-pin-production-config": #Script & {_script: "tools/workflows/website/pin-production-config.sh"}
	"website-inject-guest-tools-pin": #Script & {_script: "tools/workflows/website/inject-guest-tools-pin.sh"}
	"website-prepare-runtime-secrets": #Script & {_script: "tools/workflows/website/prepare-runtime-secrets.sh", _production: true}
	"website-plan-d1-migrations": #Script & {_script: "tools/workflows/website/plan-d1-migrations.sh", _production: true}
	"website-capture-pre-migration-d1-evidence": #Script & {_script: "tools/workflows/website/capture-pre-migration-d1-evidence.sh", _production: true}
	"website-inspect-registry-cleanup": #Script & {_script: "tools/workflows/website/inspect-registry-cleanup.sh", _production: true}
	"website-prepare-bootstrap-config": #Script & {_script: "tools/workflows/website/prepare-bootstrap-config.sh"}
	"website-prepare-maintenance-config": #Script & {_script: "tools/workflows/website/prepare-maintenance-config.sh"}
	"website-hold-registry-collector": #Script & {_script: "tools/workflows/website/hold-registry-collector.sh", _production: true}
	"website-drain-maintenance": #Script & {_script: "tools/workflows/website/drain-maintenance.sh", _production: true}
	"website-deploy-bootstrap-parent": #Script & {_script: "tools/workflows/website/deploy-bootstrap-parent.sh", _production: true}
	"website-apply-d1-migrations": #Script & {_script: "tools/workflows/website/apply-d1-migrations.sh", _production: true}
	"website-verify-d1-schema": #Script & {_script: "tools/workflows/website/verify-d1-schema.sh", _production: true}
	"website-verify-deployed-registry-cleanup": #Script & {_script: "tools/workflows/website/verify-deployed-registry-cleanup.sh", _production: true}
	"website-deploy-registry-cleanup": #Script & {_script: "tools/workflows/website/deploy-registry-cleanup.sh", _production: true}
	"website-release-registry-collector": #Script & {_script: "tools/workflows/website/release-registry-collector.sh", _production: true}
	"website-verify-report-only-collector": #Script & {_script: "tools/workflows/website/verify-report-only-collector.sh", _production: true}
	"website-run-registry-cleanup": #Script & {_script: "tools/workflows/website/run-registry-cleanup.sh", _production: true}
}
