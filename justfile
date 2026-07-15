default:
    @just --list

fmt:
    cargo fmt --all

check:
    cargo check --workspace

clippy:
    cargo clippy --workspace --all-targets -- -D warnings

test:
    cargo test --workspace

verify:
    sh crates/intar-jailerd/tests/install-process-audit.sh crates/intar-jailerd/deploy/install.sh
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets -- -D warnings
    cargo nextest run --workspace

security:
    cargo audit

generate-contracts:
    cargo run -p intar-contracts-typegen

generate-scenario-wasm:
    wasm-pack build crates/intar-image-scenario-wasm --target web --release --no-pack --out-dir ../../website/src/generated/scenario-wasm
    rm -f website/src/generated/scenario-wasm/.gitignore

check-generated-contracts:
    cargo run -p intar-contracts-typegen
    git diff --exit-code -- website/src/generated

build-kino-guest:
    cargo zigbuild --profile guest -p kino --target x86_64-unknown-linux-musl

validate-images:
    cargo run -p intar-image-cli -- validate

render-images scenario="" config="builder.sample.amd64.hcl":
    #!/usr/bin/env bash
    set -euo pipefail

    target_dir="$(cargo metadata --format-version=1 --no-deps | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
    kino_binary="${target_dir}/x86_64-unknown-linux-musl/guest/kino"

    if [[ -n "{{scenario}}" ]]; then
      cargo run -p intar-image-cli -- render "{{scenario}}" --config "{{config}}" --kino-binary "${kino_binary}"
    else
      cargo run -p intar-image-cli -- render --config "{{config}}" --kino-binary "${kino_binary}"
    fi

build-images scenario="" config="builder.sample.amd64.hcl" no_upload="false":
    #!/usr/bin/env bash
    set -euo pipefail

    just build-kino-guest
    target_dir="$(cargo metadata --format-version=1 --no-deps | python3 -c 'import json, sys; print(json.load(sys.stdin)["target_directory"])')"
    kino_binary="${target_dir}/x86_64-unknown-linux-musl/guest/kino"

    if [[ -n "{{scenario}}" ]]; then
      args=(build "{{scenario}}")
    else
      args=(build-all)
    fi
    args+=(--config "{{config}}" --kino-binary "${kino_binary}")
    if [[ "{{no_upload}}" == "true" ]]; then
      args+=(--no-upload)
    fi

    cargo run -p intar-image-cli -- "${args[@]}"

bundle-images scenario="" config="builder.sample.amd64.hcl" rev="" no_upload="false" url="":
    #!/usr/bin/env bash
    set -euo pipefail

    args=(bundle)
    if [[ -n "{{scenario}}" ]]; then
      args+=("{{scenario}}")
    fi
    args+=(--config "{{config}}")
    if [[ -n "{{rev}}" ]]; then
      args+=(--rev "{{rev}}")
    fi
    if [[ -n "{{url}}" ]]; then
      args+=(--url "{{url}}")
    fi
    if [[ "{{no_upload}}" == "true" ]]; then
      args+=(--no-upload)
    fi

    cargo run -p intar-image-cli -- "${args[@]}"

live-e2e args="":
    cd website && bun run e2e:live -- {{args}}

docker-smoke:
    just docker-smoke-probes
    just docker-smoke-ssh-recording

docker-smoke-probes:
    #!/usr/bin/env bash
    set -euo pipefail

    container_name="kino-k0s-ci"
    image_tag="kino-k0s:ci"

    cleanup() {
      docker rm -f "${container_name}" >/dev/null 2>&1 || true
    }

    wait_for_probes() {
      local attempts=0
      local max_attempts=180
      local http_code
      local state

      echo "Waiting for /probes readiness..."
      while ((attempts < max_attempts)); do
        state="$(
          docker inspect "${container_name}" 2>/dev/null \
            | python3 -c 'import json, sys; print(json.load(sys.stdin)[0]["State"]["Status"])' \
            || echo unknown
        )"
        if [[ "${state}" == "unknown" ]]; then
          echo "Container disappeared before /probes became ready"
          docker logs --tail 200 "${container_name}" || true
          return 1
        fi
        if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
          echo "Container is ${state} before /probes became ready"
          docker logs --tail 200 "${container_name}" || true
          return 1
        fi

        http_code="$(curl -sS -o /tmp/kino-probes.bin -w '%{http_code}' --max-time 2 http://127.0.0.1:18080/probes || true)"
        if [[ "${http_code}" == "200" ]]; then
          echo "/probes is ready"
          return 0
        fi

        ((attempts += 1))
        if ((attempts % 10 == 0)); then
          echo "Still waiting (attempt ${attempts}/${max_attempts}, http_code=${http_code})"
        fi
        sleep 1
      done

      echo "Timed out waiting for /probes"
      docker logs --tail 200 "${container_name}" || true
      return 1
    }

    assert_probe_status() {
      local probe_id="$1"
      local expected_status="$2"

      if ! grep -F -A8 "id: \"${probe_id}\"" /tmp/kino-probes.txt | grep -Fq "status: ${expected_status}"; then
        echo "Probe ${probe_id} did not report ${expected_status}"
        cat /tmp/kino-probes.txt
        return 1
      fi
    }

    trap cleanup EXIT
    cleanup

    docker build -f crates/kino/docker/smoke/probes.Dockerfile -t "${image_tag}" .
    docker run -d --name "${container_name}" --privileged -p 18080:8080 -p 16443:6443 "${image_tag}" >/dev/null

    wait_for_probes

    protoc --decode=kino.v1.ProbesSnapshotV1 -I crates/intar-kino-proto/proto crates/intar-kino-proto/proto/kino/v1/probes.proto < /tmp/kino-probes.bin >/tmp/kino-probes.txt
    cat /tmp/kino-probes.txt

    for probe_id in kino_check_pod_running kino_config_exists kino_config_has_server_block kube_api_port_open; do
      if ! grep -Fq "id: \"${probe_id}\"" /tmp/kino-probes.txt; then
        echo "Missing probe id: ${probe_id}"
        exit 1
      fi
    done

    assert_probe_status "kino_config_exists" "PROBE_STATUS_PASS"
    assert_probe_status "kino_config_has_server_block" "PROBE_STATUS_PASS"
    assert_probe_status "kube_api_port_open" "PROBE_STATUS_PASS"

