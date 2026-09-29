#!/usr/bin/env bash
# stargate-deploy workflow, job deploy, step "Verify protected production dispatch".
set -euo pipefail
test "${GITHUB_REF}" = refs/heads/main
test "${GITHUB_SHA}" = "$(git rev-parse HEAD)"
test "${DEPLOY_HOST}" = intar.app
test "${DEPLOY_PORT}" = 2222
test "${DEPLOY_USER}" = stargate-deploy
test "${GITHUB_REPOSITORY}" = intar-dev/intar-dev

environment_json="$(gh api "repos/${GITHUB_REPOSITORY}/environments/production")"
case "${APPROVAL_MODE}" in
  reviewed)
    test -z "${SINGLE_OPERATOR_CONFIRMATION}"
    jq -e '
      .can_admins_bypass == false and
      any(
        .protection_rules[]?;
          .type == "required_reviewers" and
          .prevent_self_review == true and
          ((.reviewers // []) | length) > 0
      )
    ' <<<"${environment_json}" >/dev/null
    ;;
  single-operator)
    test "${SINGLE_OPERATOR_CONFIRMATION}" = "SINGLE OPERATOR STARGATE"
    test -n "${SINGLE_OPERATOR_LOGIN}"
    [[ "${SINGLE_OPERATOR_LOGIN}" =~ ^[A-Za-z0-9-]{1,39}$ ]]
    [[ "${SINGLE_OPERATOR_LOGIN}" != -* ]]
    [[ "${SINGLE_OPERATOR_LOGIN}" != *- ]]
    [[ "${SINGLE_OPERATOR_ID}" =~ ^[0-9]+$ ]]
    [[ "${SINGLE_OPERATOR_EXPIRES_AT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
    [[ "${SINGLE_OPERATOR_ADMIN_ATTESTED_AT}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]
    test "${GITHUB_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"
    test "${GITHUB_TRIGGERING_ACTOR}" = "${SINGLE_OPERATOR_LOGIN}"
    test "${ACTOR_ID}" = "${SINGLE_OPERATOR_ID}"
    test "${RUN_ATTEMPT}" = 1
    triggering_actor_json="$(gh api "users/${GITHUB_TRIGGERING_ACTOR}")"
    jq -e \
      --arg login "${SINGLE_OPERATOR_LOGIN}" \
      --arg id "${SINGLE_OPERATOR_ID}" '
        .type == "User" and
        .login == $login and
        ((.id | tostring) == $id)
      ' <<<"${triggering_actor_json}" >/dev/null
    jq -e '
      ([.protection_rules[]? | select(.type == "required_reviewers")] | length) == 0
    ' <<<"${environment_json}" >/dev/null
    now_epoch="$(date -u +%s)"
    expires_epoch="$(date -u -d "${SINGLE_OPERATOR_EXPIRES_AT}" +%s)"
    attested_epoch="$(date -u -d "${SINGLE_OPERATOR_ADMIN_ATTESTED_AT}" +%s)"
    remaining_seconds="$((expires_epoch - now_epoch))"
    attestation_age="$((now_epoch - attested_epoch))"
    test "${remaining_seconds}" -gt 0
    test "${remaining_seconds}" -le 604800
    test "${attestation_age}" -ge 0
    test "${attestation_age}" -le 900
    printf 'single_operator_expires_at=%s remaining_seconds=%s admin_attestation_age=%s\n' \
      "${SINGLE_OPERATOR_EXPIRES_AT}" "${remaining_seconds}" \
      "${attestation_age}"
    ;;
  *)
    printf 'Unsupported Stargate approval mode: %s\n' \
      "${APPROVAL_MODE:-<unset>}" >&2
    exit 1
    ;;
esac
printf 'approval_mode=%s actor=%s\n' "${APPROVAL_MODE}" "${GITHUB_ACTOR}" |
  tee -a "${GITHUB_STEP_SUMMARY}"

branch_policies="$(gh api "repos/${GITHUB_REPOSITORY}/environments/production/deployment-branch-policies")"
jq -e '
  (.branch_policies // .) as $policies |
  ($policies | length) == 1 and
  $policies[0].type == "branch" and
  $policies[0].name == "main"
' <<<"${branch_policies}" >/dev/null
