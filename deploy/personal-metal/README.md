# Personal host

Run your own scenarios on your own Ubuntu server. Open **My servers** in Intar, select **Add server**, and copy the token. On the server, run:

```sh
curl -fsSL https://intar.dev/install.sh | sudo sh
```

Paste the token when asked. Input is hidden. The token must not be put in a command, URL, environment variable, or support message. Setup prints **Ready** only after the privileged jailer self-test and the agent doctor pass and the agent has a working control connection and tunnel. Open My servers to check the connection.

## Host requirements

- Ubuntu 24.04 or later, x86_64, systemd, cgroup v2, and working `/dev/kvm` and `/dev/net/tun`.
- At least 2 CPU threads and 4 GiB of usable RAM. A VM with exactly 4 GiB assigned can have less than 4 GiB usable; assign more RAM in that case.
- An empty Intar deployment. Setup refuses existing unmanaged configuration or data and refuses active VMs. It does not migrate an old host.
- Reflink storage with at least 10 GiB free. If the filesystem cannot make reflinks, setup needs at least 110 GiB free to create its own preallocated 100 GiB XFS file and retain 10 GiB free outside that file.
- Outbound HTTPS to Intar, GitHub release assets, Ubuntu repositories, and the pinned jailer self-test fixture publishers. No public agent HTTP port is opened.

Setup does not format a disk. It creates a file only with exclusive creation, records the file identity before allocation, and formats only that owned file before it can contain runtime data. XFS discard is disabled at creation. Setup also disables discard on the owned loop device at each boot, so filesystem trimming cannot remove the preallocation. The cache, jail root, and self-test source files use bind mounts from one filesystem. These mounts start before the socket, jailer, checks, and agent at each boot. The agent reserves 1 CPU thread, the compressed image cache is limited to 20 GiB, the template store is limited to 30 GiB, and jail admission keeps a 10 GiB storage reserve.

## Manage the host

```sh
sudo intar-host status
sudo intar-host doctor
sudo intar-host setup
sudo intar-host update
sudo intar-host update --version 0.1.2
sudo intar-host update --cancel-update
sudo intar-host uninstall
```

`setup` resumes an interrupted setup with the same release and enrollment claim. Repeat the public command if `intar-host` is not installed yet. A lost enrollment response is safe to retry: setup saves and syncs the token and new random credential before it sends the claim. It saves the returned host identity before it removes the token. A rejected claim remains saved; do not delete it to try a different token because the server can already have accepted it.

`update` blocks new work and waits for tracked runs to finish. The default wait limit is 900 seconds; use `--drain-timeout SECONDS` to change it. A timeout keeps the running agent drained and leaves the binaries intact. Repeat the command later. Setup keeps a maintenance marker through interrupted changes so a reboot cannot start a partly installed agent. Update runs the privileged self-test and doctor again before it resumes admission.

`update --version VERSION` can replace a failed release download or dependency installation, including a version that does not exist. `update --cancel-update` clears that selection without resuming work or changing data, credentials, or the maintenance marker. Replacement and cancellation are refused once storage, configuration, or runtime installation has started; repeat `setup` to finish that release first. An ordinary setup retry keeps its selected release.

`doctor` checks the release package, protected files, mounts, storage space, and agent readiness. It does not run a VM. The boot check runs the privileged VM self-test while the agent is stopped. A failed check leaves the agent stopped. Use `sudo journalctl -u intar-personal-check.service` to read the check result.

`uninstall` drains active runs, stops services, and removes the runtime binaries and service units. It **keeps data by default**: the storage file, mounts, jail data, cache, configuration, credential, release cache, and `intar-host` stay on disk. It does not delete local or server data. Remove the server in My servers to revoke the credential. Run `setup` to restore a host that was removed locally while its credential is still valid. To also delete the local data and credentials, use:

```sh
sudo intar-host uninstall --remove-data
```

This explicit command waits for runs to stop, checks the recorded storage-file identity and mount sources, stops the owned mounts, and deletes only Intar data. It refuses extra nested mounts and leaves files outside the fixed Intar paths alone. It never formats a disk. Other files in the configuration directories are kept. If removal is interrupted, repeat the same command. Server credential revocation still requires removal in My servers.

## Release and recovery files

The public launcher resolves a published `agent/v<version>` GitHub release, checks the manager asset SHA-256, then runs that version. The manager pins and verifies the matching archive and every packaged file. SHA-256 protects transfer integrity; the HTTPS GitHub release and its publishers are the trust source. Release packaging records Ubuntu dependency versions in `dependencies.lock` as minimum requirements. Setup accepts equal or newer versions from the host's APT repositories. If a minimum cannot be met, installation fails. OS security updates remain the operator's responsibility.

| Path | Use |
| --- | --- |
| `/usr/local/bin/intar-host` | Installed management command |
| `/var/lib/intar-personal/state.json` | Root-only setup stage and selected release |
| `/var/lib/intar-personal/enrollment.json` | Root-only enrollment recovery state; contains a secret |
| `/etc/intar-agent/config.toml` | Root-owned agent configuration |
| `/etc/intar-agent/credential.json` | Root-owned host credential; readable only by root and the agent group |
| `/var/lib/intar-personal/storage.xfs` | Optional owned storage file |
| `/var/lib/intar-personal/storage/` | Shared storage filesystem |
| `/var/lib/intar-personal/releases/` | Verified immutable release packages |

Do not copy credential or enrollment files into logs or issue reports. The installer never prints their contents and disables core dumps.

## Checks

```sh
python3.12 -m unittest discover -s deploy/personal-metal -p 'test_*.py'
sh -n apps/web/public/install.sh deploy/personal-metal/package.sh deploy/personal-metal/test-mounts-linux.sh
```

The portable tests use temporary files and command doubles. They check recovery, secrets, archive rejection, storage safety, and ordering. They do not prove KVM, mounts, systemd, reboot, or Linux access controls. The release workflow runs `sudo sh deploy/personal-metal/test-mounts-linux.sh` in an isolated mount namespace to test a real bind mount on one filesystem. It also runs the actual privileged jailer package smoke on an Ubuntu KVM runner before publication. A real personal server must also pass its own setup and boot checks. No privileged Linux result can be inferred from a macOS test run.
