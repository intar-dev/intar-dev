package gha

// Typed GitHub Actions workflows. The definitions are closed, so a misspelt key
// fails `cuenv sync codegen` instead of rendering a workflow GitHub ignores or
// rejects. They cover the keys the rendered workflows use; add one here when a
// workflow needs it.
//
// Helper parameters are #definition fields: a hidden _field set in another
// package is a different field, so it would be silently ignored. Closedness
// does not check #fields either, so a parameter that changes the output has no
// default: a misspelt one leaves it unset and fails evaluation.

runner: "namespace-profile-intar-dev"

#Workflow: {
	name!:       string
	"run-name"?: string
	on!:         #On
	permissions: *{} | #Permissions
	concurrency?: #Concurrency
	env?:         #Env
	defaults?:    #Defaults
	jobs!: [=~"^[a-z][a-z0-9-]*$"]: #Job
}

#On: {
	workflow_dispatch?: inputs?: [=~"^[a-z][a-z0-9_]*$"]: #Input
	push?: {
		branches?: [...string]
		tags?: [...string]
		paths?: [...string]
	}
	pull_request?: {
		branches?: [...string]
		paths?: [...string]
		types?: [...string]
	}
	schedule?: [...{cron!: string}]
}

#Input: {
	description!: string
	required?:    bool
	default?:     string | bool
	type!:        "string" | "choice" | "boolean"
	options?: [...string]
}

#P: "read" | "write" | "none"

#Permissions: {
	actions?:             #P
	"artifact-metadata"?: #P
	attestations?:        #P
	checks?:              #P
	contents?:            #P
	deployments?:         #P
	"id-token"?:          #P
	issues?:              #P
	packages?:            #P
	pages?:               #P
	"pull-requests"?:     #P
	"security-events"?:   #P
	statuses?:            #P
}

#Concurrency: {
	group!:                string
	"cancel-in-progress"?: bool | string
}

// A pull request run is grouped by its number and cancelled by a newer push.
// Every other run is a group of its own and is never cancelled: GitHub keeps
// one pending run per group, so a shared group would drop queued main runs.
#PRConcurrency: {
	#Concurrency
	#name!:               string
	group:                "\(#name)-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.run_id }}"
	"cancel-in-progress": "${{ github.event_name == 'pull_request' }}"
}

// Production work queues behind the run holding the group and is never
// cancelled halfway.
#ProductionConcurrency: {
	#Concurrency
	"cancel-in-progress": false
}

#Env: [string]: string | number | bool

#Defaults: run?: {
	shell?:               string
	"working-directory"?: string
}

#Job: {
	name?: string
	needs?: string | [...string]
	if?:          string
	"runs-on"!:   string
	permissions?: #Permissions
	environment?: string | {
		name!: string
		url?:  string
	}
	concurrency?: #Concurrency
	outputs?: [string]: string
	env?:      #Env
	defaults?: #Defaults
	strategy?: {
		matrix!: {...} | string
		"fail-fast"?:    bool | string
		"max-parallel"?: int
	}
	"timeout-minutes"?:   int | string
	"continue-on-error"?: bool | string
	container?: {
		image!:   string
		options?: string
		env?:     #Env
	}
	steps!: [#Step, ...#Step]
}

#Step: {
	name?: string
	id?:   =~"^[A-Za-z_][A-Za-z0-9_-]*$"
	if?:   string
	uses?: #Uses
	with?: [string]: string | number | bool
	"working-directory"?: string
	shell?:               string
	env?:                 #Env
	run?:                 string
	"continue-on-error"?: bool | string
	"timeout-minutes"?:   int | string
}

// A local composite action or a pinned external one; see pins.cue.
#Uses: =~"^\\./\\.github/actions/[a-z0-9-]+$" | or([for _, p in pin {p.ref}])

#Checkout: {
	#Step
	name: *"Checkout" | string
	uses: *pin.checkout.ref | pin."nscloud-checkout".ref
	with: "persist-credentials": *false | bool
}

#SetupCuenv: {
	#Step
	name: *"Set up cuenv" | string
	uses: "./.github/actions/setup-cuenv"
}

#SetupRust: {
	#Step
	name: *"Set up Rust" | string
	uses: "./.github/actions/setup-rust"
}

#SetupRuntime: {
	#Step
	name: *"Set up the CI runtime" | string
	uses: "./.github/actions/setup-runtime"
}

#BunCache: {
	#Step
	name: *"Set up Bun cache" | string
	uses: pin."nscloud-cache".ref
	with: path: "~/.bun/install/cache"
}

// `cuenv task <task>` for a root task.
#Run: {
	#Step
	#task!: string
	run:    "cuenv task \(#task)"
}
