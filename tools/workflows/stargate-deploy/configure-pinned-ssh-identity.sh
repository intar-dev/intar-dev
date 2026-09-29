#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Configure pinned SSH identity".
set -euo pipefail
config="$(tools/deploy/configure-stargate-ssh.sh "${RUNNER_TEMP}/intar-ssh")"
test "${config}" = "${RUNNER_TEMP}/intar-ssh/config"
