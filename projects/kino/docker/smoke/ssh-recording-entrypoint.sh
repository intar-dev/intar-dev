#!/bin/sh
set -eu

pubkey_path="/smoke/id_ed25519.pub"
auth_keys="/home/user/.ssh/authorized_keys"

if [ ! -f "${pubkey_path}" ]; then
  echo "missing mounted ssh public key: ${pubkey_path}" >&2
  exit 1
fi

mkdir -p /run/sshd /recordings
chmod 0777 /recordings || true
install -m 0600 -o user -g user "${pubkey_path}" "${auth_keys}"

if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -N '' -t ed25519 -f /etc/ssh/ssh_host_ed25519_key
fi

exec /usr/sbin/sshd -D -e
