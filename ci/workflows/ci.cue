package workflows

import (
	"list"

	"github.com/intar-dev/intar-dev/ci/gha"
)

// One CI workflow for pull requests and main. `changes` picks the lanes a
// pull request needs (lanes.cue), every lane runs on a push to main or a
// dispatch, and ci-ok is the one required check: it always runs, fails when
// any job failed or was cancelled, and counts a skipped job as passed. On main,
// a lane with a dist uploads the build it checked, and deploy.yml deploys it.
//
// No paths filter, so every pull request reports ci-ok. Editing the title or
// description re-runs every job, not only pr-title: a skipped job counts as
// passed, so a run that checked only the title would report a ci-ok that never
// saw the lanes.
"workflows": ci: {
	name: "CI"
	on: {
		pull_request: types: ["opened", "edited", "synchronize", "reopened"]
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
				let _artifact = "\(name)-dist-${{ github.sha }}"
				steps: list.Concat([laneSteps[name], [if lane.dist != _|_ {
					name: "Upload the tested build"
					if:   "github.ref == 'refs/heads/main'"
					uses: gha.pin."upload-artifact".ref
					with: {
						name:                   _artifact
						path:                   lane.dist.path
						"include-hidden-files": lane.dist.hidden
						// A re-run of the job replaces it.
						overwrite:           true
						"if-no-files-found": "error"
						// Long enough for a dispatch of deploy.yml to find it.
						"retention-days": 14
					}
				}]])
			}
		}

		"web-ui": chromiumSmoke & {
			needs:             "changes"
			if:                "needs.changes.outputs.web == 'true'"
			"timeout-minutes": 20
			permissions: contents: "read"
		}

		// The products this pull request would release: each whose version
		// differs from the base, or all of them when the release build changed.
		"release-plan": {
			name:              "release-plan"
			needs:             "changes"
			if:                "github.event_name == 'pull_request'"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 10
			permissions: contents: "read"
			outputs: matrix:       "${{ steps.plan.outputs.matrix }}"
			steps: [
				gha.#Checkout & {with: "fetch-depth": 2},
				gha.#SetupCuenv,
				{
					name: "Plan the release dry run"
					id:   "plan"
					env: BASE_SHA: "${{ needs.changes.outputs.base }}"
					#StepTask & {#task: "ci-release-plan"}
				},
			]
		}

		// release.yml's build, run on the pull request without publishing.
		"release-dry-run": #ReleaseBuild & {
			#plan:             "release-plan"
			#dryRun:           true
			name:              "Release dry run ${{ matrix.tag }}"
			"timeout-minutes": 45
		}

		// A squash merge commits the title (merge settings in ci/README.md), and
		// git-cliff versions the releases from those commits. The title reaches
		// the check only as data.
		"pr-title": {
			name:              "pr-title"
			if:                "github.event_name == 'pull_request'"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 5
			permissions: contents: "read"
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				gha.#Run & {
					name: "Check the pull request title"
					env: PR_TITLE: "${{ github.event.pull_request.title }}"
					#task: "pr-title"
				},
			]
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

tasks: {
	"ci-release-plan": #Script & {_script: "tools/workflows/ci/release-plan.sh"}
}

// deploy.yml and release.yml run after this workflow on main, and act only on a
// run that passed for a push or dispatch of main's tip. github.sha is main's tip
// when the run finished, so a run for an older commit is left to the run for
// the newer one. The event check refuses a fork's pull request from a branch
// named main, which triggers them too. A dispatch from main also passes.
afterCI: {
	on: workflow_run: {
		workflows: ["CI"]
		types: ["completed"]
		branches: ["main"]
	}
	if: """
		(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main') ||
		(github.event_name == 'workflow_run' &&
		github.event.workflow_run.conclusion == 'success' &&
		(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch') &&
		github.event.workflow_run.head_branch == 'main' &&
		github.event.workflow_run.head_repository.full_name == github.repository &&
		github.event.workflow_run.head_sha == github.sha)
		"""
}
