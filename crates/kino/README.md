# kino

Kino is the program Intar puts in every machine it starts. It does three
things there:

- It evaluates the scenario's checks ("probes") and serves their state to the
  host.
- It records the learner's SSH sessions, on Linux, for the replay.
- It is the `intar` command the learner types in the machine.

The name is the reconnaissance drone in *Stargate Universe*
([Kino](https://stargate.fandom.com/wiki/Kino)): a tool that probes machines
and records what it sees.

Files: [`deploy/kino.hcl`](deploy/kino.hcl) (an example configuration),
[`deploy/kino.service`](deploy/kino.service), and the probe protocol,
[`probes.proto`](../intar-kino-proto/proto/kino/v1/probes.proto).

## Trying it

From the repository root, on Linux or macOS:

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

KINO_CONTROL_SOCKET=/tmp/kino-control.sock cargo run -p kino -- --config /tmp/kino.hcl
```

Kino also opens a control socket for the `intar` command, at
`/run/intar/kino-control.sock` unless `KINO_CONTROL_SOCKET` names another
path. Outside a machine that directory does not exist, and Kino exits without
the variable.

In another shell:

```sh
curl http://127.0.0.1:8080/version
curl -sS http://127.0.0.1:8080/probes \
  | protoc --decode=kino.v1.ProbesSnapshotV1 -I crates/intar-kino-proto/proto kino/v1/probes.proto
```

## Commands

```sh
kino --config /etc/kino/kino.hcl
kino record-ssh --config /etc/kino/kino.hcl --command 'printf "hello\n"'
kino record-command --config /etc/kino/kino.hcl --command 'cat /etc/os-release'
```

Probe configs support `file_exists`, `file_regex_capture`, `port_open`, `service`, `k8s_pod_state`, and `command_json_path`. Recorder output is written to `recording.output_dir`.

A scenario task's `k8s`, `rollout` and `can_i` checks reach Kino as typed
probes in its machine spec, not as scripts. Kino asks the API server itself,
with the kubeconfig `KUBECONFIG` in the machine's env names, before it runs
the task's script checks; see `init/probes.rs`.

Kino syncs each completed recording and then publishes it with an atomic,
no-replace rename. This must stay compatible with the KVM runtime's
sync-mounted VFAT recording disk; VFAT does not support hard links.

## The `intar` command

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

## Building the guest binary

The Kino that ships in machines is a static musl build with its own profile:
`cuenv task build-kino-guest`, which needs `cargo-zigbuild`. Only the release
workflow builds the one that hosts run; see
[`RELEASING.md`](../../RELEASING.md) for how a Kino release reaches them.
