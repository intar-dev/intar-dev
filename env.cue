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

#Cargo: #Host & {command: "cargo"}

// A bash body. Values reach it as positional arguments, never as source text.
#Bash: #Host & {
	_script: string
	_argv: [...string]
	command: "bash"
	args: list.Concat([["-euo", "pipefail", "-c", _script, "cuenv-task"], _argv])
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

		fmt: #Cargo & {args: ["fmt"]}
		"fmt-check": #Cargo & {args: ["fmt", "--", "--check"]}
		clippy: #Cargo & {args: ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"]}

		// What the app lane runs on a Mac: the desktop app and its engine alone.
		"clippy-app": #Cargo & {args: ["clippy", "-p", "jumper", "-p", "zpm", "--all-targets", "--", "-D", "warnings"]}
		"test-app": #Cargo & {args: ["nextest", "run", "-p", "jumper", "-p", "zpm"]}
		// The app's macOS bundle, as a release builds it, and a guest booted
		// with the QEMU inside it. Only a Mac can build one; on another system
		// the lane's other steps are the check. A Mac that is not Apple
		// silicon fails in the script, so the lane's runner cannot skip it.
		//
		// The bundle takes the pinned QEMU. While the sources build a set that
		// is not pinned yet, there is none to take: qemu.yml builds and boots
		// that QEMU in the pull request, publishes it from main and opens the
		// pull request that pins it, and the bundle is built again from then.
		"bundle-app": #Bash & {
			_script: """
				if [ "$(uname -s)" != Darwin ]; then
				  echo "Skipped: the app's bundle is built on macOS."
				  exit 0
				fi
				built="$(bash tools/workflows/qemu/set.sh)"
				pinned="$(sed -n 's/^set //p' tools/workflows/qemu/pins.txt)"
				if [ "${built}" != "${pinned}" ]; then
				  echo "::warning::The app's bundle was not built: the QEMU sources build set ${built}, and ${pinned} is pinned."
				  exit 0
				fi
				tools/workflows/release/build-jumper-macos.sh
				tools/workflows/qemu/smoke.sh dist/Intar.app/Contents/Helpers
				"""
		}

		check: {
			type: "group"
			rust: #Cargo & {args: ["check", "--workspace"]}
			js: #Host & {command: "bun", args: ["run", "check"]}
		}

		// Puts the app's pinned QEMU beside a development build of jumper,
		// which runs no other: `cuenv task jumper-qemu`, or `-- release`.
		"jumper-qemu": #Host & {command: "bash", args: ["-e", "tools/workflows/qemu/fetch.sh"]}

		test: {
			type: "group"
			rust: #Cargo & {args: ["test", "--workspace"]}
			js: #Host & {command: "bun", args: ["run", "test"]}
		}

		build: {
			type: "group"
			rust: #Cargo & {args: ["build", "--workspace"]}
			js: #Host & {command: "bun", args: ["run", "build"]}
		}

		// The workspace gate CI runs, in order and stopping at the first failure.
		verify: [
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
			#Cargo & {args: ["nextest", "run", "--workspace"]},
		]

		security: {
			type: "group"
			// Owner: Web. GHSA-fc5q-39xc-vjpf: picomatch <= 4.0.7 (ReDoS in a crafted
			// glob), with no fixed release yet. It reaches the website only through
			// build tools (vite, astro, vitest, tailwind), which match the
			// repository's own globs. Review by 2026-12-01.
			js: #Host & {command: "bun", args: ["audit", "--audit-level=moderate", "--ignore=GHSA-fc5q-39xc-vjpf"]}
			rust: #Cargo & {args: ["audit", "--deny", "warnings"]}
		}

		// The Rust contracts' schemas and fixtures, then the Worker's types and
		// validators generated from those schemas.
		"generate-contracts": #Bash & {_script: """
			cargo run -p intar-contracts-typegen
			bun apps/web/scripts/generate-contract-validators.ts
			"""}
		generate: [_t."generate-contracts"]
		"check-generated-contracts": _checkGenerated
		// cuenv 0.56.7 evaluates a sequence that references another sequence
		// to null, so the alias repeats the steps.
		"check-generated": _checkGenerated
		"clean-generated": #Host & {command: "bun", args: ["run", "clean:generated"]}

		"build-kino-guest": #Cargo & {args: ["zigbuild", "--profile", "guest", "-p", "kino", "--target", "x86_64-unknown-linux-musl"]}

		// The in-repository content, as a repository of the scenario format.
		"validate-images": #Bash & {_script: """
			cargo run -q -p intar-image-cli -- validate --root content
			cargo run -q -p intar-image-cli -- fmt --check --root content
			cargo run -q -p intar-image-cli -- spec broken-nginx --verify --root content >/dev/null
			"""}

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

		// ci.yml's changes job: the hash of each lane's inputs, which names the
		// build a lane with a dist uploads.
		"ci-lane-inputs": #Host & {
			command: "tools/ci/lane-inputs.sh"
			args:    tasks["ci-changes"].args
		}

		// pr-title.yml and ci.yml's pr-title job: PR_TITLE, or else the subject of
		// the commit checked out, must be a Conventional Commit with one scope.
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
