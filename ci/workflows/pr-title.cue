package workflows

import "github.com/intar-dev/intar-dev/ci/gha"

// Checks a pull request's title as it is opened, pushed, or edited, so editing
// the title or description re-runs only this, never ci.yml's lanes. It is not
// required: ci.yml's pr-title job checks the squash commit in the merge queue,
// which is what lands on main. The title reaches the check only as data.
"workflows": "pr-title": {
	name: "PR title"
	on: pull_request: types: ["opened", "edited", "synchronize", "reopened"]
	concurrency: gha.#PRConcurrency & {#name: "pr-title"}
	jobs: "pr-title": {
		name:              "pr-title"
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
}

// It runs pull request code, like ci.yml.
"workflows": "pr-title": permissions: [string]: "read" | "none"
files: ".github/workflows/pr-title.yml": !~"secrets\\.|github\\.token"
