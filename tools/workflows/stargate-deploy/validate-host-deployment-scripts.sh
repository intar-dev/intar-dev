#!/usr/bin/env bash
# stargate-deploy workflow, job preflight, step "Validate host deployment scripts".
test -x deploy/stargate/scripts/intar-deploy-stargate
test -x deploy/stargate/scripts/bootstrap-deploy-user
bash -n deploy/stargate/scripts/intar-deploy-stargate
bash -n deploy/stargate/scripts/bootstrap-deploy-user
bash -n tools/deploy/configure-stargate-ssh.sh
