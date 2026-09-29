package cuenv

import (
	"list"

	"github.com/cuenv/cuenv/schema"
	gen "github.com/cuenv/cuenv/schema/codegen"
	"github.com/intar-dev/intar-dev/ci/workflows"
)

// Every task runs in the live checkout with the caller's environment. The Rust
// tasks share the root target directory and the default Cargo cache, and the
// checks read git state. cuenv's default hermetic sandbox has neither.
#Host: schema.#Task & {hermetic: false}

// Cargo resolves the workspace only after the pinned libnbd bindings exist.
// Without --rust-only the wrapper also builds the static libnbd for Linux.
#Libnbd: #Host & {command: "tools/image-build/with-libnbd-env.sh"}

// A bash body. Values reach it as positional arguments, never as source text.
#Bash: #Host & {
	_script: string
	_argv: [...string]
	command: "bash"
	args: list.Concat([["-euo", "pipefail", "-c", _script, "cuenv-task"], _argv])
}

// ponytail: cuenv 0.56.7 substitutes {{param}} only when the task gets
// arguments, so a bare `cuenv task render-images` passes the placeholder
// through. The image tasks treat an unsubstituted value as unset. Drop this
// when cuenv applies parameter defaults without arguments.
let _param = """
	param() { case "$1" in "{{"*) printf '%s' "$2" ;; *) printf '%s' "$1" ;; esac; }

	"""

let _builderConfig = "builder.sample.amd64.hcl"

let _imageParams = {
	scenario: {description: "One scenario instead of every scenario", default: ""}
	config: {description: "Builder configuration", default: _builderConfig}
}

// Each CI lane is one leaf task, so cuenv's expanded mode emits one job for
// it. Expanded mode turns groups and sequences into parallel jobs without
// ordering, so the lane runs its steps in order through `cuenv task` instead.
// Its inputs are the lane's trigger paths.
#Lane: #Bash & {
	_steps: [...string]
	_script: """
		if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
		  # The generated checkout persists the job token and the generated step
		  # exports it. No lane step needs it, so keep it from build scripts.
		  git config --local --unset-all http.https://github.com/.extraheader || true
		  unset GITHUB_TOKEN
		fi
		for step in "$@"; do
		  cuenv task "$step"
		done
		"""
	_argv: _steps
}

