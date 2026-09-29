package workflows

"workflows": release: {
	name: "Release"
	"run-name": """
		${{ inputs.resume_tag != ''
		    && format('{0} resume {1} from {2}', inputs.project, inputs.resume_tag, github.ref_name)
		    || format('{0} release {1} from {2}', inputs.project, inputs.bump, github.ref_name) }}
		"""
	on: workflow_dispatch: inputs: {
		project: {
			description: "Rust project to release"
			required:    true
			type:        "choice"
			options: [
				"intar-agent",
				"intar-builder",
				"intar-image-cli",
				"kino",
				"stargate",
			]
		}
		bump: {
			description: "Semantic version increment"
			required:    true
			type:        "choice"
			options: [
				"patch",
				"minor",
				"major",
			]
		}
		resume_tag: {
			description: "Existing project tag to finish publishing; bump is ignored"
			required:    false
			type:        "string"
			default:     ""
		}
	}
	permissions: {
		actions:  "read"
		contents: "read"
	}
	concurrency: {
		group:                "release-${{ inputs.project }}"
		"cancel-in-progress": false
	}

	// This is a shared artifact-release workflow, not a production deployment.
	// Keep protected-environment approval on the project-specific install/deploy
	// workflow so unrelated release targets do not inherit production approvals.
	jobs: {
		release: {
			name: "Bump, tag, and build"
			permissions: {
				actions:  "read"
				contents: "write"
			}
			// The jailed agent release needs a host kernel with Landlock enabled.
			// Namespace's runner kernel currently has Landlock disabled at boot, while
			// the other release targets do not execute the privileged jailer smoke.
			"runs-on": "${{ inputs.project == 'intar-agent' && 'ubuntu-24.04' || 'namespace-profile-intar-dev' }}"
			steps: [{
				name: "Ensure main"
				env: {
					RESUME_TAG:  "${{ inputs.resume_tag }}"
					RUN_ATTEMPT: "${{ github.run_attempt }}"
				}
				run: """
					set -euo pipefail
					if [ -z "${RESUME_TAG}" ]; then
					  if [ "${RUN_ATTEMPT}" != "1" ]; then
					    echo "Do not rerun a failed new release: start a fresh dispatch, or resume the exact tag if one was created." >&2
					    exit 1
					  fi
					  if [ "${GITHUB_REF_TYPE}" != "branch" ] || [ "${GITHUB_REF_NAME}" != "main" ]; then
					    echo "A new release must run from the main branch, got ${GITHUB_REF}." >&2
					    exit 1
					  fi
					else
					  case "${GITHUB_REF_TYPE}:${GITHUB_REF_NAME}" in
					    branch:main|"tag:${RESUME_TAG}") ;;
					    *)
					      echo "Resume ${RESUME_TAG} from main or from that exact tag, got ${GITHUB_REF}." >&2
					      exit 1
					      ;;
					  esac
					fi

					"""
			}, {
				name: "Checkout on Namespace"
				if:   "inputs.project != 'intar-agent'"
				uses: "namespacelabs/nscloud-checkout-action@66f2dc6f6c42a8ac6c4e53473c4840006822831e" // v9
				with: "fetch-depth": 0
			}, {
				name: "Checkout jailed agent release"
				if:   "inputs.project == 'intar-agent'"
				uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" // v7
				with: "fetch-depth": 0
			}, {
				// The run steps below are cuenv tasks, on the resume path too.
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Preflight jailed release runner"
				if:   "inputs.project == 'intar-agent'"
				run:  "cuenv task release-preflight-jailed-release-runner"
			}, {
				name: "Resolve project"
				id:   "project"
				env: PROJECT: "${{ inputs.project }}"
				run: "cuenv task release-resolve-project"
			}, {
				name: "Determine release tag"
				id:   "next"
				env: {
					BUMP:       "${{ inputs.bump }}"
					MANIFEST:   "${{ steps.project.outputs.manifest }}"
					PROJECT:    "${{ inputs.project }}"
					RESUME_TAG: "${{ inputs.resume_tag }}"
					TAG_PREFIX: "${{ steps.project.outputs.tag_prefix }}"
				}
				run: "cuenv task release-determine-release-tag"
			}, {
				name: "Install Rust toolchain"
				if:   "steps.next.outputs.resume != 'true'"
				run:  "cuenv task release-install-rust-toolchain"
			}, {
				name: "Set up Namespace caches"
				if:   "inputs.project != 'intar-agent' && steps.next.outputs.resume != 'true'"
				uses: "namespacelabs/nscloud-cache-action@1124a6f3ce44e5cf84cc22111530961f4d2a15f9" // v1
				with: cache: "rust"
			}, {
				name: "Install tools"
				if:   "steps.next.outputs.resume != 'true'"
				uses: "taiki-e/install-action@4cef1412cce204788f482e778a0b9187f9626a29" // v2
				with: tool: "cargo-nextest@0.9.143,cargo-zigbuild@0.23.0"
			}, {
				name: "Install Zig"
				if:   "steps.next.outputs.resume != 'true'"
				uses: "mlugg/setup-zig@d1434d08867e3ee9daa34448df10607b98908d29" // v2
				with: version: "0.16.0"
			}, {
				name: "Apply release version"
				if:   "steps.next.outputs.resume != 'true'"
				env: {
					MANIFEST: "${{ steps.project.outputs.manifest }}"
					VERSION:  "${{ steps.next.outputs.version }}"
					PACKAGE:  "${{ steps.project.outputs.package }}"
				}
				run: "cuenv task release-apply-release-version"
			}, {
				name: "Set up Bun for pinned content hydration"
				if:   "steps.next.outputs.resume != 'true'"
				uses: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6" // v2
				with: "bun-version": "1.3.14"
			}, {
				name: "Restore shared Bun cache"
				if:   "inputs.project != 'intar-agent' && steps.next.outputs.resume != 'true'"
				uses: "namespacelabs/nscloud-cache-action@1124a6f3ce44e5cf84cc22111530961f4d2a15f9" // v1
				with: path: "~/.bun/install/cache"
			}, {
				name: "Run checks"
				if:   "steps.next.outputs.resume != 'true'"
				run:  "cuenv task verify"
			}, {
				name: "Build release artifacts"
				if:   "steps.next.outputs.resume != 'true'"
				env: {
					PACKAGE: "${{ steps.project.outputs.package }}"
					BINARY:  "${{ steps.project.outputs.binary }}"
					VERSION: "${{ steps.next.outputs.version }}"
				}
				run: "cuenv task release-build-release-artifacts"
			}, {
				name: "Test personal-host installer"
				if:   "inputs.project == 'intar-agent' && steps.next.outputs.resume != 'true'"
				run:  "cuenv task installer-tests"
			}, {
				name: "Run privileged agent package smoke"
				if:   "inputs.project == 'intar-agent' && steps.next.outputs.resume != 'true'"
				env: VERSION: "${{ steps.next.outputs.version }}"
				run: "cuenv task release-privileged-agent-package-smoke"
			}, {
				name: "Smoke-test image CLI release package"
				if:   "inputs.project == 'intar-image-cli' && steps.next.outputs.resume != 'true'"
				env: VERSION: "${{ steps.next.outputs.version }}"
				run: "cuenv task release-smoke-test-image-cli-package"
			}, {
				name: "Preserve exact release payload"
				id:   "release_payload"
				if:   "steps.next.outputs.resume != 'true'"
				uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" // v7
				with: {
					name:                "${{ steps.next.outputs.payload_name }}"
					path:                "dist/"
					"if-no-files-found": "error"
					"compression-level": 0
					overwrite:           true
					"retention-days":    30
				}
			}, {
				name: "Resolve release payload"
				id:   "payload"
				env: {
					NEW_DIGEST:        "${{ steps.release_payload.outputs.artifact-digest }}"
					NEW_ID:            "${{ steps.release_payload.outputs.artifact-id }}"
					PAYLOAD_NAME:      "${{ steps.next.outputs.payload_name }}"
					RESUME:            "${{ steps.next.outputs.resume }}"
					RESUME_DIGEST:     "${{ steps.next.outputs.payload_digest }}"
					RESUME_ID:         "${{ steps.next.outputs.payload_id }}"
					RESUME_RUN_ID:     "${{ steps.next.outputs.payload_run_id }}"
					RESUME_SOURCE_SHA: "${{ steps.next.outputs.payload_source_sha }}"
				}
				run: "cuenv task release-resolve-release-payload"
			}, {
				name: "Validate preserved resume payload"
				if:   "steps.next.outputs.resume == 'true'"
				env: {
					GH_TOKEN:           "${{ github.token }}"
					PAYLOAD_DIGEST:     "${{ steps.payload.outputs.digest }}"
					PAYLOAD_ID:         "${{ steps.payload.outputs.id }}"
					PAYLOAD_NAME:       "${{ steps.payload.outputs.name }}"
					PAYLOAD_RUN_ID:     "${{ steps.payload.outputs.run_id }}"
					PAYLOAD_SOURCE_SHA: "${{ steps.payload.outputs.source_sha }}"
				}
				run: "cuenv task release-validate-resume-payload"
			}, {
				name: "Restore exact release payload"
				if:   "steps.next.outputs.resume == 'true'"
				uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c" // v8
				with: {
					"artifact-ids": "${{ steps.payload.outputs.id }}"
					path:           "dist/"
					"github-token": "${{ github.token }}"
					"run-id":       "${{ steps.payload.outputs.run_id }}"
				}
			}, {
				name: "Commit release version"
				id:   "version_commit"
				env: {
					MANIFEST:    "${{ steps.project.outputs.manifest }}"
					RESUME:      "${{ steps.next.outputs.resume }}"
					RESUME_SHA:  "${{ steps.next.outputs.release_sha }}"
					VERSION_TAG: "${{ steps.next.outputs.version_tag }}"
					PROJECT:     "${{ inputs.project }}"
				}
				run: "cuenv task release-commit-release-version"
			}, {
				name: "Publish tagged GitHub release"
				env: {
					GH_TOKEN:           "${{ github.token }}"
					PAYLOAD_DIGEST:     "${{ steps.payload.outputs.digest }}"
					PAYLOAD_ID:         "${{ steps.payload.outputs.id }}"
					PAYLOAD_NAME:       "${{ steps.payload.outputs.name }}"
					PAYLOAD_RUN_ID:     "${{ steps.payload.outputs.run_id }}"
					PAYLOAD_SOURCE_SHA: "${{ steps.payload.outputs.source_sha }}"
					PROJECT:            "${{ inputs.project }}"
					RELEASE_SHA:        "${{ steps.version_commit.outputs.sha }}"
					RESUME:             "${{ steps.next.outputs.resume }}"
					TAG:                "${{ steps.next.outputs.tag }}"
					VERSION_TAG:        "${{ steps.next.outputs.version_tag }}"
				}
				run: "cuenv task release-publish-tagged-github-release"
			}]
		}
	}
}

