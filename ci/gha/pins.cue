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
	attest: {repo: "actions/attest", sha: "1e69f48acb82d1966a394da916b4c1698aa569d6", tag: "v4.2.2"}
	checkout: {repo: "actions/checkout", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", tag: "v7"}
	"create-github-app-token": {repo: "actions/create-github-app-token", sha: "64ab729a6294000f5aa4a4bc0b73d1f32bc45510", tag: "v3.3.0"}
	"download-artifact": {repo: "actions/download-artifact", sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", tag: "v8"}
	"setup-node": {repo: "actions/setup-node", sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", tag: "v7"}
	"upload-artifact": {repo: "actions/upload-artifact", sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", tag: "v7"}
	"nscloud-cache": {repo: "namespacelabs/nscloud-cache-action", sha: "1124a6f3ce44e5cf84cc22111530961f4d2a15f9", tag: "v1"}
	"nscloud-checkout": {repo: "namespacelabs/nscloud-checkout-action", sha: "66f2dc6f6c42a8ac6c4e53473c4840006822831e", tag: "v9"}
	"setup-bun": {repo: "oven-sh/setup-bun", sha: "0c5077e51419868618aeaa5fe8019c62421857d6", tag: "v2"}
	// The same revision setup-rust installs its Cargo tools with.
	"install-action": {repo: "taiki-e/install-action", sha: "a4d3f3f761dcd95cce1b72cb61cb6d1963438177", tag: "v2"}
}
