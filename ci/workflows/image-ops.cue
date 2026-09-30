package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": "image-ops": {
	name:       "Image operations"
	"run-name": "Image ops ${{ inputs.operation }} @ ${{ github.sha }}"

	// One operator lane for the image flywheel work that stays manual: the run
	// gate, the guest-tools build and promotion, and the registry cleanup. Intar
	// promotes image catalogs itself (Admin, Scenarios, Image promotion), also
	// inside a drain this lane holds. Each operation keeps its own inputs and its
	// own job, so the plane fence and the deliberate-release property stay
	// explicit; the production environment admits only main. Three lock groups keep unrelated work from blocking
	// recovery: the image pipeline group, the cleanup campaign group, and the
	// cleanup status group, which must stay readable while a campaign holds the
	// other two.
	on: {
		workflow_dispatch: inputs: {
			operation: {
				description: "which operation to run"
				required:    true
				type:        "choice"
				options: [
					"gate-open",
					"gate-drained",
					"tools-build",
					"tools-promote",
					"cleanup-status",
					"cleanup-plan",
					"cleanup-run",
					"cleanup-resolve",
				]
			}
			revision: {
				description: "verified candidate bundle revision, for a tools promotion"
				required:    false
				default:     ""
				type:        "string"
			}
			kino_tag: {
				description: "published Kino release tag, for a tools build"
				required:    false
				default:     ""
				type:        "string"
			}
			expected_candidate_sha256: {
				description: "SHA-256 of the candidate the release pinned, for a tools promotion"
				required:    false
				default:     ""
				type:        "string"
			}
			expected_gc_run_id: {
				description: "the stalled sweep to abort, for a cleanup resolve"
				required:    false
				default:     ""
				type:        "string"
			}
		}
	}
	permissions: {
		actions:  "read"
		contents: "read"
	}
	jobs: {
		request: {
			name:              "Validate the operation"
			"runs-on":         "namespace-profile-intar-dev"
			"timeout-minutes": 5
			outputs: {
				operation: "${{ steps.validate.outputs.operation }}"
				job:       "${{ steps.validate.outputs.job }}"
				state:     "${{ steps.validate.outputs.state }}"
				action:    "${{ steps.validate.outputs.action }}"
			}
			steps: [{
				name: "Validate the operation"
				id:   "validate"
				env: {
					OPERATION:                 "${{ inputs.operation }}"
					REVISION:                  "${{ inputs.revision }}"
					KINO_TAG:                  "${{ inputs.kino_tag }}"
					EXPECTED_CANDIDATE_SHA256: "${{ inputs.expected_candidate_sha256 }}"
				}
				run: """
					set -euo pipefail
					test "${GITHUB_REF}" = refs/heads/main
					job=""
					state=""
					action=""
					case "${OPERATION}" in
					  gate-open)
					    job=gate
					    state=open
					    ;;
					  gate-drained)
					    job=gate
					    state=drained
					    ;;
					  tools-build)
					    job=tools-build
					    [[ "${KINO_TAG}" =~ ^kino/v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]
					    ;;
					  tools-promote)
					    job=tools-promote
					    [[ "${REVISION}" =~ ^[A-Za-z0-9._-]+$ ]]
					    [[ "${EXPECTED_CANDIDATE_SHA256}" =~ ^[0-9a-f]{64}$ ]]
					    ;;
					  cleanup-status)
					    job=cleanup
					    action=status
					    ;;
					  cleanup-plan)
					    job=cleanup
					    action=plan
					    ;;
					  cleanup-run)
					    job=cleanup
					    action=run
					    ;;
					  cleanup-resolve)
					    job=cleanup
					    action=resolve
					    ;;
					  *)
					    echo "unsupported operation: ${OPERATION}" >&2
					    echo 'Use gate-open, gate-drained, tools-build, tools-promote, cleanup-status, cleanup-plan, cleanup-run, or cleanup-resolve.' >&2
					    exit 1
					    ;;
					esac
					{
					  printf 'operation=%s\\n' "${OPERATION}"
					  printf 'job=%s\\n' "${job}"
					  printf 'state=%s\\n' "${state}"
					  printf 'action=%s\\n' "${action}"
					} >> "${GITHUB_OUTPUT}"
					printf 'operation=%s job=%s\\n' "${OPERATION}" "${job}" >> "${GITHUB_STEP_SUMMARY}"

					"""
			}]
		}
		gate: {
			name:      "Set and verify production run gate"
			"runs-on": "namespace-profile-intar-dev"
			needs: ["request"]
			if: "needs.request.outputs.job == 'gate'"
			concurrency: {
				group:                "intar-image-catalog-promotion"
				"cancel-in-progress": false
			}
			// The gate polls until the registry reports drained with zero desired VMs,
			// which can take several minutes.
			"timeout-minutes": 20
			environment:       "production"
			env: {
				INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				STATE:                     "${{ needs.request.outputs.state }}"
			}
			steps: [{
				name: "Validate authority"
				run: """
					set -euo pipefail
					test "${GITHUB_REF}" = "refs/heads/main"
					test -n "${INTAR_IMAGE_PUBLISH_TOKEN}"
					case "${STATE}" in
					  drained|open) ;;
					  *) echo "Unsupported run gate state." >&2; exit 1 ;;
					esac

					"""
			}, {
				name: "Set exact gate state"
				run: """
					set -euo pipefail
					curl --fail --silent --show-error --retry 3 \\
					  --request POST \\
					  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \\
					  --header "Content-Type: application/json" \\
					  --data "{\\"state\\":\\"${STATE}\\"}" \\
					  "https://intar.dev/registry/v1/cutover/gate" \\
					  | jq -e --arg state "${STATE}" '.ok == true and .state == $state' >/dev/null

					"""
			}, {
				name: "Verify drained state has no active desired VMs"
				if:   "needs.request.outputs.state == 'drained'"
				run: """
					set -euo pipefail
					status="${RUNNER_TEMP}/image-gate.json"
					for _ in $(seq 1 120); do
					  curl --fail --silent --show-error --retry 2 \\
					    --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \\
					    "https://intar.dev/registry/v1/cutover/gate" > "${status}"
					  if jq -e '.state == "drained" and .active_desired_vms == 0' \\
					    "${status}" >/dev/null; then
					    jq -c '{state, active_desired_vms}' "${status}"
					    exit 0
					  fi
					  sleep 5
					done
					echo "Agent-KVM runs did not drain within ten minutes." >&2
					exit 1

					"""
			}, {
				name: "Verify open state"
				if:   "needs.request.outputs.state == 'open'"
				run: """
					set -euo pipefail
					curl --fail --silent --show-error --retry 3 \\
					  --header "Authorization: Bearer ${INTAR_IMAGE_PUBLISH_TOKEN}" \\
					  "https://intar.dev/registry/v1/cutover/gate" \\
					  | jq -e '.state == "open"' >/dev/null

					"""
			}]
		}
		"tools-build": {
			name:      "Build and verify tools"
			"runs-on": "namespace-profile-intar-dev"
			needs: ["request"]
			if: "needs.request.outputs.job == 'tools-build'"
			concurrency: {
				group:                "intar-image-catalog-promotion"
				"cancel-in-progress": false
			}
			"timeout-minutes": 30
			environment:       "production"
			env: {
				KINO_TAG: "${{ inputs.kino_tag }}"
				BUCKET:   "intar-dev-vm-image-registry-20260709"
			}
			steps: [{
				name: "Validate deployment inputs"
				run: """
					set -euo pipefail
					test "${GITHUB_REF}" = refs/heads/main
					[[ "${KINO_TAG}" =~ ^kino/v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]
					mkdir -p "${RUNNER_TEMP}/guest-tools"
					printf 'TOOLS_DIR=%s/guest-tools\\n' "${RUNNER_TEMP}" >> "${GITHUB_ENV}"

					"""
			}, {
				name: "Checkout deployment revision"
				uses: gha.pin.checkout.ref
				with: {
					ref:                   "${{ github.sha }}"
					"fetch-depth":         0
					"persist-credentials": false
				}
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				// Stays inline: cuenv task sets CLICOLOR_FORCE=1 when it is unset, and gh
				// then colours its --json output, which jq can not parse.
				name: "Verify published Kino source"
				env: GH_TOKEN: "${{ github.token }}"
				#StepTask & {#task: "image-ops-verify-kino-source"}
			}, gha.#SetupRust, {
				name: "Verify runner disk tools"
				#StepTask & {#task: "image-ops-verify-runner-disk-tools"}
			}, {
				name: "Prepare Kino source workspace"
				#StepTask & {#task: "image-ops-prepare-kino-source"}
			}, {
				name: "Build guest Kino and tools disk"
				#StepTask & {#task: "image-ops-build-guest-tools"}
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Install pinned Wrangler"
				run:  "bun install --frozen-lockfile"
			}, {
				name:                "Upload candidate objects"
				"working-directory": "."
				env: {
					CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				}
				#StepTask & {#task: "image-ops-upload-tools-candidate"}
			}, {
				name:                "Verify uploaded objects by re-download"
				"working-directory": "."
				env: {
					CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				}
				#StepTask & {#task: "image-ops-verify-tools-upload"}
			}, {
				name: "Retain build and deployment evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                "guest-tools-deployment-${{ github.run_id }}"
					path:                "${{ runner.temp }}/guest-tools/"
					"if-no-files-found": "error"
				}
			}]
		}
		"tools-promote": {
			name:      "Promote and verify the tools channel"
			"runs-on": "namespace-profile-intar-dev"
			needs: ["request"]
			if: "needs.request.outputs.job == 'tools-promote'"
			concurrency: {
				group:                "intar-image-catalog-promotion"
				"cancel-in-progress": false
			}
			"timeout-minutes": 30
			environment:       "production"
			env: {
				REVISION:                  "${{ inputs.revision }}"
				EXPECTED_CANDIDATE_SHA256: "${{ inputs.expected_candidate_sha256 }}"
				BUCKET:                    "intar-dev-vm-image-registry-20260709"
			}
			steps: [{
				name: "Validate promotion inputs"
				run: """
					set -euo pipefail
					test "${GITHUB_REF}" = refs/heads/main
					[[ "${REVISION}" =~ ^[A-Za-z0-9._-]{1,128}$ ]]
					[[ "${EXPECTED_CANDIDATE_SHA256}" =~ ^[0-9a-f]{64}$ ]]
					mkdir -p "${RUNNER_TEMP}/guest-tools"
					printf 'TOOLS_DIR=%s/guest-tools\\n' "${RUNNER_TEMP}" >> "${GITHUB_ENV}"

					"""
			}, {
				name: "Checkout promotion revision"
				uses: gha.pin.checkout.ref
				with: {
					ref:                   "${{ github.sha }}"
					"persist-credentials": false
				}
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Set up the CI runtime"
				uses: "./.github/actions/setup-runtime"
			}, {
				name: "Install pinned Wrangler"
				run:  "bun install --frozen-lockfile"
			}, {
				name:                "Read the candidate pin from the registry bucket"
				"working-directory": "."
				env: {
					CLOUDFLARE_ACCOUNT_ID: "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:  "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				}
				#StepTask & {#task: "image-ops-read-tools-candidate"}
			}, {
				name:                "Require drained host and retain previous stable pin"
				"working-directory": "."
				env: {
					CLOUDFLARE_ACCOUNT_ID:     "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
					CLOUDFLARE_API_TOKEN:      "${{ secrets.CLOUDFLARE_API_TOKEN }}"
					INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				}
				#StepTask & {#task: "image-ops-require-drain-retain-stable"}
			}, {
				name: "Retain rollback pin before promotion"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                "guest-tools-rollback-${{ github.run_id }}"
					path:                "${{ runner.temp }}/guest-tools/previous-stable.json"
					"if-no-files-found": "error"
				}
			}, {
				name: "Warm every host and wait for the candidate cache"
				env: INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				#StepTask & {#task: "image-ops-warm-tools-candidate"}
			}, {
				name: "Promote the exact candidate while drained"
				env: INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				#StepTask & {#task: "image-ops-promote-tools-candidate"}
			}, {
				name: "Retain promotion evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name:                "guest-tools-promotion-${{ github.run_id }}"
					path:                "${{ runner.temp }}/guest-tools/"
					"if-no-files-found": "error"
				}
			}]
		}
		cleanup: {
			name:      "Image registry cleanup"
			"runs-on": "namespace-profile-intar-dev"
			needs: ["request"]
			if:                "needs.request.outputs.job == 'cleanup'"
			"timeout-minutes": 75
			// The status and resolve paths are read-only and must stay reachable
			// while a campaign holds the other cleanup group.
			concurrency: {
				group:                "${{ needs.request.outputs.action == 'status' && 'intar-image-registry-cleanup-status' || 'intar-image-registry-cleanup' }}"
				"cancel-in-progress": false
			}
			environment: name: "production"
			// The run action campaigns for up to 60 minutes
			// (REGISTRY_CLEANUP_RUN_DEADLINE_MS), so the job allows 75.
			env: {
				CLOUDFLARE_ACCOUNT_ID:                   "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}"
				CLOUDFLARE_API_TOKEN:                    "${{ secrets.CLOUDFLARE_API_TOKEN }}"
				CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET: "${{ secrets.CONTROL_PLANE_MAINTENANCE_BYPASS_SECRET }}"
				// The parent control-plane database, the same one the deploy lane pins.
				DATABASE_ID:        "c53ff120-c555-4702-b3a1-eaab44fd76f6"
				GATE_URL:           "https://intar.dev/api/maintenance/registry-cleanup"
				ACTION:             "${{ needs.request.outputs.action }}"
				EXPECTED_GC_RUN_ID: "${{ inputs.expected_gc_run_id }}"
			}
			steps: [{
				name: "Checkout exact main revision"
				uses: gha.pin.checkout.ref
				with: "persist-credentials": false
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Set up Bun"
				// status and resolve are curl and jq only, so they stay fast. plan and run
				// delegate to the gate script, which resolves wrangler through the locked
				// dependency tree; without the locked install `bunx` may fetch a latest.
				if:   "needs.request.outputs.action == 'plan' || needs.request.outputs.action == 'run'"
				uses: gha.pin."setup-bun".ref
				with: "bun-version": "1.3.14"
			}, {
				name: "Set up Node"
				if:   "needs.request.outputs.action == 'plan' || needs.request.outputs.action == 'run'"
				uses: gha.pin."setup-node".ref
				with: "node-version-file": "apps/web/.node-version"
			}, {
				name: "Install locked dependencies"
				if:   "needs.request.outputs.action == 'plan' || needs.request.outputs.action == 'run'"
				run:  "bun install --frozen-lockfile"
			}, {
				name: "Validate cleanup authority"
				#StepTask & {#task: "image-ops-validate-cleanup-authority"}
			}, {
				name: "Read the collector status and the shared ledger"
				#StepTask & {#task: "image-ops-read-cleanup-state"}
			}, {
				name: "List the candidate set"
				if:   "needs.request.outputs.action == 'plan'"
				#StepTask & {#task: "image-ops-plan-cleanup"}
			}, {
				name: "Run the delete campaign"
				if:   "needs.request.outputs.action == 'run'"
				env: {
					// A full plan takes roughly 90 seconds plus its post-scan, so the
					// script's 15-minute manual default can not finish a large backlog.
					// CI gets 60 minutes here, inside the job's 75.
					REGISTRY_CLEANUP_RUN_DEADLINE_MS: "3600000"
				}
				#StepTask & {#task: "image-ops-run-cleanup"}
			}, {
				name: "Resolve one stalled sweep"
				if:   "needs.request.outputs.action == 'resolve'"
				env: {
					INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
					REAP_URL:                  "https://intar.dev/registry/v1/admission/reap"
					// The same threshold the call is made with, so the local precondition
					// and the service's grace window can not disagree.
					STALE_MS: "600000"
				}
				#StepTask & {#task: "image-ops-resolve-stalled-sweep"}
			}, {
				name: "Remove any response that reflected the machine credential"
				if:   "always()"
				env: {
					// The scrub compares both credentials, and keeps neither.
					INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				}
				#StepTask & {#task: "image-ops-scrub-cleanup-evidence"}
			}, {
				name: "Retain cleanup evidence"
				if:   "always()"
				uses: gha.pin."upload-artifact".ref
				with: {
					name: "image-registry-cleanup-${{ needs.request.outputs.action }}-${{ github.run_id }}"
					path: """
						${{ runner.temp }}/intar-image-registry-cleanup/state.json
						${{ runner.temp }}/intar-image-registry-cleanup/state-summary.jsonl
						${{ runner.temp }}/intar-image-registry-cleanup/collector-status.json
						${{ runner.temp }}/intar-image-registry-cleanup/d1-admission.json
						${{ runner.temp }}/intar-image-registry-cleanup/d1-gc-runs.json
						${{ runner.temp }}/intar-image-registry-cleanup/d1-counts.json
						${{ runner.temp }}/intar-image-registry-cleanup/registry-cleanup-plan.json
						${{ runner.temp }}/intar-image-registry-cleanup/registry-cleanup-run.json
						${{ runner.temp }}/intar-image-registry-cleanup/stalled-sweep-resolution.json
						${{ runner.temp }}/intar-image-registry-cleanup/stalled-sweep-post-state.json
						${{ runner.temp }}/intar-image-registry-cleanup/stalled-sweep-post-request.json
						${{ runner.temp }}/intar-registry-cleanup-gate-${{ github.run_id }}/

						"""
					"if-no-files-found": "warn"
					"retention-days":    30
				}
			}]
		}
	}
}

