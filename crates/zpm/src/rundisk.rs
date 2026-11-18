//! The run disk: a read-only FAT image labelled `INTARRUN` that holds exactly
//! `boot.json` and the Kino binary. The guest's loader mounts it and runs
//! Kino from it. Also the empty disk Kino records terminal sessions onto.
//
// ponytail: this repeats intar-agent's `vm/runtime_disk.rs`; both move into
// one shared crate with the extraction in #397.

use std::collections::BTreeMap;
use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

use intar_contracts::guest::{
    BOOT_JSON_FILENAME, GUEST_CONTRACT, GuestBootV3, GuestHostV3, GuestNetworkV3, GuestSshV3,
    KINO_FILENAME, RECORDING_DISK_LABEL, RUNTIME_DISK_LABEL,
};
use intar_contracts::scenario::{MachineSpecV1, SpecMode};

use crate::Error;

const RUN_DISK_BYTES: u64 = 16 * 1024 * 1024;
const RECORDING_DISK_BYTES: u64 = 64 * 1024 * 1024;

/// What one machine's Kino is told.
pub struct Boot<'a> {
    pub hostname: &'a str,
    /// The guest's address with its prefix length, such as `10.77.52.2/28`.
    pub ip_cidr: &'a str,
    pub gateway: &'a str,
    /// Empty unless the machine may reach the internet.
    pub dns: &'a [String],
    /// The run's other machines, by name, with their addresses.
    pub peers: &'a BTreeMap<String, String>,
    /// OpenSSH public keys that may log in as the guest's user.
    pub authorized_keys: &'a [String],
    /// The spec blob as pulled, already checked against its digest.
    pub spec: &'a [u8],
    /// Where Kino reaches this computer; `None` is vsock, on a Linux host.
    pub host: Option<GuestHostV3>,
}

/// The exact `boot.json` bytes for a learner's run.
pub fn boot_json(boot: &Boot<'_>) -> Result<Vec<u8>, Error> {
    let spec: MachineSpecV1 = serde_json::from_slice(boot.spec)
        .map_err(|error| Error::RunDisk(format!("the machine spec is not readable: {error}")))?;
    let mut keys: Vec<String> = Vec::new();
    for key in boot.authorized_keys {
        let key = key.trim();
        // A line break would add a key of its own to the guest's authorized_keys.
        if key.is_empty() || key.contains(['\n', '\r', '\0']) {
            return Err(Error::RunDisk(
                "an SSH key is empty or holds a line break".into(),
            ));
        }
        if !keys.iter().any(|known| known == key) {
            keys.push(key.to_owned());
        }
    }
    if keys.is_empty() {
        return Err(Error::RunDisk(
            "no SSH key was given, so nothing could log in".into(),
        ));
    }
    let document = GuestBootV3 {
        contract: GUEST_CONTRACT,
        hostname: boot.hostname.to_owned(),
        network: GuestNetworkV3 {
            ip_cidr: boot.ip_cidr.to_owned(),
            gateway: boot.gateway.to_owned(),
            dns: boot.dns.to_vec(),
        },
        peers: boot.peers.clone(),
        ssh: GuestSshV3 {
            enabled: true,
            authorized_keys: keys,
        },
        root_resize: false,
        mode: SpecMode::Learn,
        spec,
        host: boot.host.clone(),
    };
    serde_json::to_vec(&document).map_err(|error| Error::RunDisk(error.to_string()))
}

/// Writes the run disk at `path`, replacing what is there.
pub fn write_run_disk(path: &Path, boot_json: &[u8], kino: &[u8]) -> Result<(), Error> {
    let files: [(&str, &[u8]); 2] = [(BOOT_JSON_FILENAME, boot_json), (KINO_FILENAME, kino)];
    fat_image(path, RUN_DISK_BYTES, RUNTIME_DISK_LABEL, &files)
}

/// Writes an empty disk for Kino's terminal recordings at `path`.
pub fn write_recording_disk(path: &Path) -> Result<(), Error> {
    fat_image(path, RECORDING_DISK_BYTES, RECORDING_DISK_LABEL, &[])
}

