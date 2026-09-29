package workflows

"workflows": "stargate-deploy": {
	name:       "Stargate production"
	"run-name": "Stargate ${{ inputs.operation }} ${{ inputs.operation == 'rollback' && inputs.rollback_backup || inputs.release_tag }} @ ${{ github.sha }}"
	on: workflow_dispatch: inputs: {
		operation: {
			description: "Operation to perform"
			required:    true
			type:        "choice"
			options: [
				"plan",
				"apply",
				"rollback",
			]
		}
		release_tag: {
			description: "Exact Stargate release tag for plan/apply"
			required:    false
			type:        "string"
		}
		rollback_backup: {
			description: "Exact host backup ID for rollback"
			required:    false
			type:        "string"
		}
		confirmation: {
			description: "Type DEPLOY STARGATE or ROLLBACK STARGATE for a mutation"
			required:    false
			type:        "string"
		}
		single_operator_confirmation: {
			description: "Type SINGLE OPERATOR STARGATE only when no independent reviewer exists"
			required:    false
			type:        "string"
		}
	}
	permissions: {
		actions:  "read"
		contents: "read"
	}
	concurrency: {
		group:                "stargate-production"
		"cancel-in-progress": false
	}
	jobs: {
		preflight: {
			name:              "Validate deployment request"
			"runs-on":         "ubuntu-24.04"
			"timeout-minutes": 5
			steps: [{
				name: "Require main revision"
				run:  "test \"${GITHUB_REF}\" = refs/heads/main"
			}, {
				name: "Checkout"
				uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" // v7
				with: "persist-credentials": false
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Validate operation"
				env: {
					OPERATION:                    "${{ inputs.operation }}"
					RELEASE_TAG:                  "${{ inputs.release_tag }}"
					ROLLBACK_BACKUP:              "${{ inputs.rollback_backup }}"
					CONFIRMATION:                 "${{ inputs.confirmation }}"
					SINGLE_OPERATOR_CONFIRMATION: "${{ inputs.single_operator_confirmation }}"
				}
				run: "cuenv task stargate-deploy-validate-operation"
			}, {
				name: "Validate host deployment scripts"
				run:  "cuenv task stargate-deploy-validate-host-deployment-scripts"
			}]
		}
		deploy: {
			name:              "${{ inputs.operation }} production Stargate"
			needs:             "preflight"
			"runs-on":         "ubuntu-24.04"
			environment:       "production"
			"timeout-minutes": 20
			env: {
				GH_TOKEN:                          "${{ github.token }}"
				DEPLOY_HOST:                       "${{ vars.STARGATE_DEPLOY_HOST }}"
				DEPLOY_PORT:                       "${{ vars.STARGATE_DEPLOY_PORT }}"
				DEPLOY_USER:                       "${{ vars.STARGATE_DEPLOY_USER }}"
				APPROVAL_MODE:                     "${{ vars.STARGATE_DEPLOY_APPROVAL_MODE }}"
				SINGLE_OPERATOR_LOGIN:             "${{ vars.STARGATE_SINGLE_OPERATOR_LOGIN }}"
				SINGLE_OPERATOR_ID:                "${{ vars.STARGATE_SINGLE_OPERATOR_ID }}"
				SINGLE_OPERATOR_EXPIRES_AT:        "${{ vars.STARGATE_SINGLE_OPERATOR_EXPIRES_AT }}"
				SINGLE_OPERATOR_ADMIN_ATTESTED_AT: "${{ vars.STARGATE_SINGLE_OPERATOR_ADMIN_ATTESTED_AT }}"
				ACTOR_ID:                          "${{ github.actor_id }}"
				RUN_ATTEMPT:                       "${{ github.run_attempt }}"
				SINGLE_OPERATOR_CONFIRMATION:      "${{ inputs.single_operator_confirmation }}"
			}
			steps: [{
				name: "Checkout"
				uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" // v7
				with: {
					"fetch-depth":         0
					"persist-credentials": false
				}
			}, {
				name: "Set up cuenv"
				uses: "./.github/actions/setup-cuenv"
			}, {
				name: "Verify protected production dispatch"
				run:  "cuenv task stargate-deploy-verify-protected-production-dispatch"
			}, {
				name: "Verify release provenance"
				if:   "inputs.operation != 'rollback'"
				env: RELEASE_TAG: "${{ inputs.release_tag }}"
				run: "cuenv task stargate-deploy-verify-release-provenance"
			}, {
				name: "Configure pinned SSH identity"
				id:   "ssh"
				env: {
					STARGATE_DEPLOY_HOST:            "${{ vars.STARGATE_DEPLOY_HOST }}"
					STARGATE_DEPLOY_PORT:            "${{ vars.STARGATE_DEPLOY_PORT }}"
					STARGATE_DEPLOY_USER:            "${{ vars.STARGATE_DEPLOY_USER }}"
					STARGATE_DEPLOY_SSH_PRIVATE_KEY: "${{ secrets.STARGATE_DEPLOY_SSH_PRIVATE_KEY }}"
					STARGATE_DEPLOY_KNOWN_HOSTS:     "${{ secrets.STARGATE_DEPLOY_KNOWN_HOSTS }}"
				}
				run: "cuenv task stargate-deploy-configure-pinned-ssh-identity"
			}, {
				name: "Read host deployment plan"
				run:  "cuenv task stargate-deploy-read-host-deployment-plan"
			}, {
				name: "Download and verify release"
				if:   "inputs.operation == 'apply'"
				env: RELEASE_TAG: "${{ inputs.release_tag }}"
				run: "cuenv task stargate-deploy-download-and-verify-release"
				id:  "release"
			}, {
				name: "Recheck sole-operator mutation window"
				if:   "inputs.operation != 'plan'"
				run:  "cuenv task stargate-deploy-recheck-sole-operator-mutation-window"
			}, {
				name: "Apply release"
				if:   "inputs.operation == 'apply'"
				id:   "apply"
				env: {
					RELEASE_TAG:    "${{ inputs.release_tag }}"
					ARCHIVE:        "${{ steps.release.outputs.archive }}"
					ARCHIVE_SHA256: "${{ steps.release.outputs.archive_sha256 }}"
					BINARY_SHA256:  "${{ steps.release.outputs.binary_sha256 }}"
				}
				run: "cuenv task stargate-deploy-apply-release"
			}, {
				name: "Roll back release"
				if:   "inputs.operation == 'rollback'"
				env: ROLLBACK_BACKUP: "${{ inputs.rollback_backup }}"
				run: "cuenv task stargate-deploy-roll-back-release"
			}, {
				name: "Verify public routing"
				if:   "inputs.operation != 'plan'"
				id:   "public"
				env: OPERATION: "${{ inputs.operation }}"
				run: "cuenv task stargate-deploy-verify-public-routing"
			}, {
				name: "Restore prior release after failed public verification"
				if:   "failure() && inputs.operation == 'apply' && steps.apply.outcome == 'success' && steps.public.outcome == 'failure'"
				env: BACKUP_ID: "${{ steps.apply.outputs.backup_id }}"
				run: "cuenv task stargate-deploy-restore-prior-release"
			}, {
				name: "Read final host state"
				if:   "always() && steps.ssh.outcome == 'success'"
				run:  "cuenv task stargate-deploy-read-final-host-state"
			}]
		}
	}
}

