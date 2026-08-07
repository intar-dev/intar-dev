#!/usr/bin/env bash
set -euo pipefail
umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: tools/deploy/configure-stargate-ssh.sh <output-directory>" >&2
  exit 64
fi

readonly output_directory="$1"
readonly private_key="${output_directory}/id_ed25519"
readonly known_hosts="${output_directory}/known_hosts"
readonly config="${output_directory}/config"

[[ "${output_directory}" = /* ]]
test "${STARGATE_DEPLOY_HOST:-}" = "intar.app"
test "${STARGATE_DEPLOY_PORT:-}" = "2222"
test "${STARGATE_DEPLOY_USER:-}" = "stargate-deploy"
test -n "${STARGATE_DEPLOY_SSH_PRIVATE_KEY:-}"
test -n "${STARGATE_DEPLOY_KNOWN_HOSTS:-}"

test ! -L "${output_directory}"
install -d -m 0700 "${output_directory}"
test ! -L "${output_directory}"
test ! -e "${private_key}"
test ! -L "${private_key}"
test ! -e "${known_hosts}"
test ! -L "${known_hosts}"
test ! -e "${config}"
test ! -L "${config}"
install -m 0600 /dev/null "${private_key}"
install -m 0600 /dev/null "${known_hosts}"
printf '%s\n' "${STARGATE_DEPLOY_SSH_PRIVATE_KEY}" > "${private_key}"
printf '%s\n' "${STARGATE_DEPLOY_KNOWN_HOSTS}" > "${known_hosts}"

public_key="$(ssh-keygen -y -P '' -f "${private_key}")"
[[ "${public_key}" = ssh-ed25519\ * ]]
test "$(grep -cve '^[[:space:]]*$' "${known_hosts}")" -eq 1
awk '
  NF == 3 &&
  $1 == "[intar.app]:2222" &&
  $2 == "ssh-ed25519" &&
  $3 ~ /^[A-Za-z0-9+\/=]+$/ { matches += 1 }
  END { exit(matches == 1 ? 0 : 1) }
' "${known_hosts}"

install -m 0600 /dev/null "${config}"
cat > "${config}" <<EOF_SSH
Host intar-stargate-production
  HostName ${STARGATE_DEPLOY_HOST}
  Port ${STARGATE_DEPLOY_PORT}
  User ${STARGATE_DEPLOY_USER}
  IdentityFile ${private_key}
  UserKnownHostsFile ${known_hosts}
  BatchMode yes
  IdentitiesOnly yes
  StrictHostKeyChecking yes
  HostKeyAlgorithms ssh-ed25519
  PubkeyAcceptedAlgorithms ssh-ed25519
  ConnectTimeout 10
  ServerAliveInterval 15
  ServerAliveCountMax 3
  ClearAllForwardings yes
  RequestTTY no
EOF_SSH
chmod 0600 "${config}"

printf '%s\n' "${config}"
