package workflows

import (
	"list"
	"strings"

	"github.com/intar-dev/intar-dev/ci/gha"
)

// One CI workflow for pull requests and the merge queue. `changes` picks the
// lanes a pull request or merge group needs (lanes.cue), every lane runs on a
// dispatch, the security lane runs daily, and ci-ok is the one required check:
// it always runs, fails when any job failed or was cancelled, and counts a
// skipped job as passed.
//
// Main moves only through the merge queue, which fast-forwards it to the merge
// group's commit, so a push to main runs no CI: that commit already passed. A
// merge group, or a dispatch from main, uploads the build of each lane with a
// dist, and deploy.yml deploys it.
//
// No paths filter, so every pull request reports ci-ok. Editing the title or
// description runs nothing here: pr-title.yml checks the title on the pull
// request, and the merge group checks the commit that lands.
"workflows": ci: {
	name: "CI"
	on: {
		pull_request: types: ["opened", "synchronize", "reopened"]
		// The merge queue checks each pull request merged onto main's tip
		// before it lands (merge settings in ci/README.md).
		merge_group: types: ["checks_requested"]
		// The security lane's audits, daily (see changes).
		schedule: [{cron: "17 5 * * *"}]
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
				for name, lane in lanes {
					(name): "${{ \(strings.Join([
						"steps.lanes.outputs.\(name) == 'true'",
						// Every merge group builds what deploy.yml deploys. The queue
						// merges up to five groups at once and pushes only the last
						// one's commit, whose diff need not hold an earlier group's
						// change.
						if lane.dist != _|_ {"github.event_name == 'merge_group'"},
						// The daily run audits the dependencies, which no pull request
						// may touch for days, against newly published advisories.
						if name == "security" {"github.event_name == 'schedule'"},
					], " || ")) }}"
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
					// The merge group's commit becomes main's tip.
					if: "github.event_name == 'merge_group' || github.ref == 'refs/heads/main'"
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

		// The products this change would release: in the merge queue, each whose
		// version differs from the base; in the merge queue and on a pull
		// request, all of them when the release build changed.
		"release-plan": {
			name:              "release-plan"
			needs:             "changes"
			if:                "github.event_name == 'pull_request' || github.event_name == 'merge_group'"
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

		// release.yml's build, run without publishing.
		"release-dry-run": #ReleaseBuild & {
			#plan:             "release-plan"
			#dryRun:           true
			name:              "Release dry run ${{ matrix.tag }}"
			"timeout-minutes": 45
		}

		// A squash merge commits the title (merge settings in ci/README.md), and
		// git-cliff versions the releases from those commits. The merge group's
		// commit is that squash commit, so its subject is exactly what lands.
		"pr-title": {
			name:              "pr-title"
			if:                "github.event_name == 'merge_group'"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 5
			permissions: contents: "read"
			steps: [
				gha.#Checkout,
				gha.#SetupCuenv,
				gha.#Run & {
					name:  "Check the squash commit title"
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

// deploy.yml and release.yml act on main's tip once CI passed for it.
//
// A push to main is the merge queue landing a merge group whose CI run passed
// for that same commit: the ruleset lets nothing else push. They take that run
// by the commit, not on its workflow_run, which completes before the queue
// moves main and so would still see the old tip as github.sha.
//
// A CI run dispatched from main passes when it succeeded for the commit that
// is still main's tip; a run for an older commit is left to the run for the
// newer one. The event check refuses a fork's pull request from a branch named
// main, which triggers them too. A dispatch from main also passes.
afterCI: {
	on: {
		push: branches: ["main"]
		workflow_run: {
			workflows: ["CI"]
			types: ["completed"]
			branches: ["main"]
		}
	}
	if: """
		((github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main') ||
		(github.event_name == 'workflow_run' &&
		github.event.workflow_run.conclusion == 'success' &&
		github.event.workflow_run.event == 'workflow_dispatch' &&
		github.event.workflow_run.head_branch == 'main' &&
		github.event.workflow_run.head_repository.full_name == github.repository &&
		github.event.workflow_run.head_sha == github.sha)
		"""
}
