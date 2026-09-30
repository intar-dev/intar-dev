// The workflow step tasks, a project of their own so the root `cuenv task`
// lists only developer tasks. A step runs `cuenv task -p ci --package ci
// <name>`, and each task still runs from the repository root (see #Script in
// ci/workflows/tasks.cue).
//
// The package is not cuenv. CUE unifies the root env.cue into a package cuenv
// directory below it, which merges the two projects, and a second package
// cuenv project also makes `cuenv sync ci` drop the intar-* lanes' paths.
package ci

import (
	"github.com/cuenv/cuenv/schema"
	"github.com/intar-dev/intar-dev/ci/workflows"
)

schema.#Project & {
	name:  "intar-ci"
	tasks: workflows.tasks
}
