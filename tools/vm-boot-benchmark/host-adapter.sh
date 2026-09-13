#!/usr/bin/env bash
# Host adapter for the fresh VM boot benchmark campaign.
#
# This program is the trusted bridge between the campaign driver and one
# isolated scenario host. It reads evidence from the host; it never creates,
# stops, or changes a VM, a service, or a deployment on that host.
#
# Every verb runs its program on the host through ssh, so every host fact comes
# from the host. The driver calls it with fixed verbs, and every value the
# driver sends is validated here before it reaches ssh.
#
# Usage:
#   host-adapter.sh --host <ssh-target> [--attestation-file <path>] \
#     [--agent-unit <unit>] [--agent-url <url>] \
#     <verb> [verb arguments] --output <path>
#
# Verbs:
#   attest                                  read the host identity and isolation proof
#   pressure-capture                        read host PSI
#   cgroup-capture --run-id ID --expected-vm-count N --wait-seconds S
#                                           read the run cgroup counters
#   workload-events --start-unix-ms A --end-unix-ms B
#                                           read background workload intervals
#   agent-events --run-id ID                read the agent boot timings
#
# Exit codes: 0 success, 2 usage or validation error, 3 unsupported verb,
# 4 the host refused or the evidence is not trustworthy.
#
# Every host fact is read on the host. No environment variable can redirect a
# remote program at run time: the attestation program takes its inputs as
# arguments and reads that host's own kernel files and local agent.

set -Eeuo pipefail

readonly UNSUPPORTED_EXIT=3
readonly REFUSED_EXIT=4
readonly SSH_BIN="$(command -v ssh || true)"
readonly ADAPTER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${ADAPTER_DIR}/../.." && pwd)"
readonly TOOL_SOURCE="${REPO_ROOT}/tools/vm-boot-benchmark.py"
readonly WORKLOAD_SOURCE="${ADAPTER_DIR}/workload-events.py"
readonly ATTESTATION_SOURCE="${ADAPTER_DIR}/host-attestation.py"

log() {
  printf 'host-adapter: %s\n' "$*" >&2
}

fail() {
  log "$*"
  exit "${2:-2}"
}

host_target=""
attestation_file="/etc/intar-benchmark/attestation.json"
agent_unit="intar-agent"
agent_url="http://127.0.0.1:8080"
verb=""
output=""
declare -a verb_args=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) host_target="${2:-}"; shift 2 ;;
    --attestation-file) attestation_file="${2:-}"; shift 2 ;;
    --agent-unit) agent_unit="${2:-}"; shift 2 ;;
    --agent-url) agent_url="${2:-}"; shift 2 ;;
    --help) sed -n '4,23p' "${BASH_SOURCE[0]}" >&2; exit 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    attest|pressure-capture|cgroup-capture|workload-events|agent-events)
      verb="$1"; shift ;;
    --run-id|--expected-vm-count|--wait-seconds|--start-unix-ms|--end-unix-ms)
      verb_args+=("$1" "${2:-}"); shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$host_target" ] || fail "--host is required"
[ -n "$verb" ] || fail "a verb is required"
[ -n "$output" ] || fail "--output is required"

# Reject a leading dash so a value can never be read as an ssh option, and
# reject whitespace so a value always stays one argument.
for value in "$host_target" "$attestation_file" "$agent_unit" "$agent_url"; do
  [ -n "$value" ] || fail "an adapter value is empty"
  case "$value" in
    -*) fail "an adapter value must not start with a dash: $value" ;;
    *[!A-Za-z0-9._@:/=-]*) fail "an adapter value has unsupported characters: $value" ;;
  esac
done
case "$verb" in
  -*) fail "the verb must not start with a dash" ;;
esac

# ssh joins its arguments into one command string for the remote shell, so
# every value is both validated here and shell-quoted below.
validate_verb_args() {
  local value
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --run-id)
        value="${2:-}"
        [ -n "$value" ] || fail "--run-id needs a value"
        [ "${#value}" -le 128 ] || fail "--run-id is too long"
        case "$value" in
          *[!A-Za-z0-9._:-]*) fail "--run-id has unsupported characters" ;;
        esac
        shift 2
        ;;
      --expected-vm-count|--wait-seconds|--start-unix-ms|--end-unix-ms)
        value="${2:-}"
        case "$value" in
          ''|*[!0-9]*) fail "$1 must be a non-negative integer" ;;
        esac
        [ "${#value}" -le 15 ] || fail "$1 is too large"
        shift 2
        ;;
      *)
        fail "unsupported verb argument: $1"
        ;;
    esac
  done
}

if [ "${#verb_args[@]}" -gt 0 ]; then
  validate_verb_args "${verb_args[@]}"
fi

# Quote one remote argument so the remote shell reads it as data.
quote_remote() {
  local quoted=""
  local argument
  for argument in "$@"; do
    quoted="${quoted} $(printf '%q' "$argument")"
  done
  printf '%s' "${quoted# }"
}

ssh_run() {
  # BatchMode: never prompt. The operator owns the key and the known_hosts
  # entry, so a changed host identity stops this step.
  "$SSH_BIN" -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
    -- "$host_target" "$@"
}

write_output() {
  local destination="$1"
  mkdir -p "$(dirname "$destination")"
  cat >"$destination"
}

# The remote program arrives on stdin, so the host needs nothing installed.
# Every argument is quoted for the remote shell.
run_remote_script() {
  local source="$1"
  local quoted=""
  shift
  if [ "$#" -gt 0 ]; then
    # No "--" separator: argparse in the remote program would read it as the
    # end of the options. Every value is validated and quoted instead.
    quoted=" $(quote_remote "$@")"
  fi
  ssh_run "python3 -${quoted}" <"$source"
}

case "$verb" in
  attest)
    [ -f "$ATTESTATION_SOURCE" ] || fail "the attestation program is missing: $ATTESTATION_SOURCE"
    run_remote_script "$ATTESTATION_SOURCE" \
      "--attestation-file=$attestation_file" "--agent-url=$agent_url" \
      | write_output "$output"
    ;;
  pressure-capture)
    [ -f "$TOOL_SOURCE" ] || fail "the benchmark tool is missing: $TOOL_SOURCE"
    run_remote_script "$TOOL_SOURCE" capture-host-pressure --output - | write_output "$output"
    ;;
  cgroup-capture)
    [ -f "$TOOL_SOURCE" ] || fail "the benchmark tool is missing: $TOOL_SOURCE"
    run_remote_script "$TOOL_SOURCE" capture-run-host "${verb_args[@]}" --output - \
      | write_output "$output"
    ;;
  workload-events)
    [ -f "$WORKLOAD_SOURCE" ] || fail "the workload helper is missing: $WORKLOAD_SOURCE"
    run_remote_script "$WORKLOAD_SOURCE" "${verb_args[@]}" | write_output "$output"
    ;;
  agent-events)
    [ -f "$TOOL_SOURCE" ] || fail "the benchmark tool is missing: $TOOL_SOURCE"
    # The program arrives on stdin, so the journal goes through a file. Reading
    # both from stdin would read the journal as the program.
    ssh_run "journalctl -u $(quote_remote "$agent_unit") -o cat --no-pager > /tmp/intar-bench-agent.log && python3 - extract-agent-events --input /tmp/intar-bench-agent.log --output -" \
      <"$TOOL_SOURCE" | write_output "$output"
    ;;
  *)
    fail "unsupported verb: $verb" "$UNSUPPORTED_EXIT"
    ;;
esac

log "$verb finished for $host_target"
