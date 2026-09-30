package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// One CI workflow for pull requests and main. `changes` picks the lanes a
// pull request needs (lanes.cue), every lane runs on a push to main or a
// dispatch, and ci-ok is the one required check: it always runs, fails when
// any job failed or was cancelled, and counts a skipped job as passed.
//
// No paths filter, so every pull request reports ci-ok.
"workflows": ci: {
	name: "CI"
	on: {
		pull_request: {}
		push: branches: ["main"]
		workflow_dispatch: {}
	}
	concurrency: gha.#PRConcurrency & {#name: "ci"}
	jobs: {
		changes: {
			name:              "changes"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 10
			permissions: contents: "read"
			outputs: {
				for name, _ in lanes {
					(name): "${{ steps.lanes.outputs.\(name) }}"
				}
				base: "${{ steps.lanes.outputs.base }}"
			}
			steps: [
				gha.#Checkout & {with: "fetch-depth": 2},
				gha.#SetupCuenv,
				gha.#Run & {
					name:  "Select the lanes"
					id:    "lanes"
					#task: "ci-changes"
				},
			]
		}

		for name, lane in lanes {
			(name): {
				"runs-on":         gha.runner
				needs:             "changes"
				if:                "needs.changes.outputs.\(name) == 'true'"
				"timeout-minutes": lane.timeout
				permissions: contents: "read"
				steps: laneSteps[name]
			}
		}

		"web-ui": chromiumSmoke & {
			needs:             "changes"
			if:                "needs.changes.outputs.web == 'true'"
			"timeout-minutes": 20
			permissions: contents: "read"
		}

		"ci-ok": {
			name: "ci-ok"
			if:   "always()"
			needs: [for job, _ in jobs if job != "ci-ok" {job}]
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 5
			permissions: {}
			// Inline: a checkout here would be one more way for the gate to fail.
			steps: [{
				name: "Require every job to pass or skip"
				env: NEEDS: "${{ toJSON(needs) }}"
				run: """
					jq -r 'to_entries[] | "\\(.key): \\(.value.result)"' <<<"${NEEDS}"
					jq -e '.changes.result == "success" and all(.[]; .result == "success" or .result == "skipped")' <<<"${NEEDS}" >/dev/null

					"""
			}]
		}
	}
}

// ci.yml runs pull request code, so it never grants a write permission and
// never sees a secret or the job token.
"workflows": ci: {
	permissions: [string]: "read" | "none"
	jobs: [string]: permissions?: [string]: "read" | "none"
}
files: ".github/workflows/ci.yml": !~"secrets\\.|github\\.token"
