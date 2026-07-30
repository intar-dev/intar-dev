#!/usr/bin/env bash
# =============================================================================
# Shared helpers for CloudBox workshop scripts.
#
# Usage (from any script in scripts/):
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "${SCRIPT_DIR}/lib.sh"
#
# Provides: logging, command guards, rollout waits, Docker readiness,
# Gitea authentication, and sources versions.env so every pin is available as a variable.
# =============================================================================

# Guard against direct execution — this file is meant to be sourced.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "lib.sh is a library; source it from another script." >&2
  exit 1
fi

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${LIB_DIR}/.." && pwd)"
export REPO_ROOT

# shellcheck source=versions.env
source "${LIB_DIR}/versions.env"

# --- Logging -----------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'
  C_BLUE=$'\033[0;34m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""; C_RESET=""
fi

ok()   { echo "${C_GREEN}✅ $*${C_RESET}"; }
fail() { echo "${C_RED}❌ $*${C_RESET}"; }
warn() { echo "${C_YELLOW}⚠️  $*${C_RESET}"; }
info() { echo "${C_BLUE}ℹ️  $*${C_RESET}"; }
step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
die()  { fail "$@"; exit 1; }

# --- Small utilities -----------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# need <cmd> [hint] — die with a friendly message if a tool is missing.
need() {
  have "$1" || die "'$1' not found. ${2:-request a checkpoint-00 restore; do not install an unpinned replacement.}"
}

# Talos v1.13.6 can return Unavailable/EOF either while its ten-minute API
# readiness loop is ending (before it prints "bootstrapping cluster") or from
# the Bootstrap RPC itself. Match the complete cluster-create phase sequence;
# every other Talos error still fails closed.
is_initial_talos_bootstrap_unavailable_eof() {
  local message="${1:-}"
  [[ "${message}" == *"creating controlplane nodes"*"creating worker nodes"*"waiting for Talos API (to bootstrap the cluster)"*"bootstrap error:"*"code = Unavailable"*"authentication handshake failed: EOF"* ]]
}

# The direct retry command has a different stable error prefix. Keep it
# separate from initial create classification and fail closed on every other
# Talos error, including unrelated Unavailable responses.
is_retry_talos_bootstrap_unavailable_eof() {
  local message="${1:-}"
  [[ "${message}" == *"error executing bootstrap:"*"code = Unavailable"*"authentication handshake failed: EOF"* ]]
}

# GNU timeout reports 124 for its normal deadline and 137 when the requested
# KILL signal terminates the command. Either can mean the bootstrap request
# reached the node before the client was killed, so retry until the outer
# recovery deadline and let an exact AlreadyExists response resolve ambiguity.
is_retryable_talos_bootstrap_timeout_status() {
  local status="${1:-0}"
  (( status == 124 || status == 137 ))
}

# A bootstrap reply can be lost after etcd was initialized. This result is only
# provisional: callers must still prove kubeconfig and Kubernetes API health.
is_provisional_talos_bootstrap_already_exists() {
  local message="${1:-}"
  [[ "${message}" == *"error executing bootstrap:"*"code = AlreadyExists"*"etcd data directory is not empty"* ]]
}

