#!/usr/bin/env bash
set -euo pipefail

module="${1:?module id required}"
printf 'prepare canonical checkpoint for module %s\n' "$module"
