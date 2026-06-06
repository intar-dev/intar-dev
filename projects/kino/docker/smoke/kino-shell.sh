#!/bin/sh
set -eu

config_path="/etc/kino/ssh-recording.hcl"

if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    exec /usr/local/bin/kino record-ssh --config "${config_path}" --command "${SSH_ORIGINAL_COMMAND}"
  fi
  exec /usr/local/bin/kino record-command --config "${config_path}" --command "${SSH_ORIGINAL_COMMAND}"
fi

if [ "${1:-}" = "-c" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    exec /usr/local/bin/kino record-ssh --config "${config_path}" --command "${2:-}"
  fi
  exec /usr/local/bin/kino record-command --config "${config_path}" --command "${2:-}"
fi

exec /usr/local/bin/kino record-ssh --config "${config_path}"