// The run steps above. A step that holds the deploy key or reaches the
// Stargate host over SSH runs only in GitHub Actions.
tasks: {
	"stargate-deploy-validate-operation": #Script & {_script: "tools/workflows/stargate-deploy/validate-operation.sh"}
	"stargate-deploy-validate-host-deployment-scripts": #Script & {_script: "tools/workflows/stargate-deploy/validate-host-deployment-scripts.sh"}
	"stargate-deploy-verify-protected-production-dispatch": #Script & {_script: "tools/workflows/stargate-deploy/verify-protected-production-dispatch.sh"}
	"stargate-deploy-verify-release-provenance": #Script & {_script: "tools/workflows/stargate-deploy/verify-release-provenance.sh"}
	"stargate-deploy-configure-pinned-ssh-identity": #Script & {_script: "tools/workflows/stargate-deploy/configure-pinned-ssh-identity.sh", _production: true}
	"stargate-deploy-read-host-deployment-plan": #Script & {_script: "tools/workflows/stargate-deploy/read-host-deployment-plan.sh", _production: true}
	"stargate-deploy-download-and-verify-release": #Script & {_script: "tools/workflows/stargate-deploy/download-and-verify-release.sh"}
	"stargate-deploy-recheck-sole-operator-mutation-window": #Script & {_script: "tools/workflows/stargate-deploy/recheck-sole-operator-mutation-window.sh"}
	"stargate-deploy-apply-release": #Script & {_script: "tools/workflows/stargate-deploy/apply-release.sh", _production: true}
	"stargate-deploy-roll-back-release": #Script & {_script: "tools/workflows/stargate-deploy/roll-back-release.sh", _production: true}
	"stargate-deploy-verify-public-routing": #Script & {_script: "tools/workflows/stargate-deploy/verify-public-routing.sh"}
	"stargate-deploy-restore-prior-release": #Script & {_script: "tools/workflows/stargate-deploy/restore-prior-release.sh", _production: true}
	"stargate-deploy-read-final-host-state": #Script & {_script: "tools/workflows/stargate-deploy/read-final-host-state.sh", _production: true}
}
