package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

"workflows": "image-ops": {
	name:       "Image operations"
	"run-name": "Image ops ${{ inputs.operation }} @ ${{ github.sha }}"

	// One operator lane for the registry work that stays manual: the run gate,
	// storing a Kino release, and the registry cleanup. Intar promotes scenario
	// revisions itself. Each operation keeps its own inputs and its own job, so
	// the plane fence and the deliberate-release property stay explicit; the
	// production environment admits only main. Three lock groups keep unrelated
	// work from blocking recovery: the gate and Kino group, the cleanup campaign
	// group, and the cleanup status group, which must stay readable while a
	// campaign holds the other two.
	on: {
		workflow_dispatch: inputs: {
			operation: {
				description: "which operation to run"
				required:    true
				type:        "choice"
				options: [
					"gate-open",
					"gate-drained",
					"kino-promote",
					"cleanup-status",
					"cleanup-plan",
					"cleanup-run",
					"cleanup-resolve",
				]
			}
			kino_version: {
				description: "the published kino release to store, X.Y.Z, for a kino promote"
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
				env: OPERATION: "${{ inputs.operation }}"
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
					  kino-promote)
					    job=kino
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
					    echo 'Use gate-open, gate-drained, kino-promote, cleanup-status, cleanup-plan, cleanup-run, or cleanup-resolve.' >&2
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
		kino: {
			name:      "Store a Kino release in the registry"
			"runs-on": "namespace-profile-intar-dev"
			needs: ["request"]
			if: "needs.request.outputs.job == 'kino'"
			concurrency: {
				group:                "intar-image-catalog-promotion"
				"cancel-in-progress": false
			}
			"timeout-minutes": 15
			environment:       "production"
			// gh reads the release and verifies its attestation.
			permissions: {
				attestations: "read"
				contents:     "read"
			}
			env: {
				GH_TOKEN:                  "${{ github.token }}"
				INTAR_IMAGE_PUBLISH_TOKEN: "${{ secrets.INTAR_IMAGE_PUBLISH_TOKEN }}"
				KINO_VERSION:              "${{ inputs.kino_version }}"
				REGISTRY_URL:              "https://intar.dev/registry/v1"
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
				uses: gha.pin."setup-bun".ref
				with: "bun-version": "1.4.4"
			}, {
				name: "Push the Kino artifact"
				#StepTask & {#task: "image-ops-kino-promote"}
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
				with: "bun-version": "1.4.4"
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
	"image-ops-kino-promote": #Script & {_script: "tools/workflows/image-ops/kino-promote.sh", _production: true}
	"image-ops-validate-cleanup-authority": #Script & {_script: "tools/workflows/image-ops/validate-cleanup-authority.sh"}
	"image-ops-read-cleanup-state": #Script & {_script: "tools/workflows/image-ops/read-cleanup-state.sh", _production: true}
	"image-ops-plan-cleanup": #Script & {_script: "tools/workflows/image-ops/plan-cleanup.sh", _production: true}
	"image-ops-run-cleanup": #Script & {_script: "tools/workflows/image-ops/run-cleanup.sh", _production: true}
	"image-ops-resolve-stalled-sweep": #Script & {_script: "tools/workflows/image-ops/resolve-stalled-sweep.sh", _production: true}
	"image-ops-scrub-cleanup-evidence": #Script & {_script: "tools/workflows/image-ops/scrub-cleanup-evidence.sh"}
}