fn fat_image(
    path: &Path,
    bytes: u64,
    label: [u8; 11],
    files: &[(&str, &[u8])],
) -> Result<(), Error> {
    let failed = |what: &str, error: &dyn std::fmt::Display| {
        Error::RunDisk(format!("could not {what} {}: {error}", path.display()))
    };
    let mut image = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|error| failed("create", &error))?;
    image
        .set_len(bytes)
        .map_err(|error| failed("size", &error))?;
    fatfs::format_volume(
        &mut image,
        fatfs::FormatVolumeOptions::new().volume_label(label),
    )
    .map_err(|error| failed("format", &error))?;
    image
        .seek(SeekFrom::Start(0))
        .map_err(|error| failed("rewind", &error))?;
    let filesystem = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
        .map_err(|error| failed("open", &error))?;
    for (name, content) in files {
        let mut file = filesystem
            .root_dir()
            .create_file(name)
            .map_err(|error| failed("write to", &error))?;
        file.write_all(content)
            .map_err(|error| failed("write to", &error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Read as _;

    use super::*;

    const SPEC: &[u8] = br#"{"defer":[],"env":{},"machine":"webserver","ready":[],"scenario_id":"intar/broken-nginx","tasks":[]}"#;

    fn boot<'a>(keys: &'a [String], peers: &'a BTreeMap<String, String>) -> Boot<'a> {
        Boot {
            hostname: "web",
            ip_cidr: "10.77.52.2/28",
            gateway: "10.77.52.1",
            dns: &[],
            peers,
            authorized_keys: keys,
            spec: SPEC,
            host: None,
        }
    }

    #[test]
    fn writes_a_run_disk_the_guest_loader_can_read() {
        let peers = BTreeMap::from([("client".to_owned(), "10.77.52.4".to_owned())]);
        let keys = [
            "ssh-ed25519 AAAA one".to_owned(),
            " ssh-ed25519 AAAA one\n".to_owned(),
        ];
        let json = boot_json(&boot(&keys, &peers)).expect("boot.json");
        let document: GuestBootV3 = serde_json::from_slice(&json).expect("a GuestBootV3");
        assert_eq!(document.contract, 3);
        assert_eq!(
            document.ssh.authorized_keys,
            ["ssh-ed25519 AAAA one"],
            "trimmed, once"
        );
        assert_eq!(document.peers["client"], "10.77.52.4");
        assert_eq!(document.spec.machine, "webserver");

        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("run.raw");
        write_run_disk(&path, &json, b"kino binary").expect("run disk");
        assert_eq!(
            std::fs::metadata(&path).expect("metadata").len(),
            RUN_DISK_BYTES
        );
        let filesystem = fatfs::FileSystem::new(
            std::fs::File::open(&path).expect("open"),
            fatfs::FsOptions::new(),
        )
        .expect("fat");
        assert_eq!(filesystem.volume_label(), "INTARRUN");
        let mut names: Vec<String> = filesystem
            .root_dir()
            .iter()
            .map(|entry| entry.expect("entry").file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["boot.json", "kino"]);
        let mut read = Vec::new();
        filesystem
            .root_dir()
            .open_file("boot.json")
            .expect("boot.json")
            .read_to_end(&mut read)
            .expect("read");
        assert_eq!(read, json);

        let recordings = dir.path().join("rec.vfat");
        write_recording_disk(&recordings).expect("recording disk");
        let filesystem = fatfs::FileSystem::new(
            std::fs::File::open(&recordings).expect("open"),
            fatfs::FsOptions::new(),
        )
        .expect("fat");
        assert_eq!(filesystem.volume_label(), "INTARREC");
        assert_eq!(filesystem.root_dir().iter().count(), 0);
    }

    #[test]
    fn names_the_host_only_when_it_is_not_vsock() {
        let peers = BTreeMap::new();
        let keys = ["ssh-ed25519 AAAA one".to_owned()];
        // Left out, the file is what an agent host writes.
        let vsock = boot_json(&boot(&keys, &peers)).expect("boot.json");
        assert!(!String::from_utf8_lossy(&vsock).contains("\"host\""));

        let mut over_tcp = boot(&keys, &peers);
        over_tcp.host = Some(GuestHostV3::Tcp {
            address: "10.77.52.1".to_owned(),
            report_port: 41081,
            run_cli_port: 41082,
        });
        let document: GuestBootV3 =
            serde_json::from_slice(&boot_json(&over_tcp).expect("boot.json")).expect("parse");
        assert_eq!(document.host, over_tcp.host);
    }

    #[test]
    fn refuses_keys_and_specs_that_would_not_boot_a_usable_machine() {
        let peers = BTreeMap::new();
        for keys in [
            vec![],
            vec![String::new()],
            vec!["ssh-ed25519 AAAA a\nssh-ed25519 AAAA b".to_owned()],
        ] {
            assert!(
                matches!(boot_json(&boot(&keys, &peers)), Err(Error::RunDisk(_))),
                "{keys:?}"
            );
        }
        let keys = ["ssh-ed25519 AAAA one".to_owned()];
        let mut bad = boot(&keys, &peers);
        bad.spec = b"{}";
        assert!(matches!(boot_json(&bad), Err(Error::RunDisk(reason)) if reason.contains("spec")));
    }
}
