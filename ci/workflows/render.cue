package workflows

import (
	"encoding/yaml"
	"strings"
)

// The GitHub Actions workflows cuenv's CI generator cannot express: deployment
// environments with URLs, non-cancelling concurrency, job outputs, always()
// cleanup and run-name. Each workflow is plain GitHub Actions data in its own
// file here, and `cuenv sync codegen` renders it to .github/workflows. The
// rendered files are checked for drift by `cuenv task sync-check`.
//
// scenario-publish.yml stays hand-written: callers pin it by tag, and its path
// is part of the OIDC allowlist in apps/web/src/lib/github-oidc.ts.
workflows: [Name=string]: {...}

// Every external action pin and its release tag. The workflow policy requires
// the tag as a comment on each pin, and YAML rendering drops comments, so the
// renderer writes it back from here. A pin missing from this table renders
// without its tag and fails `bun tools/ci/check-workflow-security.ts`.
pins: [string]: string
pins: {
	"actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1":                      "v7"
	"actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c":             "v8"
	"actions/setup-node@820762786026740c76f36085b0efc47a31fe5020":                    "v7"
	"actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a":               "v7"
	"mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29":                       "v2"
	"namespacelabs/nscloud-cache-action@1124a6f3ce44e5cf84cc22111530961f4d2a15f9":    "v1"
	"namespacelabs/nscloud-checkout-action@66f2dc6f6c42a8ac6c4e53473c4840006822831e": "v9"
	"oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6":                     "v2"
	"taiki-e/install-action@4cef1412cce204788f482e778a0b9187f9626a29":                "v2"
}

let _refs = [for ref, _ in pins {ref}]

// One replacement per pin over the whole document, chained through _annotated.
// A per-line regexp pass doubled the cost of every cuenv invocation.
_annotated: {
	for name, workflow in workflows {
		(name): "0": yaml.Marshal(workflow)
		for i, ref in _refs {
			(name): "\(i+1)": strings.Replace(_annotated[name]["\(i)"], "uses: \(ref)\n", "uses: \(ref) # \(pins[ref])\n", -1)
		}
	}
}

// Rendered file content, keyed by path relative to the repository root.
files: {
	for name, _ in workflows {
		".github/workflows/\(name).yml": """
			# Generated from ci/workflows/\(name).cue by cuenv; do not edit manually.
			# Regenerate with: cuenv sync codegen
			\(_annotated[name]["\(len(_refs))"])
			"""
	}
}
