# intar-workspace-agent

`intar-workspace-agent` is the provider-neutral guest control plane used by a
direct Workshop learner server. The cloud provider token never enters the
guest. Cloud-init supplies only:

- the runtime execution, workspace, and generation identity;
- an HTTPS Intar agent endpoint;
- a one-use bootstrap capability in a root-only file; and
- Intar's SSH public key through the operating system's `authorized_keys`.

The agent exchanges the capability for a generation-bound report credential
and a time-limited signed checkpoint URL. It persists the credential in a
root-only, atomically replaced state file, removes the bootstrap file, and
verifies the checkpoint's exact size, SHA-256 content address, Ed25519
signature, and configured signer key ID before decompression. It extracts only
regular files and directories into tmpfs. Absolute paths, `..`, links, device
nodes, duplicate files, and oversized archives are rejected.

The built-in applier then validates the schema-v3 `checkpoint.json`, exact
archive file set, install root below `/opt`, per-file digest and mode, external
image lock, ordered reconstruction steps, and the complete module-to-probe
mapping. It atomically installs only the declared learner files, installs each
manual verifier under a root-owned stable path for Kino, and runs bootstrap,
catch-up, and verification programs directly from tmpfs with a controlled
environment. Solution and facilitator material is never installed. An explicitly configured
`checkpoint_apply_program` remains only as a compatibility seam.

After apply, the agent polls the separately pinned Kino binary's loopback
`/probes` protobuf endpoint and sends a report every ten seconds. Runtime health
is distinct from module verification: an unreleased module may fail without
blocking the workspace, while every named probe remains visible in module
progress. Terminal readiness additionally requires checkpoint completion, an
SSH host key, and a successful TCP connection to loopback port 22. Reports omit
raw probe values, command output, terminal recordings, and secrets. Sequence
values are durably reserved before transmission, so a crash can create a gap
but cannot replay an accepted report.

Kino records participant browser terminals into `.krec.partial` files and
atomically publishes a `.krec` only after the session is flushed. The agent
moves complete files into root-owned staging and uploads them as
generation-scoped artifacts. Upload grants are content-idempotent. Teardown
first revokes routes, then keeps only report and recording-upload capabilities
alive for a persisted drain window. Completion or the 60-second deadline gates
credential revocation and server deletion.

All artifact uploads are two-step: the generation credential requests a
bounded grant for a declared digest and size, then the bytes are sent to the
returned short-lived HTTPS URL. The generation credential is not sent to
object storage.

## Control-plane contract v1

Given `control_plane_endpoint = "https://intar.dev/api/workspace-agent/"`, the
agent uses:

| Method | Relative path | Authorization |
| --- | --- | --- |
| `POST` | `bootstrap` | `Intar-Bootstrap <one-use capability>` |
| `POST` | `reports` | `Bearer <generation report credential>` |
| `POST` | `artifacts/grants` | `Bearer <generation report credential>` |
| `PUT` | signed artifact URL | Signed URL only |

The bootstrap response echoes the complete execution identity, returns the
report credential, and describes the checkpoint with `checkpoint_id`,
`signed_url`, lowercase `sha256`, exact `size_bytes`, `compression`,
`signature_b64`, `signing_key_id`, and `expires_at_unix_ms`. Identity
mismatches, expired URLs, unknown signing keys, invalid signatures, and unknown
contract versions fail closed.

If the compatibility apply program is configured, it is invoked directly as:

```text
/usr/libexec/intar-workspace-apply \
  --checkpoint-id <id> \
  --staged-root <tmpfs directory>
```

The agent contains no cloud-provider credential or provider API logic. The
built-in bootstrap may install and use Docker inside the learner server; the
agent itself does not synthesize a container-runtime command.

See [`examples/intar-workspace-agent.service`](examples/intar-workspace-agent.service)
and [`examples/cloud-init.yaml`](examples/cloud-init.yaml). Values surrounded by
`__...__` are rendered per generation by Intar before server creation.