# Redact credentials before any Talos log line reaches CI output. This covers
# JSON/YAML key-value forms, HTTP auth, URL credentials, and Kubernetes-style
# bootstrap tokens while retaining enough surrounding error text to diagnose.
redact_talos_diagnostic_line() {
  sed -E \
    -e 's#(https?://)[^/@[:space:]]+@#\1[REDACTED]@#g' \
    -e 's/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/Ig' \
    -e 's/([?&](api_key|access_token|refresh_token|key|password|passwd|secret|token)=)[^&[:space:]#]+/\1[REDACTED]/Ig' \
    -e 's/("(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|client[_ -]?secret|password|passwd|private[_ -]?key|secret|token)"[[:space:]]*[:=][[:space:]]*)"[^"]*"/\1"[REDACTED]"/Ig' \
    -e 's/(Authorization[[:space:]]*[:=][[:space:]]*).*/\1[REDACTED]/Ig' \
    -e 's/((api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|client[_ -]?secret|password|passwd|private[_ -]?key|secret|token)[[:space:]]*[:=][[:space:]]*)"[^"]*"/\1"[REDACTED]"/Ig' \
    -e 's/("(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|client[_ -]?secret|password|passwd|private[_ -]?key|secret|token)"[[:space:]]*[:=][[:space:]]*)[^",;[:space:]}]+/\1[REDACTED]/Ig' \
    -e 's/((api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|client[_ -]?secret|password|passwd|private[_ -]?key|secret|token)[[:space:]]*[:=][[:space:]]*)[^",;[:space:]}]+/\1[REDACTED]/Ig' \
    -e 's/(^|[^A-Za-z0-9])[A-Za-z0-9]{6}\.[A-Za-z0-9]{16}([^A-Za-z0-9]|$)/\1[REDACTED]\2/g' \
    -e 's/[A-Za-z0-9_+\/=-]{32,}/[REDACTED]/g'
}

# wait_rollout <ns> <kind/name> [timeout-seconds] — a robust rollout wait for the
# bootstrap path. A single `kubectl rollout status --timeout` fails HARD the
# moment a cold cluster's first image pull or a scheduling delay overruns the
# clock (the recurring "timed out waiting for the condition" flake). This wraps
# it with a generous default timeout and ONE retry — a slow first pull almost
# always succeeds on the second attempt — and, only on a genuine final failure,
# dumps the namespace's pod status + recent events so it's debuggable instead of
# a bare timeout. Idempotent and safe for attendees, not just CI.
wait_rollout() {
  local ns="$1" obj="$2" timeout="${3:-300}" attempt
  for attempt in 1 2; do
    if kubectl -n "$ns" rollout status "$obj" --timeout="${timeout}s"; then
      return 0
    fi
    warn "rollout ${ns}/${obj} not ready after ${timeout}s (attempt ${attempt}/2) — retrying"
  done
  fail "rollout ${ns}/${obj} never became ready — recent state:"
  kubectl -n "$ns" get pods -o wide 2>/dev/null || true
  kubectl -n "$ns" get events --sort-by=.lastTimestamp 2>/dev/null | tail -20 || true
  return 1
}

# confirm "question" — interactive yes/no, defaults to no. Returns 0 on yes.
confirm() {
  local answer
  read -r -p "$1 [y/N] " answer
  [[ "${answer}" == "y" || "${answer}" == "Y" ]]
}

# detect_arch — prints amd64 or arm64, fails on anything else.
detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64" ;;
    arm64|aarch64) echo "arm64" ;;
    *) return 1 ;;
  esac
}

# is_wsl2 — true when running inside Windows Subsystem for Linux.
is_wsl2() {
  [[ -f /proc/version ]] && grep -qi microsoft /proc/version
}

docker_running() {
  have docker && docker info >/dev/null 2>&1
}

# git_as_gitea_admin <git args...> — run git authenticating as the Gitea admin
# via GIT_ASKPASS instead of credentials embedded in the URL, so they stay out
# of process arguments and error output. (Workshop-grade creds, but URLs with
# passwords also break when the password ever needs URL-encoding.)
git_as_gitea_admin() {
  local askpass rc=0
  askpass="$(mktemp)"
  # shellcheck disable=SC2016  # $1 is for the generated script, not this shell
  printf '#!/bin/sh\ncase "$1" in\n  Username*) echo "%s" ;;\n  *) echo "%s" ;;\nesac\n' \
    "${GITEA_ADMIN_USER}" "${GITEA_ADMIN_PASSWORD}" > "${askpass}"
  chmod 700 "${askpass}"
  GIT_ASKPASS="${askpass}" GIT_TERMINAL_PROMPT=0 git "$@" || rc=$?
  rm -f "${askpass}"
  return "${rc}"
}