// The run steps above, one script each in tools/workflows/image-ops. A task
// that authenticates to production or changes anything outside the runner is
// _production; the authority check and the evidence scrub touch only the runner.
tasks: {
	"image-ops-verify-runner-disk-tools": #Script & {_script: "tools/workflows/image-ops/verify-runner-disk-tools.sh"}
	"image-ops-verify-kino-source": #Script & {_script: "tools/workflows/image-ops/verify-kino-source.sh"}
	"image-ops-prepare-kino-source": #Script & {_script: "tools/workflows/image-ops/prepare-kino-source.sh"}
	"image-ops-build-guest-tools": #Script & {_script: "tools/workflows/image-ops/build-guest-tools.sh"}
	"image-ops-upload-tools-candidate": #Script & {_script: "tools/workflows/image-ops/upload-tools-candidate.sh", _production: true}
	"image-ops-verify-tools-upload": #Script & {_script: "tools/workflows/image-ops/verify-tools-upload.sh", _production: true}
	"image-ops-read-tools-candidate": #Script & {_script: "tools/workflows/image-ops/read-tools-candidate.sh", _production: true}
	"image-ops-require-drain-retain-stable": #Script & {_script: "tools/workflows/image-ops/require-drain-retain-stable.sh", _production: true}
	"image-ops-warm-tools-candidate": #Script & {_script: "tools/workflows/image-ops/warm-tools-candidate.sh", _production: true}
	"image-ops-promote-tools-candidate": #Script & {_script: "tools/workflows/image-ops/promote-tools-candidate.sh", _production: true}
	"image-ops-validate-cleanup-authority": #Script & {_script: "tools/workflows/image-ops/validate-cleanup-authority.sh"}
	"image-ops-read-cleanup-state": #Script & {_script: "tools/workflows/image-ops/read-cleanup-state.sh", _production: true}
	"image-ops-plan-cleanup": #Script & {_script: "tools/workflows/image-ops/plan-cleanup.sh", _production: true}
	"image-ops-run-cleanup": #Script & {_script: "tools/workflows/image-ops/run-cleanup.sh", _production: true}
	"image-ops-resolve-stalled-sweep": #Script & {_script: "tools/workflows/image-ops/resolve-stalled-sweep.sh", _production: true}
	"image-ops-scrub-cleanup-evidence": #Script & {_script: "tools/workflows/image-ops/scrub-cleanup-evidence.sh"}
}
