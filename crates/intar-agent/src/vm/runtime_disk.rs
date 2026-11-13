#![forbid(unsafe_code)]

//! The run disk: a read-only FAT image labelled `INTARRUN` that holds
//! exactly `boot.json` and the Kino binary.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

use anyhow::{Context as _, Result};
use intar_contracts::guest::{
    BOOT_JSON_FILENAME, GUEST_CONTRACT, GuestBootV3, GuestNetworkV3, GuestSshV3, KINO_FILENAME,
    RUNTIME_DISK_LABEL,
};
use intar_contracts::scenario::{MachineSpecV1, SpecMode};
use russh::keys::PublicKey;
use sha2::{Digest as _, Sha256};

use super::manager::CreateVmNetwork;

const RUNTIME_DISK_BYTES: u64 = 16 * 1024 * 1024;

pub struct BootJsonInput<'a> {
    pub hostname: &'a str,
    pub network: &'a CreateVmNetwork,
    /// Only a VM with egress is told resolvers.
    pub egress: bool,
    pub peer_guest_ips: &'a BTreeMap<String, String>,
    pub ssh_enabled: bool,
    pub ssh_authorized_keys_openssh: &'a [String],
    pub root_resize: bool,
    pub mode: SpecMode,
    /// The spec blob, already checked against its digest.
    pub spec: &'a [u8],
}

/// The exact `boot.json` bytes and their SHA-256 (hex), the digest every
/// report of this run's Kino must carry.
pub struct BootJson {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub fn boot_json(input: &BootJsonInput<'_>) -> Result<BootJson> {
    let spec: MachineSpecV1 =
        serde_json::from_slice(input.spec).context("the machine spec is not a MachineSpecV1")?;
    let boot = GuestBootV3 {
        contract: GUEST_CONTRACT,
        hostname: input.hostname.to_owned(),
        network: GuestNetworkV3 {
            ip_cidr: input.network.guest_ip_cidr.clone(),
            gateway: input.network.gateway.clone(),
            dns: if input.egress {
                input.network.dns.clone()
            } else {
                Vec::new()
            },
        },
        peers: input.peer_guest_ips.clone(),
        ssh: GuestSshV3 {
            enabled: input.ssh_enabled,
            // Without SSH there is nothing to authorize: keys sent anyway are dropped.
            authorized_keys: if input.ssh_enabled {
                validated_authorized_keys(input.ssh_authorized_keys_openssh)?
            } else {
                Vec::new()
            },
        },
        root_resize: input.root_resize,
        mode: input.mode,
        spec,
    };
    let bytes = serde_json::to_vec(&boot).context("serialize boot.json")?;
    let sha256 = base16ct::lower::encode_string(&Sha256::digest(&bytes));
    Ok(BootJson { bytes, sha256 })
}

pub fn write_runtime_disk(path: &Path, boot_json: &[u8], kino: &[u8]) -> Result<()> {
    let mut img = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("failed to create run disk at {}", path.display()))?;
    img.set_len(RUNTIME_DISK_BYTES)
        .with_context(|| format!("failed to size run disk at {}", path.display()))?;
    let opts = fatfs::FormatVolumeOptions::new().volume_label(RUNTIME_DISK_LABEL);
    fatfs::format_volume(&mut img, opts).context("failed to format run disk as vfat")?;
    img.seek(SeekFrom::Start(0))
        .context("failed to seek run disk")?;
    let fs = fatfs::FileSystem::new(img, fatfs::FsOptions::new())
        .context("failed to open the formatted run disk")?;
    let root = fs.root_dir();
    write_file(&root, BOOT_JSON_FILENAME, boot_json)?;
    write_file(&root, KINO_FILENAME, kino)?;
    Ok(())
}

/// Trimmed, deduplicated OpenSSH public keys, each parsed. A key with a line
/// break or NUL is refused, and the set must not be empty.
fn validated_authorized_keys(keys: &[String]) -> Result<Vec<String>> {
    let mut unique = BTreeSet::new();
    for raw in keys {
        let key = raw.trim();
        anyhow::ensure!(
            !key.is_empty() && !key.contains(['\n', '\r', '\0']),
            "authorized SSH key contains invalid whitespace or NUL"
        );
        PublicKey::from_openssh(key).context("authorized SSH key is not valid OpenSSH material")?;
        unique.insert(key.to_owned());
    }
    anyhow::ensure!(!unique.is_empty(), "authorized SSH key set is empty");
    Ok(unique.into_iter().collect())
}

