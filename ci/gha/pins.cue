package gha

// Every external action the rendered workflows use, pinned to a commit. #Uses
// accepts only these refs and the local actions, and the renderer writes each
// tag back as the version comment the workflow policy requires.
//
// Dependabot skips the rendered workflows, so each pin must also sit in a file
// it scans (a composite action or .github/actions/workflow-pins). When it bumps
// one there, update the sha and tag here in the same pull request and run
// `cuenv sync codegen`.
pin: [string]: {
	repo!: string
	sha!:  =~"^[0-9a-f]{40}$"
	tag!:  =~"^v[0-9][0-9A-Za-z._-]*$"
	ref:   "\(repo)@\(sha)"
}

pin: {
	checkout: {repo: "actions/checkout", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", tag: "v7"}
	"download-artifact": {repo: "actions/download-artifact", sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c", tag: "v8"}
	"setup-node": {repo: "actions/setup-node", sha: "820762786026740c76f36085b0efc47a31fe5020", tag: "v7"}
	"upload-artifact": {repo: "actions/upload-artifact", sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a", tag: "v7"}
	"nscloud-cache": {repo: "namespacelabs/nscloud-cache-action", sha: "1124a6f3ce44e5cf84cc22111530961f4d2a15f9", tag: "v1"}
	"nscloud-checkout": {repo: "namespacelabs/nscloud-checkout-action", sha: "66f2dc6f6c42a8ac6c4e53473c4840006822831e", tag: "v9"}
	"setup-bun": {repo: "oven-sh/setup-bun", sha: "0c5077e51419868618aeaa5fe8019c62421857d6", tag: "v2"}
}