docker-smoke-ssh-recording:
    #!/usr/bin/env bash
    set -euo pipefail

    container_name="kino-ssh-recording-ci"
    image_tag="kino-ssh-recording:ci"
    recordings_dir="$(mktemp -d)"
    ssh_dir="$(mktemp -d)"
    private_key="${ssh_dir}/id_ed25519"
    public_key="${ssh_dir}/id_ed25519.pub"
    interactive_log="${ssh_dir}/interactive.log"
    command_log="${ssh_dir}/command.log"
    tty_command_log="${ssh_dir}/tty-command.log"
    stdin_command_log="${ssh_dir}/stdin-command.log"
    progress_log="${ssh_dir}/progress.log"

    cleanup_container() {
      docker rm -f "${container_name}" >/dev/null 2>&1 || true
    }

    cleanup() {
      cleanup_container
      rm -rf "${recordings_dir}" "${ssh_dir}"
    }

    wait_for_ssh() {
      local attempts=0
      local max_attempts=60
      local state

      echo "Waiting for sshd readiness..."
      while ((attempts < max_attempts)); do
        state="$(
          docker inspect "${container_name}" 2>/dev/null \
            | python3 -c 'import json, sys; print(json.load(sys.stdin)[0]["State"]["Status"])' \
            || echo unknown
        )"
        if [[ "${state}" == "unknown" ]]; then
          echo "Container disappeared before sshd became ready"
          docker logs --tail 200 "${container_name}" || true
          return 1
        fi
        if [[ "${state}" == "exited" || "${state}" == "dead" ]]; then
          echo "Container is ${state} before sshd became ready"
          docker logs --tail 200 "${container_name}" || true
          return 1
        fi

        if ssh -i "${private_key}" \
          -p 12222 \
          -o BatchMode=yes \
          -o ConnectTimeout=2 \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          user@127.0.0.1 "true" >/dev/null 2>&1; then
          echo "sshd is ready"
          return 0
        fi

        ((attempts += 1))
        sleep 1
      done

      echo "Timed out waiting for sshd"
      docker logs --tail 200 "${container_name}" || true
      return 1
    }

    trap cleanup EXIT
    cleanup_container

    chmod 0777 "${recordings_dir}"
    ssh-keygen -q -N '' -t ed25519 -f "${private_key}"

    docker build -f crates/kino/docker/smoke/ssh-recording.Dockerfile -t "${image_tag}" .
    docker run -d \
      --name "${container_name}" \
      -p 12222:22 \
      -v "${recordings_dir}:/recordings" \
      -v "${ssh_dir}:/smoke:ro" \
      "${image_tag}" >/dev/null

    wait_for_ssh

    printf 'printf "interactive-smoke\n"\nexit\n' \
      | ssh -tt \
          -i "${private_key}" \
          -p 12222 \
          -o BatchMode=yes \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          user@127.0.0.1 >"${interactive_log}" 2>&1

    ssh \
      -i "${private_key}" \
      -p 12222 \
      -o BatchMode=yes \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      user@127.0.0.1 "printf 'command-smoke\n'" >"${command_log}" 2>&1

    ssh -tt \
      -i "${private_key}" \
      -p 12222 \
      -o BatchMode=yes \
      -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null \
      user@127.0.0.1 "printf 'tty-command-smoke\n'" >"${tty_command_log}" 2>&1

    printf 'stdin-smoke\n' \
      | ssh \
          -i "${private_key}" \
          -p 12222 \
          -o BatchMode=yes \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          user@127.0.0.1 "cat >/tmp/stdin-smoke && cat /tmp/stdin-smoke" >"${stdin_command_log}" 2>&1

    printf 'printf "Listing... 0%%\r"; sleep 0.1; printf "Listing... Done\r\n"; printf "progress-tail-smoke\n"\nexit\n' \
      | ssh -tt \
          -i "${private_key}" \
          -p 12222 \
          -o BatchMode=yes \
          -o StrictHostKeyChecking=no \
          -o UserKnownHostsFile=/dev/null \
          user@127.0.0.1 >"${progress_log}" 2>&1

    echo "Recorded files:"
    ls -la "${recordings_dir}"

    python3 crates/kino/docker/smoke/validate_casts.py "${recordings_dir}"
