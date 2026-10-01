# Stargate deployment assets

Stargate implementation remains in the root Rust workspace under
`crates/stargate-core` and `crates/stargate-gateway`. This directory contains
only deployment assets:

- `cloudflared/` contains the administered Tunnel ingress examples;
- `systemd/` contains the service unit;
- `stargate.toml.example` documents the production configuration contract;
- `scripts/` contains the constrained host-side deployment entrypoints.

Changes are drain-first. Before replacing the binary or Tunnel rules, stop new
terminal/application issuance and prove active routes are drained. The
workspace application base domain remains `intar.app`; the default bootstrap
TTL is 60 seconds and browser session TTL is 900 seconds.

## Rolling out

Roll a release out from the operator's machine. `intar-deploy-stargate`
(`/usr/local/sbin` on the host) runs as root, directly or through the
`stargate-deploy` user's forced command that `bootstrap-deploy-user` installs:

1. Download `stargate_X.Y.Z_linux_amd64.tar.gz` and its checksums from the
   `stargate/vX.Y.Z` release and check them ("Rolling out" in the root README).
   Note the SHA-256 of the archive and of the `stargate` binary inside it.
2. `intar-deploy-stargate plan` prints the installed binary's SHA-256 and the
   active route and session counts. `apply` refuses until all of them are 0.
3. `intar-deploy-stargate apply stargate/vX.Y.Z ARCHIVE_SHA256 BINARY_SHA256 <
   archive` backs up the binary, configuration, and database, installs the
   release, and prints the `backup_id`.
4. Check the public routing: `https://ws.intar.app/healthz` succeeds,
   `https://garbage.intar.app/` answers 404, and
   `https://wa-no-such-route.intar.app/` answers 401.
5. If a check fails, `intar-deploy-stargate rollback BACKUP_ID` restores the
   backup.
