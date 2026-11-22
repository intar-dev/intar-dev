#!/usr/bin/env bash
# Run once by the owner, on their Mac: sets up what release.yml signs the
# desktop app with (build-jumper-macos.sh) until there is a Developer ID.
#
#   1. A self-signed code-signing certificate, "Intar Signing", valid for ten
#      years, as a .p12 with a random password, in ~/.intar-signing (or
#      INTAR_SIGNING_DIR), never in the repository. An existing one is reused:
#      a new certificate is a new identity, and every user's keychain asks
#      again.
#   2. The macos-signing environment, deployable from main only, with
#      MACOS_CERT_P12_BASE64 and MACOS_CERT_PASSWORD.
#   3. The identity in the login keychain, so local builds sign as the
#      releases do: SIGN_IDENTITY="Intar Signing" build-jumper-macos.sh.
#
# Back up the folder: losing it costs every user one more keychain prompt.
set -euo pipefail
[ "$(uname -s)" = "Darwin" ] || { echo "Run this on the Mac that keeps the certificate." >&2; exit 1; }
repo="${REPO:-intar-dev/intar-dev}"
environment="macos-signing"
name="Intar Signing"
folder="${INTAR_SIGNING_DIR:-${HOME}/.intar-signing}"
p12="${folder}/intar-signing.p12"
password_file="${folder}/intar-signing.password"
gh auth status > /dev/null

if [ -f "${p12}" ]; then
  [ -f "${password_file}" ] || { echo "${p12} exists without ${password_file}; put its password there." >&2; exit 1; }
  echo "Reusing the certificate in ${folder}."
else
  mkdir -p "${folder}"
  chmod 700 "${folder}"
  work="$(mktemp -d "${folder}/new.XXXXXX")"
  trap 'rm -rf "${work}"' EXIT
  cat > "${work}/request.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = ${name}
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
  # macOS's own openssl (LibreSSL): its .p12 is one `security import` reads.
  /usr/bin/openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -config "${work}/request.cnf" \
    -keyout "${work}/key.pem" -out "${work}/certificate.pem" 2> /dev/null
  /usr/bin/openssl rand -hex 24 > "${work}/password"
  /usr/bin/openssl pkcs12 -export -name "${name}" -inkey "${work}/key.pem" -in "${work}/certificate.pem" \
    -out "${work}/intar-signing.p12" -passout "file:${work}/password"
  (umask 077 && mv "${work}/intar-signing.p12" "${p12}" && mv "${work}/password" "${password_file}")
  echo "Created the certificate in ${folder}."
fi
chmod 600 "${p12}" "${password_file}"

gh api -X PUT "repos/${repo}/environments/${environment}" --input - > /dev/null <<'JSON'
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
if ! gh api "repos/${repo}/environments/${environment}/deployment-branch-policies" --jq '.branch_policies[].name' | grep -qx main; then
  gh api -X POST "repos/${repo}/environments/${environment}/deployment-branch-policies" -f name=main -f type=branch > /dev/null
fi
base64 -i "${p12}" | gh secret set MACOS_CERT_P12_BASE64 --repo "${repo}" --env "${environment}"
tr -d '\n' < "${password_file}" | gh secret set MACOS_CERT_PASSWORD --repo "${repo}" --env "${environment}"
echo "Set MACOS_CERT_P12_BASE64 and MACOS_CERT_PASSWORD in ${repo}'s ${environment} environment (main only)."

if security find-identity -p codesigning | grep -q "\"${name}\""; then
  echo "\"${name}\" is already in your keychain."
else
  security import "${p12}" -k "${HOME}/Library/Keychains/login.keychain-db" -f pkcs12 \
    -P "$(tr -d '\n' < "${password_file}")" -T /usr/bin/codesign > /dev/null
  echo "Imported \"${name}\" into your login keychain."
fi
echo "Local builds: SIGN_IDENTITY=\"${name}\" tools/workflows/release/build-jumper-macos.sh"
echo "Back up ${folder}, for example in your password manager."
