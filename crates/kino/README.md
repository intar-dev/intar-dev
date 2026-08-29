# kino

Rust probe service with Linux-only SSH/session recording for ephemeral VM validation.

[`deploy/kino.hcl`](deploy/kino.hcl) • [`deploy/kino.service`](deploy/kino.service) • [`../intar-kino-proto/proto/kino/v1/probes.proto`](../intar-kino-proto/proto/kino/v1/probes.proto)

A small name note: `kino` comes from the reconnaissance drone in *Stargate Universe*; see [Kino](https://stargate.fandom.com/wiki/Kino). It felt like a good fit for a tool that probes machines and records what it sees.

## Quick Start

```sh
cat >/tmp/kino.hcl <<'EOF'
server {
  bind = "tcp://127.0.0.1:8080"
}

probe "hosts_file" {
  kind = "file_exists"
  path = "/etc/hosts"
}
EOF

cargo run -p kino -- --config /tmp/kino.hcl
```

In another shell:

```sh
curl http://127.0.0.1:8080/version
curl -sS http://127.0.0.1:8080/probes \
  | protoc --decode=kino.v1.ProbesSnapshotV1 -I ../intar-kino-proto/proto ../intar-kino-proto/proto/kino/v1/probes.proto
```

## Usage

```sh
kino --config /etc/kino/kino.hcl
kino record-ssh --config /etc/kino/kino.hcl --command 'printf "hello\n"'
kino record-command --config /etc/kino/kino.hcl --command 'cat /etc/os-release'
```

Probe configs support `file_exists`, `file_regex_capture`, `port_open`, `service`, `k8s_pod_state`, and `command_json_path`. Recorder output is written to `recording.output_dir`.

Kino is also the guest's multicall learner CLI. Images install
`/usr/local/bin/intar` as a symlink to Kino. That command provides status,
fresh checks, layered hints, released solutions, and Bash completion through
the private run broker. It is non-interactive, never reads stdin, and exposes
no JSON output.

Bash completes command words locally. Dynamic hint completion reads only
sorted public aliases from a generation-fenced broker cache, never a full run
view, and fails silently behind a hard 250 ms deadline.

```text
intar
intar status
intar check
intar hints
intar hint <alias>
intar solution
intar solution reveal
intar help
```

## License

[MIT](../../LICENSE)
