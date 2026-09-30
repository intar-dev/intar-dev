package workflows

import (
	"encoding/yaml"
	"strings"

	"github.com/intar-dev/intar-dev/ci/gha"
)

// The GitHub Actions workflows cuenv's CI generator cannot express: deployment
// environments with URLs, non-cancelling concurrency, job outputs, always()
// cleanup and run-name. Each workflow is typed GitHub Actions data (see
// ci/gha) in its own file here, and `cuenv sync codegen` renders it to
// .github/workflows. The rendered files are checked for drift by
// `cuenv task sync-check`.
//
// scenario-publish.yml stays hand-written: callers pin it by tag, and its path
// is part of the OIDC allowlist in apps/web/src/lib/github-oidc.ts.
workflows: [Name=string]: gha.#Workflow

// The workflow policy requires each pin's tag as a comment, and YAML rendering
// drops comments, so the renderer writes it back from ci/gha/pins.cue.
let _pins = [for _, p in gha.pin {p}]

// One replacement per pin over the whole document, chained through _annotated.
// A per-line regexp pass doubled the cost of every cuenv invocation.
_annotated: {
	for name, workflow in workflows {
		(name): "0": yaml.Marshal(workflow)
		for i, p in _pins {
			(name): "\(i+1)": strings.Replace(_annotated[name]["\(i)"], "uses: \(p.ref)\n", "uses: \(p.ref) # \(p.tag)\n", -1)
		}
	}
}

// Rendered file content, keyed by path relative to the repository root.
files: {
	for name, _ in workflows {
		".github/workflows/\(name).yml": """
			# Generated from ci/workflows/\(name).cue by cuenv; do not edit manually.
			# Regenerate with: cuenv sync codegen
			\(_annotated[name]["\(len(_pins))"])
			"""
	}
}
