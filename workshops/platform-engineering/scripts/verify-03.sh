#!/usr/bin/env bash
set -uo pipefail
verifier=/opt/platform-engineering-workshop/lab/03-data/verify.sh
set +e
output="$(${verifier} 2>&1)"
status=$?
set -e
printf '%s\n' "${output}"
if (( status == 0 )); then
  rustfs_aws() {
    docker run --rm --network host -i \
      -e AWS_ACCESS_KEY_ID=cloudbox \
      -e AWS_SECRET_ACCESS_KEY=cloudbox123 \
      -e AWS_REGION=us-east-1 \
      -e AWS_PAGER= \
      "public.ecr.aws/aws-cli/aws-cli@sha256:bad3346a39098ab077be6ed58c7e1fe68321a4a844c7c740318100013e6c3581" \
      --endpoint-url http://localhost:30900 "$@"
  }

  if ! rustfs_object_key="$(rustfs_aws s3api list-objects-v2 \
    --bucket app-assets \
    --max-items 1 \
    --query 'Contents[0].Key' \
    --output text)"; then
    printf 'RustFS could not list an object for presigned-download verification\n' >&2
    status=1
  elif [[ -z "${rustfs_object_key}" ||
          "${rustfs_object_key}" == "None" ||
          "${rustfs_object_key}" == *$'\n'* ]]; then
    printf 'RustFS returned no deterministic object key for presigned-download verification\n' >&2
    status=1
  elif ! rustfs_presigned_url="$(rustfs_aws s3 presign \
    "s3://app-assets/${rustfs_object_key}" \
    --expires-in 300)"; then
    printf 'RustFS could not generate a presigned download URL\n' >&2
    status=1
  elif [[ "${rustfs_presigned_url}" != http://localhost:30900/* ||
          "${rustfs_presigned_url}" == *" "* ||
          "${rustfs_presigned_url}" == *$'\t'* ||
          "${rustfs_presigned_url}" == *$'\n'* ]]; then
    printf 'RustFS generated an unsafe or non-local presigned URL\n' >&2
    status=1
  elif ! curl -fsS --max-time 15 --output /dev/null \
    "${rustfs_presigned_url}"; then
    printf 'RustFS presigned download failed inside the learner VM\n' >&2
    status=1
  fi
fi

