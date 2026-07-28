#!/usr/bin/env bash
# Trusted checkpoint reconstruction adapted from pinned module 10.
# Canonical answer for attendees and the CI inject -> solve -> verify regression.
# Unlike module 05, solving this lab means reverting whatever is injected now;
# solve.sh must not inject a scenario of its own first.
set -euo pipefail

DIR="/opt/platform-engineering-workshop/lab/10-day2-ops"

exec "$DIR/restore.sh" all
