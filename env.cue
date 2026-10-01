package cuenv

import (
	"list"
	"strings"

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

// Runs tasks in order through `cuenv task`, stopping at the first failure.
// cuenv 0.56.7 evaluates a sequence that references another sequence, such as
// verify, to null.
#InOrder: #Bash & {
	_steps: [...string]
	_script: """
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

	// The workflows are GitHub Actions data in ci/workflows, rendered here. See
	// ci/README.md. Their steps run as tasks of the intar-ci project in
	// ci/env.cue, or as the root tasks below.
	codegen: files: {
		for path, rendered in workflows.files {
			(path): gen.#YAMLFile & {content: rendered, gitignore: false}
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
			js: #Host & {command: "bun", args: ["run", "check"]}
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
			shopt -s nullglob
			for script in \\
			  deploy/stargate/scripts/intar-deploy-stargate \\
			  deploy/stargate/scripts/bootstrap-deploy-user \\
			  tools/ci/*.sh \\
			  tools/workflows/*/*.sh; do
			  test -x "${script}"
			  bash -n "${script}"
			  # The workflow step bodies keep the full-severity shellcheck
			  # actionlint gave them when they were inline.
			  case "${script}" in
			    tools/ci/* | tools/workflows/*) shellcheck "${script}" ;;
			    *) shellcheck --severity=warning "${script}" ;;
			  esac
			done
			"""}

		whitespace: #Bash & {_script: """
			if git grep -nI -E '[[:blank:]]+$' -- \\
			  '.github/workflows/*.yml' \\
			  'deploy/stargate/scripts/*' \\
			  'tools/ci/*.sh' \\
			  'tools/workflows/*/*.sh'; then
			  echo 'Trailing whitespace found in a workflow or a host script.' >&2
			  exit 1
			fi
			"""}

		"workflow-policy": #Bash & {_script: """
			bun test tools/ci
			bun tools/ci/check-workflow-security.ts
			"""}

		actionlint: #Host & {command: "tools/ci/actionlint.sh"}

		// Rendered workflows must match ci/workflows. The codegen check compares
		// only the files it renders, so a leftover or hand-written workflow, or a
		// rendered one Dependabot would edit, is caught here.
		"sync-check": #Bash & {
			_script: """
				cuenv sync codegen --check
				# No sync loads the intar-ci project in ci/env.cue that every
				# workflow step task runs in.
				cuenv task -p ci --package ci -o json >/dev/null
				if ! diff <(printf '%s\\n' "$@" | sort) <(find .github/workflows -type f | sort) >&2; then
				  echo 'Every workflow must be rendered by cuenv or be scenario-publish.yml.' >&2
				  exit 1
				fi
				for path in "$@"; do
				  if [[ "${path}" == */scenario-publish.yml ]]; then
				    continue
				  fi
				  if ! grep -qF -- "- \\"${path}\\"" .github/dependabot.yml; then
				    echo "${path} must be in the exclude-paths of .github/dependabot.yml." >&2
				    exit 1
				  fi
				done
				"""
			_argv: list.Concat([
				[for path, _ in workflows.files {path}],
				[".github/workflows/scenario-publish.yml"],
			])
		}

		// The CI lanes in ci/workflows/lanes.cue: `cuenv task lanes.<name>` runs
		// the steps of that lane's ci.yml job, and `cuenv task ci` runs every lane.
		lanes: {
			type: "group"
			for name, lane in workflows.lanes {
				(name): #InOrder & {_steps: lane.steps}
			}
		}
		ci: #InOrder & {_steps: [for name, _ in workflows.lanes {"lanes.\(name)"}]}

		// ci.yml's changes job: which lanes a pull request needs.
		"ci-changes": #Host & {
			command: "tools/ci/changed-lanes.sh"
			args: [for name, lane in workflows.lanes {
				strings.Join(list.Concat([[name], lane.inputs, workflows.sharedInputs]), " ")
			}]
		}

		// ci.yml's pr-title job: PR_TITLE must be a Conventional Commit with one
		// scope.
		"pr-title": #Host & {command: "tools/ci/check-pr-title.sh"}

		// The web build deploy.yml deploys: the image registry cleanup worker it
		// deploys from the artifact has no route and no public surface.
		"check-web-artifact": #Host & {command: "tools/workflows/website/verify-registry-cleanup-artifact.sh"}

		"check-docs": #Bash & {
			dir: path: "docs"
			_script: """
				bun install --frozen-lockfile
				bun run build
				bunx --no-install wrangler deploy --dry-run
				"""
		}

		// ci.yml's web-ui job. Install the browsers once with
		// `bun run --cwd apps/web ui:install`.
		"test-ui-smoke": #Host & {
			command: "bunx"
			args: ["playwright", "test", "tests/ui/smoke.spec.ts", "--project=chromium-smoke"]
			dir: path: "apps/web"
		}
	}
}