if (( status == 0 )); then
  public_host=wa-workshop-probe.intar.app
  if ! rustfs_probe_dir="$(mktemp -d)"; then
    printf 'could not create temporary directory for RustFS workspace-app probe\n' >&2
    status=1
  else
    rustfs_console_body="${rustfs_probe_dir}/console.html"
    rustfs_console_headers="${rustfs_probe_dir}/console.headers"
    rustfs_asset_body="${rustfs_probe_dir}/asset"
    cleanup_rustfs_probe() {
      rm -f \
        "${rustfs_console_body}" \
        "${rustfs_console_headers}" \
        "${rustfs_asset_body}"
      rmdir "${rustfs_probe_dir}" 2>/dev/null || true
    }
    trap cleanup_rustfs_probe EXIT

    rustfs_forwarded_curl() {
      curl -sS --max-time 15 \
        -H 'User-Agent: Mozilla/5.0 (compatible; Intar-Workspace-App-Probe/1.0)' \
        -H "Host: ${public_host}" \
        -H "X-Forwarded-Host: ${public_host}" \
        -H 'X-Forwarded-Proto: https' \
        -H 'X-Forwarded-Port: 443' \
        "$@"
    }

    rustfs_console_path=/
    if ! rustfs_console_meta="$(rustfs_forwarded_curl \
      --dump-header "${rustfs_console_headers}" \
      --output "${rustfs_console_body}" \
      --write-out '%{http_code}\n%{content_type}' \
      http://localhost:30901/)"; then
      printf 'RustFS console is not reachable on declared workspace-app port 30901\n' >&2
      status=1
    else
      rustfs_console_status="${rustfs_console_meta%%$'\n'*}"
      rustfs_console_type="${rustfs_console_meta#*$'\n'}"
      if [[ "${rustfs_console_status}" == 3* ]]; then
        rustfs_redirect_location="$(
          awk '
            tolower(substr($0, 1, 9)) == "location:" {
              count += 1
              sub(/^[^:]*:[[:space:]]*/, "")
              sub(/[[:space:]]+$/, "")
              location = $0
            }
            END {
              if (count == 1) print location
            }
          ' "${rustfs_console_headers}"
        )"
        if [[ -z "${rustfs_redirect_location}" ||
              "${rustfs_redirect_location}" == *" "* ||
              "${rustfs_redirect_location}" == *$'\t'* ||
              "${rustfs_redirect_location}" == *\\* ]]; then
          printf 'RustFS console returned an unsafe, missing, or duplicate redirect location\n' >&2
          status=1
        elif [[ "${rustfs_redirect_location}" == "https://${public_host}" ]]; then
          rustfs_console_path=/
        elif [[ "${rustfs_redirect_location}" == "https://${public_host}/"* ]]; then
          rustfs_console_path="/${rustfs_redirect_location#https://${public_host}/}"
        elif [[ "${rustfs_redirect_location}" == "//${public_host}" ]]; then
          rustfs_console_path=/
        elif [[ "${rustfs_redirect_location}" == "//${public_host}/"* ]]; then
          rustfs_console_path="/${rustfs_redirect_location#//${public_host}/}"
        elif [[ "${rustfs_redirect_location}" == //* ||
                "${rustfs_redirect_location}" == http://* ||
                "${rustfs_redirect_location}" == https://* ||
                "${rustfs_redirect_location}" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ]]; then
          printf 'RustFS console referenced a cross-origin redirect: %s\n' \
            "${rustfs_redirect_location}" >&2
          status=1
        elif [[ "${rustfs_redirect_location}" == /* ]]; then
          rustfs_console_path="${rustfs_redirect_location}"
        else
          rustfs_console_path="/${rustfs_redirect_location#./}"
        fi

        if (( status == 0 )); then
          if ! rustfs_console_meta="$(rustfs_forwarded_curl \
            --output "${rustfs_console_body}" \
            --write-out '%{http_code}\n%{content_type}' \
            "http://localhost:30901${rustfs_console_path}")"; then
            printf 'RustFS console redirect target is not reachable through workspace-app headers\n' >&2
            status=1
          else
            rustfs_console_status="${rustfs_console_meta%%$'\n'*}"
            rustfs_console_type="${rustfs_console_meta#*$'\n'}"
            if [[ "${rustfs_console_status}" != 2* ]]; then
              printf 'RustFS console redirect target returned HTTP %s instead of 2xx\n' \
                "${rustfs_console_status}" >&2
              status=1
            fi
          fi
        fi
      elif [[ "${rustfs_console_status}" != 2* ]]; then
        printf 'RustFS console returned HTTP %s instead of 2xx or a safe same-origin redirect\n' \
          "${rustfs_console_status}" >&2
        status=1
      fi
    fi

    if (( status == 0 )); then
      if [[ ! -s "${rustfs_console_body}" ]] ||
         ! grep -Eiq '<(!doctype[[:space:]]+html|html)([[:space:]>])' \
           "${rustfs_console_body}" ||
         [[ "${rustfs_console_type,,}" != text/html* ]]; then
        printf 'RustFS console did not return non-empty HTML (content-type: %s)\n' \
          "${rustfs_console_type:-missing}" >&2
        status=1
      fi
    fi

    if (( status == 0 )); then
      rustfs_asset_ref="$(
        sed -nE \
          "s@.*(src|href)[[:space:]]*=[[:space:]]*['\"]([^'\"]+\\.(js|css)(\\?[^'\"]*)?)['\"].*@\\2@p" \
          "${rustfs_console_body}" |
          sed -n '1p'
      )"
      if [[ -z "${rustfs_asset_ref}" ]]; then
        printf 'RustFS console HTML did not reference a JavaScript or CSS asset\n' >&2
        status=1
      elif [[ "${rustfs_asset_ref}" == "https://${public_host}/"* ]]; then
        rustfs_asset_path="/${rustfs_asset_ref#https://${public_host}/}"
      elif [[ "${rustfs_asset_ref}" == "//${public_host}/"* ]]; then
        rustfs_asset_path="/${rustfs_asset_ref#//${public_host}/}"
      elif [[ "${rustfs_asset_ref}" == http://* ||
              "${rustfs_asset_ref}" == https://* ||
              "${rustfs_asset_ref}" == //* ||
              "${rustfs_asset_ref}" =~ ^[A-Za-z][A-Za-z0-9+.-]*: ||
              "${rustfs_asset_ref}" == *" "* ||
              "${rustfs_asset_ref}" == *$'\t'* ||
              "${rustfs_asset_ref}" == *\\* ]]; then
        printf 'RustFS console referenced a cross-origin asset: %s\n' \
          "${rustfs_asset_ref}" >&2
        status=1
      elif [[ "${rustfs_asset_ref}" == /* ]]; then
        rustfs_asset_path="${rustfs_asset_ref}"
      else
        rustfs_console_file_path="${rustfs_console_path%%[?#]*}"
        rustfs_console_dir="${rustfs_console_file_path%/*}/"
        rustfs_asset_path="${rustfs_console_dir}${rustfs_asset_ref#./}"
      fi
    fi

    if (( status == 0 )); then
      if ! rustfs_asset_meta="$(rustfs_forwarded_curl \
        --output "${rustfs_asset_body}" \
        --write-out '%{http_code}\n%{content_type}' \
        "http://localhost:30901${rustfs_asset_path}")"; then
        printf 'RustFS console asset is not reachable through the workspace-app headers: %s\n' \
          "${rustfs_asset_ref}" >&2
        status=1
      else
        rustfs_asset_status="${rustfs_asset_meta%%$'\n'*}"
        rustfs_asset_type="${rustfs_asset_meta#*$'\n'}"
        if [[ "${rustfs_asset_status}" != 2* ]]; then
          printf 'RustFS console asset returned HTTP %s: %s\n' \
            "${rustfs_asset_status}" "${rustfs_asset_ref}" >&2
          status=1
        elif [[ ! -s "${rustfs_asset_body}" ||
                "${rustfs_asset_type,,}" == text/html* ]]; then
          printf 'RustFS console asset is empty or returned HTML (content-type: %s): %s\n' \
            "${rustfs_asset_type:-missing}" "${rustfs_asset_ref}" >&2
          status=1
        fi
      fi
    fi

    cleanup_rustfs_probe
    trap - EXIT
  fi
fi
if (( status == 0 )); then
  printf 'INTAR_PROBE module-03-data-services-ready pass\n'
else
  printf 'INTAR_PROBE module-03-data-services-ready fail\n'
  last_failure="$(
    awk '/FAIL:/{ line=$0 } END{ print line }' <<<"${output}"
  )"
  if [[ -n "${last_failure}" ]]; then
    last_failure="${last_failure#*FAIL: }"
    printf 'INTAR_FAIL %.72s\n' "${last_failure}" >&2
  fi
fi
exit "${status}"