// The release job's run steps. The resume payload check and the publish use the
// job token, and the publish pushes and tags, so they run only in GitHub Actions.
tasks: {
	"release-preflight-jailed-release-runner": #Script & {_script: "tools/workflows/release/preflight-jailed-release-runner.sh"}
	"release-resolve-project": #Script & {_script: "tools/workflows/release/resolve-project.sh"}
	"release-determine-release-tag": #Script & {_script: "tools/workflows/release/determine-release-tag.sh"}
	"release-install-rust-toolchain": #Script & {_script: "tools/workflows/release/install-rust-toolchain.sh"}
	"release-apply-release-version": #Script & {_script: "tools/workflows/release/apply-release-version.sh"}
	"release-build-release-artifacts": #Script & {_script: "tools/workflows/release/build-release-artifacts.sh"}
	"release-privileged-agent-package-smoke": #Script & {_script: "tools/workflows/release/privileged-agent-package-smoke.sh"}
	"release-smoke-test-image-cli-package": #Script & {_script: "tools/workflows/release/smoke-test-image-cli-package.sh"}
	"release-resolve-release-payload": #Script & {_script: "tools/workflows/release/resolve-release-payload.sh"}
	"release-validate-resume-payload": #Script & {_script: "tools/workflows/release/validate-resume-payload.sh", _production: true}
	"release-commit-release-version": #Script & {_script: "tools/workflows/release/commit-release-version.sh"}
	"release-publish-tagged-github-release": #Script & {_script: "tools/workflows/release/publish-tagged-github-release.sh", _production: true}
}