fn write_file(dir: &fatfs::Dir<'_, std::fs::File>, name: &str, content: &[u8]) -> Result<()> {
    let mut file = dir
        .create_file(name)
        .with_context(|| format!("failed to create {name} on the run disk"))?;
    file.write_all(content)
        .with_context(|| format!("failed to write {name} on the run disk"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use anyhow::Result;
    use tempfile::tempdir;

    use super::*;

    const KEY: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBklzf1Qy77LwsjmDlGvCAhBpCkhpti25927fAnOMEIR stargate-target";

    fn spec() -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "scenario_id": "intar/broken-nginx",
            "machine": "web",
            "env": {},
            "defer": [],
            "ready": [],
            "tasks": [],
        }))
        .unwrap_or_default()
    }

    #[test]
    fn keys_are_required_only_with_ssh() -> Result<()> {
        let (network, spec, peers) = (network(), spec(), BTreeMap::new());
        let mut closed = input(&network, &peers, &[], &spec, false);
        assert!(boot_json(&closed).is_err(), "a terminal VM needs a key");
        let broken = ["not a key".to_owned()];
        closed.ssh_authorized_keys_openssh = &broken;
        assert!(
            boot_json(&closed).is_err(),
            "a terminal VM's keys are checked"
        );

        closed.ssh_enabled = false;
        for keys in [&[][..], &broken[..]] {
            closed.ssh_authorized_keys_openssh = keys;
            let boot: GuestBootV3 = serde_json::from_slice(&boot_json(&closed)?.bytes)?;
            assert!(!boot.ssh.enabled && boot.ssh.authorized_keys.is_empty());
        }
        Ok(())
    }

    fn input<'a>(
        network: &'a CreateVmNetwork,
        peers: &'a BTreeMap<String, String>,
        keys: &'a [String],
        spec: &'a [u8],
        egress: bool,
    ) -> BootJsonInput<'a> {
        BootJsonInput {
            hostname: "web",
            network,
            egress,
            peer_guest_ips: peers,
            ssh_enabled: true,
            ssh_authorized_keys_openssh: keys,
            root_resize: true,
            mode: SpecMode::Learn,
            spec,
        }
    }

    fn network() -> CreateVmNetwork {
        CreateVmNetwork {
            guest_ip_cidr: "10.200.0.2/28".to_owned(),
            gateway: "10.200.0.1".to_owned(),
            dns: vec!["1.1.1.1".to_owned(), "8.8.8.8".to_owned()],
        }
    }

    #[test]
    fn boot_json_names_resolvers_only_with_egress() -> Result<()> {
        let (network, spec) = (network(), spec());
        let peers = BTreeMap::from([("db".to_owned(), "10.200.0.3".to_owned())]);
        let keys = vec![format!("  {KEY}  "), KEY.to_owned()];

        let closed = boot_json(&input(&network, &peers, &keys, &spec, false))?;
        let boot: GuestBootV3 = serde_json::from_slice(&closed.bytes)?;
        assert_eq!(boot.contract, GUEST_CONTRACT);
        assert_eq!(boot.hostname, "web");
        assert_eq!(boot.network.ip_cidr, "10.200.0.2/28");
        assert_eq!(boot.network.gateway, "10.200.0.1");
        assert!(boot.network.dns.is_empty(), "no egress, no resolvers");
        assert_eq!(boot.peers, peers);
        assert_eq!(boot.ssh.authorized_keys, vec![KEY.to_owned()]);
        assert!(boot.ssh.enabled && boot.root_resize);
        assert_eq!(boot.mode, SpecMode::Learn);
        assert_eq!(boot.spec.machine, "web");
        assert_eq!(
            closed.sha256,
            base16ct::lower::encode_string(&Sha256::digest(&closed.bytes))
        );

        let open = boot_json(&input(&network, &peers, &keys, &spec, true))?;
        let boot: GuestBootV3 = serde_json::from_slice(&open.bytes)?;
        assert_eq!(boot.network.dns, network.dns);
        assert_ne!(open.sha256, closed.sha256);
        Ok(())
    }

    #[test]
    fn boot_json_refuses_bad_keys_and_a_spec_with_unknown_fields() {
        let (network, spec) = (network(), spec());
        let peers = BTreeMap::new();
        for keys in [
            Vec::new(),
            vec!["not a key".to_owned()],
            vec![format!("{KEY}\nssh-ed25519 AAAA other")],
        ] {
            assert!(boot_json(&input(&network, &peers, &keys, &spec, false)).is_err());
        }
        let keys = vec![KEY.to_owned()];
        let mut loose: serde_json::Value = serde_json::from_slice(&spec).unwrap_or_default();
        loose["later"] = true.into();
        let loose = serde_json::to_vec(&loose).unwrap_or_default();
        assert!(boot_json(&input(&network, &peers, &keys, &loose, false)).is_err());
    }

    #[test]
    fn the_run_disk_holds_exactly_boot_json_and_kino() -> Result<()> {
        let dir = tempdir()?;
        let path = dir.path().join("runtime.img");
        write_runtime_disk(&path, b"{\"boot\":1}", b"\x7fELF kino")?;

        assert_eq!(std::fs::metadata(&path)?.len(), RUNTIME_DISK_BYTES);
        let fs = fatfs::FileSystem::new(
            std::fs::File::options()
                .read(true)
                .write(true)
                .open(&path)?,
            fatfs::FsOptions::new(),
        )?;
        assert_eq!(fs.volume_label(), "INTARRUN");
        let mut names = fs
            .root_dir()
            .iter()
            .map(|entry| entry.map(|entry| entry.file_name()))
            .collect::<std::io::Result<Vec<_>>>()?;
        names.sort();
        assert_eq!(
            names,
            vec![BOOT_JSON_FILENAME.to_owned(), KINO_FILENAME.to_owned()]
        );
        let mut kino = Vec::new();
        fs.root_dir()
            .open_file(KINO_FILENAME)?
            .read_to_end(&mut kino)?;
        assert_eq!(kino, b"\x7fELF kino");
        Ok(())
    }
}
