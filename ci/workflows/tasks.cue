package workflows

import "github.com/cuenv/cuenv/schema"

// The run steps of the workflows in this package, as cuenv tasks named
// <workflow>-<step>. env.cue merges them into the project, and each step runs
// `cuenv task <name>` with the environment GitHub gives it.
tasks: [string]: schema.#Task

// One step body in tools/workflows/<workflow>/<step>.sh. It runs from the
// repository root with the step's whole environment, as bash with errexit
// only, the shell GitHub uses for a run step without `shell:`.
//
// cuenv sets CLICOLOR_FORCE and FORCE_COLOR for its tasks, which make `gh api`
// write coloured JSON even into a pipe or a file. A step reads that JSON with
// jq, so both are removed.
//
// A production step also refuses to start outside GitHub Actions, so a local
// `cuenv task` cannot reach production with a developer's credentials.
#Script: schema.#Task & {
	_script:     string
	_production: *false | bool
	hermetic:    false
	dir: from: "module"
	command: "env"
	if !_production {args: ["-u", "CLICOLOR_FORCE", "-u", "FORCE_COLOR", "bash", "-e", _script]}
	if _production {args: ["-u", "CLICOLOR_FORCE", "-u", "FORCE_COLOR", "bash", "-e", "-c", """
		if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
		  echo "$0 changes production and runs only in GitHub Actions." >&2
		  exit 1
		fi
		. "$0"
		""", _script]}
}
