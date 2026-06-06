# kino

Rust probe service with Linux-only SSH/session recording for ephemeral VM validation.

[`deploy/kino.hcl`](deploy/kino.hcl) • [`deploy/kino.service`](deploy/kino.service) • [`proto/kino/v1/probes.proto`](proto/kino/v1/probes.proto)

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
  | protoc --decode=kino.v1.ProbesSnapshotV1 -I proto proto/kino/v1/probes.proto
```

## Usage

```sh
kino --config /etc/kino/kino.hcl
kino record-ssh --config /etc/kino/kino.hcl --command 'printf "hello\n"'
kino record-command --config /etc/kino/kino.hcl --command 'netbird status --json'
```

Probe configs support `file_exists`, `file_regex_capture`, `port_open`, `service`, `k8s_pod_state`, and `command_json_path`. Recorder output is written to `recording.output_dir`.

## License

[MIT](LICENSE)