schema.#Project & {
	name: "intar"
	let _t = tasks
	let _checkGenerated = [
		_t."generate-contracts",
		#Host & {command: "git", args: ["diff", "--exit-code", "--", "apps/web/src/generated"]},
	]

	// The workflows cuenv's CI generator cannot express are GitHub Actions
	// data in ci/workflows, rendered here. See ci/workflows/render.cue.
	codegen: files: {
		for path, rendered in workflows.files {
			(path): gen.#YAMLFile & {content: rendered, gitignore: false}
		}
	}

	ci: {
		providers: ["github"]
		provider: github: {
			runner: "namespace-profile-intar-dev"
			permissions: {
				contents:        "read"
				checks:          "none"
				"pull-requests": "none"
			}
		}

		// Setup runs as local composite actions after checkout, so every
		// external action pin stays in hand-written YAML where Dependabot and
		// the workflow policy can see its version comment.
		contributors: [
			{
				id: "cuenv"
				tasks: [{
					id:       "cuenv.setup"
					label:    "Set up cuenv"
					priority: 10
					provider: github: uses: "./.github/actions/setup-cuenv"
				}]
			},
			{
				id: "rust"
				when: taskLabels: ["rust"]
				tasks: [{
					id:       "rust.setup"
					label:    "Set up Rust"
					priority: 5
					provider: github: uses: "./.github/actions/setup-rust"
				}]
			},
			{
				id: "runtime"
				when: taskLabels: ["js"]
				tasks: [{
					id:       "runtime.setup"
					label:    "Set up the CI runtime"
					priority: 6
					provider: github: uses: "./.github/actions/setup-runtime"
				}]
			},
		]

		// ponytail: cuenv 0.56.7 hardcodes each workflow's concurrency group to
		// the head branch name with cancel-in-progress, so a fork pull request
		// from a branch named like another pull request's branch cancels that
		// pull request's lanes. Re-run them; nothing merges on a cancelled lane
		// without a human. Key pull requests on their number once cuenv lets a
		// pipeline set its concurrency group.
		pipelines: {
			rust: {
				mode: "expanded"
				when: {branch: "main", pullRequest: true, manual: true}
				tasks: [_t.lanes.rust]
			}
			security: {
				mode: "expanded"
				when: {branch: "main", pullRequest: true, manual: true}
				tasks: [_t.lanes.security]
			}
			images: {
				mode: "expanded"
				when: {branch: "main", pullRequest: true, manual: true}
				tasks: [_t.lanes.images]
			}
		}
	}

	tasks: {
		"install-js": #Host & {
			command: "bun"
			args: ["install", "--frozen-lockfile"]
		}

		fmt: #Libnbd & {args: ["--rust-only", "--", "cargo", "fmt"]}
		"fmt-check": #Libnbd & {args: ["--rust-only", "--", "cargo", "fmt", "--", "--check"]}
		clippy: #Libnbd & {args: ["--", "cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]}
		"check-libnbd": #Host & {command: "tools/image-build/test-libnbd-rust-preparation.sh"}

		check: {
			type: "group"
			rust: #Libnbd & {args: ["--", "cargo", "check", "--workspace"]}
			js: #Bash & {_script: """
				bun run check:imports
				bun run check:deploy
				bun run check:database-migrations
				bun run --cwd apps/web types:cf:check
				bun run --cwd apps/web db:schema:check
				"""}
		}

		test: {
			type: "group"
			rust: #Libnbd & {args: ["--", "cargo", "test", "--workspace"]}
			js: #Host & {command: "bun", args: ["run", "test"]}
		}

		build: {
			type: "group"
			rust: #Libnbd & {args: ["--", "cargo", "build", "--workspace"]}
			js: #Host & {command: "bun", args: ["run", "build"]}
		}

		// The workspace gate CI runs, in order and stopping at the first failure.
		verify: [
			_t."check-libnbd",
			#Host & {
				command: "sh"
				args: ["crates/intar-jailerd/tests/install-process-audit.sh", "crates/intar-jailerd/deploy/install.sh"]
			},
			#Host & {
				command: "python3"
				args: ["-m", "unittest", "discover", "-s", "crates/intar-jailerd/tests", "-p", "test_*.py"]
				env: PYTHONDONTWRITEBYTECODE: "1"
			},
			_t."fmt-check",
			_t.clippy,
			#Libnbd & {args: ["--", "cargo", "nextest", "run", "--workspace"]},
		]

		security: {
			type: "group"
			js: #Host & {command: "bun", args: ["audit", "--audit-level=moderate"]}
			rust: #Libnbd & {args: ["--rust-only", "--", "cargo", "audit", "--deny", "warnings"]}
		}

		"generate-contracts": #Libnbd & {args: ["--rust-only", "--", "cargo", "run", "-p", "intar-contracts-typegen"]}
		generate: [_t."generate-contracts"]
		"check-generated-contracts": _checkGenerated
		// cuenv 0.56.7 evaluates a sequence that references another sequence
		// to null, so the alias repeats the steps.
		"check-generated": _checkGenerated
		"clean-generated": #Host & {command: "bun", args: ["run", "clean:generated"]}

		"build-kino-guest": #Libnbd & {args: ["--rust-only", "--", "cargo", "zigbuild", "--profile", "guest", "-p", "kino", "--target", "x86_64-unknown-linux-musl"]}

		"validate-images": #Libnbd & {args: ["--", "cargo", "run", "-p", "intar-image-cli", "--", "validate"]}

		"render-images": #Bash & {
			params: _imageParams
			_argv: ["{{scenario}}", "{{config}}"]
			_script: _param + """
				scenario="$(param "$1" '')"
				args=(render)
				if [[ -n "${scenario}" ]]; then
				  args+=("${scenario}")
				fi
				args+=(--config "$(param "$2" '\(_builderConfig)')")
				tools/image-build/with-libnbd-env.sh -- cargo run -p intar-image-cli -- "${args[@]}"
				"""
		}

		"build-images": #Bash & {
			params: _imageParams & {
				"no-upload": {description: "Build without uploading", default: "false"}
			}
			_argv: ["{{scenario}}", "{{config}}", "{{no-upload}}"]
			_script: _param + """
				scenario="$(param "$1" '')"
				if [[ -n "${scenario}" ]]; then
				  args=(build "${scenario}")
				else
				  args=(build-all)
				fi
				args+=(--config "$(param "$2" '\(_builderConfig)')")
				if [[ "$(param "$3" false)" == true ]]; then
				  args+=(--no-upload)
				fi
				tools/image-build/with-libnbd-env.sh -- cargo run -p intar-image-cli -- "${args[@]}"
				"""
		}

		"bundle-images": #Bash & {
			params: _imageParams & {
				rev: {description: "Source revision recorded in the bundle", default: ""}
				url: {description: "Source URL recorded in the bundle", default: ""}
				"no-upload": {description: "Bundle without uploading", default: "false"}
			}
			_argv: ["{{scenario}}", "{{config}}", "{{rev}}", "{{url}}", "{{no-upload}}"]
			_script: _param + """
				scenario="$(param "$1" '')"
				rev="$(param "$3" '')"
				url="$(param "$4" '')"
				args=(bundle)
				if [[ -n "${scenario}" ]]; then
				  args+=("${scenario}")
				fi
				args+=(--config "$(param "$2" '\(_builderConfig)')")
				if [[ -n "${rev}" ]]; then
				  args+=(--rev "${rev}")
				fi
				if [[ -n "${url}" ]]; then
				  args+=(--url "${url}")
				fi
				if [[ "$(param "$5" false)" == true ]]; then
				  args+=(--no-upload)
				fi
				tools/image-build/with-libnbd-env.sh -- cargo run -p intar-image-cli -- "${args[@]}"
				"""
		}

		// Checks that used to exist only inline in CI.
		"installer-tests": #Bash & {_script: """
			python3 -m unittest discover -s deploy/personal-metal -p 'test_*.py'
			sh -n apps/web/public/install.sh deploy/personal-metal/package.sh
			"""}

		// The Stargate host scripts run as root on the gateway.
		"host-scripts": #Bash & {_script: """
			for script in \\
			  deploy/stargate/scripts/intar-deploy-stargate \\
			  deploy/stargate/scripts/bootstrap-deploy-user \\
			  tools/deploy/configure-stargate-ssh.sh; do
			  test -x "${script}"
			  bash -n "${script}"
			  shellcheck --severity=warning "${script}"
			done
			"""}

		whitespace: #Bash & {_script: """
			if git grep -nI -E '[[:blank:]]+$' -- \\
			  '.github/workflows/*.yml' \\
			  'deploy/stargate/scripts/*' \\
			  'tools/deploy/configure-stargate-ssh.sh'; then
			  echo 'Trailing whitespace found in a workflow or a host script.' >&2
			  exit 1
			fi
			"""}

		"workflow-policy": #Bash & {_script: """
			bun test tools/ci/check-workflow-security.test.ts
			bun tools/ci/check-workflow-security.ts
			"""}

		actionlint: #Host & {command: "tools/ci/actionlint.sh"}

		// Generated workflows must match env.cue.
		"sync-check": #Host & {command: "cuenv", args: ["sync", "ci", "--check"]}

		lanes: {
			type: "group"

			rust: #Lane & {
				labels: ["rust"]
				_steps: ["installer-tests", "verify", "check-generated-contracts", "build-kino-guest"]
				inputs: [
					"Cargo.toml",
					"Cargo.lock",
					"rust-toolchain.toml",
					"tools/image-build/**",
					".github/actions/setup-cuenv/**",
					".github/actions/setup-rust/**",
					// deploy/personal-metal/test_installer.py reads release.yml.
					".github/workflows/release.yml",
					"rustfmt.toml",
					"package.json",
					"bun.lock",
					"content/scenarios/base-images.hcl",
					"crates/**",
					"deploy/personal-metal/**",
					"apps/web/public/install.sh",
					"apps/web/src/generated/**",
				]
			}

			// Script lint runs before the audits: a dependency audit must not
			// stop the shell correctness check of the host deployment scripts.
			security: #Lane & {
				labels: ["rust", "js"]
				timeout: "30m"
				_steps: ["host-scripts", "whitespace", "sync-check", "install-js", "workflow-policy", "security", "actionlint"]
				inputs: [
					".github/**",
					".cargo/audit.toml",
					"**/Cargo.toml",
					"Cargo.lock",
					"rust-toolchain.toml",
					"bun.lock",
					"**/package.json",
					"apps/web/.node-version",
					"apps/web/public/_headers",
					"apps/web/vitest.workers.config.ts",
					"apps/web/wrangler.jsonc",
					"apps/web/wrangler.local.jsonc",
					"deploy/stargate/**",
					"docs/public/_headers",
					"docs/wrangler.jsonc",
					// The Rust audit must still run for a Rust source change: it is
					// the only audit that sees a newly published advisory.
					"crates/**",
					"tools/ci/**",
					"tools/deploy/configure-stargate-ssh.sh",
					"tools/deploy/configure-stargate-ssh.test.ts",
					"tools/image-build/**",
				]
			}

			images: #Lane & {
				labels: ["rust"]
				_steps: ["validate-images", "render-images"]
				inputs: [
					"Cargo.toml",
					"Cargo.lock",
					"rust-toolchain.toml",
					"tools/image-build/**",
					".github/actions/setup-cuenv/**",
					".github/actions/setup-rust/**",
					"crates/intar-builder/**",
					"crates/intar-contracts/**",
					"crates/intar-contracts-typegen/**",
					"crates/intar-image-*/**",
					"content/scenarios/base-images.hcl",
					"builder.*.hcl",
					"content/courses/**",
					"apps/web/migrations/**",
					"apps/web/src/control-plane/auth.ts",
					"apps/web/src/control-plane/bridge-v8.ts",
					"apps/web/src/control-plane/host-runtime-do.ts",
					"apps/web/src/control-plane/image-registry.ts",
					"apps/web/src/generated/**",
					"apps/web/src/lib/build-scheduler*.ts",
					"apps/web/src/lib/desired-state*.ts",
					"apps/web/src/lib/host-runtime-wake.ts",
					"apps/web/src/lib/scenario-hosts.ts",
					"apps/web/src/db/schema.ts",
					"apps/web/src/pages/api/agent/hosts.ts",
				]
			}
		}
	}
}
