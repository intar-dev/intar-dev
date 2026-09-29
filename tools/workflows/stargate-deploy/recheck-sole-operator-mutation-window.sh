#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Recheck sole-operator mutation window".
set -euo pipefail
case "${APPROVAL_MODE}" in
  reviewed)
    ;;
  single-operator)
    now_epoch="$(date -u +%s)"
    expires_epoch="$(date -u -d "${SINGLE_OPERATOR_EXPIRES_AT}" +%s)"
    attested_epoch="$(date -u -d "${SINGLE_OPERATOR_ADMIN_ATTESTED_AT}" +%s)"
    remaining_seconds="$((expires_epoch - now_epoch))"
    attestation_age="$((now_epoch - attested_epoch))"
    test "${remaining_seconds}" -gt 0
    test "${remaining_seconds}" -le 604800
    test "${attestation_age}" -ge 0
    test "${attestation_age}" -le 900
    ;;
  *)
    printf 'Unsupported Stargate approval mode: %s\n' \
      "${APPROVAL_MODE:-<unset>}" >&2
    exit 1
    ;;
esac
