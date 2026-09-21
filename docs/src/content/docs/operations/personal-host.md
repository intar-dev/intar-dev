---
title: Personal host
description: Add and manage a server for your own scenarios.
---

Open **Profile → My servers → Add server** and copy the token. On your Ubuntu 24.04 or later x86_64 server with KVM, systemd, at least 2 CPU threads, and at least 4 GiB of usable RAM, run:

```sh
curl -fsSL https://intar.dev/install.sh | sudo sh
```

Paste the token at the hidden prompt. Do not put it in the command. Setup prints **Ready** after its checks pass and the Intar connection and tunnel are ready.

The token expires after 15 minutes. The installer saves its enrollment claim before it sends it. If setup stops, repeat the command to resume the same installation.

The installer uses compatible reflink storage when available. Otherwise, it needs at least 110 GiB free: 100 GiB for its storage file and 10 GiB left free. It never formats an existing disk.

You do not need a public address, inbound ports, DNS, or Cloudflare. Browser access and SSH go through Intar.

## Run your scenarios

When your first server becomes **Ready**, all **new runs** use your personal servers, including organization courses. An existing cloud run can finish under its current lease.

If your servers are offline, full, or paused, new starts are refused. Runs do not fall back to cloud servers. Only your work runs on your servers.

## Manage your servers

In **Profile → My servers**, you can rename, pause, resume, or remove a server. Pausing stops new starts; existing runs can finish. When you remove your last server, you must explicitly confirm that new runs will use cloud servers.

| State | Meaning and next step |
| --- | --- |
| Setting up | Installation or the first health check is incomplete. Follow the installer output. |
| Ready | The server can accept your runs if it has enough free capacity. |
| Paused | New runs cannot start here. Select **Resume** when you want to use it again. |
| Offline | Intar has no recent connection. Run `sudo intar-host doctor` on the server. |
| Needs attention | A readiness check failed. Run `sudo intar-host doctor` and follow its repair action. |
| Removal pending | Access is revoked, but remote sessions still need cleanup. Select **Retry removal**. |
| Access revoked | Select **Remove**. Install and register the server again if you want to use it. |

Run `sudo intar-host status` to see the local state. After a reboot, storage and services start in order. The server becomes Ready after its checks pass again.

For a host problem, [check or repair the server](#repair). To update its software, run `sudo intar-host update`. Update waits for active runs to finish before it makes changes.

Local removal uses `sudo intar-host uninstall` and keeps data and credentials. Add `--remove-data` only to delete the owned local data as well. Remove the server in My servers to revoke its credential.

If the server is offline when you remove it, Intar cannot confirm local cleanup. The unmodified agent stops work when its finite lease expires. Stop the agent and remove any remaining virtual machines before you reuse the server. Removal does not prove that local data was erased.

## Repair

```sh
sudo intar-host doctor
sudo intar-host setup
```

`doctor` checks the host. `setup` resumes an interrupted setup with its saved enrollment claim and release. Repeat the public install command if the local command is not yet available. Do not delete enrollment recovery files to try another token.

For storage requirements and release recovery commands, see the [installer reference](https://github.com/intar-dev/intar-dev/blob/main/deploy/personal-metal/README.md).

## Register again

An expired, used, or revoked token cannot create a new registration. Repeating setup keeps the original claim; it does not replace the token or restore revoked access.

First open **Profile → My servers**. If registration is temporarily closed, wait for it to open and repeat setup. If your token has expired or access was revoked, use a fresh installation:

1. Remove any server created by the failed setup. Cancel its pending setup if it is still listed.
2. Keep a separate copy of any local data that you need. Run `sudo intar-host uninstall --remove-data` to remove the old Intar installation and its credential. This command deletes Intar data and refuses to proceed while virtual machines remain active.
3. Select **Add server**, create a new token, and run the installer command again.

Do not delete enrollment files by hand. A request with a lost response can already have registered a server.
