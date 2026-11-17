//! Per-host VM snapshots (#348).
//!
//! A capture VM leaves Cloud Hypervisor's snapshot in its jail's `run/snap`.
//! Publishing moves it, with a clone of the VM's root disk, into the image's
//! template directory, so store GC collects it with the template. A restore
//! launch gets hard links to the memory and state files, which every VM
//! restored from the snapshot then shares in the page cache, a clone of the
//! snapshot's root disk, and the VM config with its own TAP name.
//!
//! The memory and state files were written by a hypervisor that ran guest
//! code. Nothing here reads them; only another jailed hypervisor does.

use super::*;
use intar_jailer_protocol::{
    MAX_LISTED_SNAPSHOTS, SNAPSHOT_CONFIG_FILE, SNAPSHOT_MEMORY_FILE, SNAPSHOT_STATE_FILE,
};
use std::os::unix::fs::MetadataExt as _;

const SNAPSHOTS_DIRECTORY: &str = "snapshots";
const METADATA_FILE: &str = "snapshot.json";
const ROOT_DISK_FILE: &str = "root.raw";
const METADATA_SCHEMA: u16 = 1;
const STATE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
const CONFIG_LIMIT_BYTES: u64 = 64 * 1024;
/// What the memory file may exceed the VM's memory by.
const MEMORY_SLACK_BYTES: u64 = 1024 * 1024;

/// Device and inode of a hard link staged into a jail.
pub(super) type LinkIdentity = (u64, u64);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SnapshotMetadata {
    schema_version: u16,
    snapshot: SnapshotInfo,
}

fn template_directory(config: &JailerdConfig, image_id: &Sha256Digest) -> PathBuf {
    config.jail_root.join("templates").join(image_id.as_str())
}

fn snapshot_directory(
    config: &JailerdConfig,
    image_id: &Sha256Digest,
    key: &Sha256Digest,
) -> PathBuf {
    template_directory(config, image_id)
        .join(SNAPSHOTS_DIRECTORY)
        .join(key.as_str())
}

fn launch_image(request: &VmLaunchRequest) -> Result<Sha256Digest> {
    let image = template_source_image(&request.artifacts.root_disk)
        .context("a snapshot launch needs a template-backed root disk")?;
    Ok(Sha256Digest::parse(image.to_owned())?)
}

/// A file of the root-owned store: regular, root's, not writable by others.
fn open_store_file(path: &Path) -> Result<File> {
    let fd = open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .with_context(|| format!("open snapshot file {}", path.display()))?;
    let stat = rustix::fs::fstat(&fd)?;
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
        || stat.st_uid != 0
        || stat.st_mode & 0o022 != 0
    {
        bail!("{} is not a root-owned snapshot file", path.display())
    }
    Ok(File::from(fd))
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_store_file(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "{} is over its size limit",
        path.display()
    );
    Ok(bytes)
}

fn read_metadata(directory: &Path) -> Result<SnapshotInfo> {
    let bytes = read_bounded(&directory.join(METADATA_FILE), CONFIG_LIMIT_BYTES)?;
    let metadata: SnapshotMetadata =
        serde_json::from_slice(&bytes).context("decode snapshot metadata")?;
    ensure!(
        metadata.schema_version == METADATA_SCHEMA,
        "snapshot metadata has another schema"
    );
    Ok(metadata.snapshot)
}

/// What a restore launch stages from: the snapshot's directory and the VM
/// config with the launch's TAP name. A capture or a cold boot has none.
///
/// A launch is checked with this before it is given a UID and a jail: a
/// launch refused only while its jail is staged is quarantined and keeps
/// its UID.
pub(super) fn restore_source(
    config: &JailerdConfig,
    request: &VmLaunchRequest,
) -> Result<Option<(PathBuf, Vec<u8>)>> {
    let Some(SnapshotLaunch::Restore { key }) = &request.snapshot else {
        return Ok(None);
    };
    let image_id = launch_image(request)?;
    let source = snapshot_directory(config, &image_id, key);
    let snapshot = read_metadata(&source).context("the snapshot is not in the store")?;
    ensure!(
        snapshot.image_id == image_id
            && snapshot.key == *key
            && snapshot.cpu_millis == request.cpu_millis
            && snapshot.memory_mib == request.memory_mib
            && snapshot.root_disk_size_bytes == request.root_disk_size_bytes,
        "the launch does not have the shape of its snapshot"
    );
    let config_json = rewrite_tap(
        &read_bounded(&source.join(SNAPSHOT_CONFIG_FILE), CONFIG_LIMIT_BYTES)?,
        &request.tap_name,
    )?;
    Ok(Some((source, config_json)))
}

/// The jail side of a snapshot launch, after the cold-boot artifacts are
/// staged. Each hard link a restore makes is added to `links` as it is
/// made, so a staging that fails later can still be cleaned up.
pub(super) fn stage_snapshot(
    config: &JailerdConfig,
    request: &VmLaunchRequest,
    root: &Path,
    uid: u32,
    gid: u32,
    links: &mut Vec<LinkIdentity>,
) -> Result<()> {
    let snap = root.join("run/snap");
    match &request.snapshot {
        None => Ok(()),
        Some(SnapshotLaunch::Capture) => {
            ensure_directory(&snap, 0o700)?;
            set_owner(&snap, uid, gid)
        }
        Some(SnapshotLaunch::Restore { .. }) => {
            let (source, config_json) =
                restore_source(config, request)?.context("a restore launch has a snapshot")?;
            // The disk as the guest last wrote it, not the template's.
            let root_disk = root.join("disks/root.raw");
            std::fs::remove_file(&root_disk).context("drop the staged template root disk")?;
            stage_prepared_template_source_file(
                open_store_file(&source.join(ROOT_DISK_FILE))?,
                &root_disk,
                0o600,
            )?;
            set_owner(&root_disk, uid, gid)?;

            ensure_directory(&snap, 0o755)?;
            for name in [SNAPSHOT_MEMORY_FILE, SNAPSHOT_STATE_FILE] {
                let stored = open_store_file(&source.join(name))?.metadata()?;
                let link = snap.join(name);
                std::fs::hard_link(source.join(name), &link)
                    .with_context(|| format!("link snapshot {name} into the jail"))?;
                let linked = std::fs::symlink_metadata(&link)?;
                ensure!(
                    (linked.dev(), linked.ino()) == (stored.dev(), stored.ino()),
                    "snapshot {name} changed while it was linked"
                );
                links.push((linked.dev(), linked.ino()));
            }
            let config_path = snap.join(SNAPSHOT_CONFIG_FILE);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o444)
                .open(&config_path)
                .context("create the restore VM config")?;
            file.write_all(&config_json)?;
            // The daemon's umask is 0077: without this the VM cannot read it.
            set_mode(&config_path, 0o444)
        }
    }
}

/// The captured VM config with this launch's TAP name. Everything else stays
/// as the capture's hypervisor wrote it: only a jailed hypervisor acts on it.
pub(super) fn rewrite_tap(config_json: &[u8], tap_name: &str) -> Result<Vec<u8>> {
    let mut config: serde_json::Value =
        serde_json::from_slice(config_json).context("decode the captured VM config")?;
    let net = config
        .get_mut("net")
        .and_then(serde_json::Value::as_array_mut)
        .filter(|net| net.len() == 1)
        .context("the captured VM config does not have exactly one network device")?;
    let device = net[0]
        .as_object_mut()
        .context("the captured network device is not an object")?;
    device.insert("tap".to_owned(), tap_name.into());
    Ok(serde_json::to_vec(&config)?)
}

/// Move a stopped capture VM's snapshot into the store.
pub(super) fn publish_snapshot(
    config: &JailerdConfig,
    record: &VmRecord,
    key: &Sha256Digest,
) -> Result<SnapshotInfo> {
    ensure!(
        record.request.snapshot == Some(SnapshotLaunch::Capture),
        "only a capture VM has a snapshot to publish"
    );
    let image_id = launch_image(&record.request)?;
    let template = template_directory(config, &image_id);
    ensure!(
        template.join("metadata-v2.json").exists(),
        "the capture's image template is gone"
    );
    let published = snapshot_directory(config, &image_id, key);
    ensure!(!published.exists(), "this snapshot is already published");
    let snapshots = template.join(SNAPSHOTS_DIRECTORY);
    ensure_directory(&snapshots, 0o700)?;
    let temporary = snapshots.join(format!(".{}-{}", key.as_str(), Uuid::new_v4()));
    std::fs::create_dir(&temporary).context("create the snapshot staging directory")?;

    let operation = (|| -> Result<SnapshotInfo> {
        let jail_root = trusted_jail_root_fd(config)?;
        let mut directory = open_lifecycle_entry_at(
            &jail_root,
            c"cloud-hypervisor",
            OFlags::RDONLY | OFlags::DIRECTORY,
        )?;
        for name in [record.generation.as_str(), "root", "run", "snap"] {
            let name = CString::new(name).context("jail path component")?;
            directory =
                open_lifecycle_entry_at(&directory, &name, OFlags::RDONLY | OFlags::DIRECTORY)
                    .context("open the capture jail's snapshot directory")?;
        }
        let staging = open(
            &temporary,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?;
        let memory_limit = u64::from(record.request.memory_mib) * 1024 * 1024 + MEMORY_SLACK_BYTES;
        let mut bytes_on_disk = 0_u64;
        for (name, limit) in [
            (SNAPSHOT_MEMORY_FILE, memory_limit),
            (SNAPSHOT_STATE_FILE, STATE_LIMIT_BYTES),
            (SNAPSHOT_CONFIG_FILE, CONFIG_LIMIT_BYTES),
        ] {
            let name_c = CString::new(name).context("snapshot file name")?;
            let fd = open_lifecycle_entry_at(&directory, &name_c, OFlags::RDONLY)
                .with_context(|| format!("open captured {name}"))?;
            let stat = rustix::fs::fstat(&fd)?;
            if rustix::fs::FileType::from_raw_mode(stat.st_mode)
                != rustix::fs::FileType::RegularFile
                || stat.st_uid != record.uid
                || stat.st_nlink != 1
                || stat.st_size < 0
                || stat.st_size as u64 > limit
            {
                bail!("captured {name} is not one regular file of the VM within its size limit")
            }
            rustix::fs::renameat(&directory, &name_c, &staging, &name_c)
                .with_context(|| format!("move captured {name} into the store"))?;
            rustix::fs::fchown(
                &fd,
                Some(rustix::process::Uid::ROOT),
                Some(rustix::process::Gid::ROOT),
            )?;
            rustix::fs::fchmod(&fd, Mode::RUSR | Mode::RGRP | Mode::ROTH)?;
            bytes_on_disk = bytes_on_disk.saturating_add(stat.st_blocks as u64 * 512);
        }
        // The capture VM is stopped: its root disk is as the paused guest
        // left it, which is what the memory file expects to find.
        let root_disk = File::from(open(
            &record.paths.host_root_disk,
            OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
            Mode::empty(),
        )?);
        let disk = root_disk.metadata()?;
        ensure!(
            disk.is_file() && disk.uid() == record.uid && disk.nlink() == 1,
            "the capture's root disk is not one regular file of the VM"
        );
        stage_prepared_template_source_file(root_disk, &temporary.join(ROOT_DISK_FILE), 0o444)?;
        bytes_on_disk = bytes_on_disk.saturating_add(disk.blocks() * 512);

        let snapshot = SnapshotInfo {
            image_id: image_id.clone(),
            key: key.clone(),
            cpu_millis: record.request.cpu_millis,
            memory_mib: record.request.memory_mib,
            root_disk_size_bytes: record.request.root_disk_size_bytes,
            captured_at_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |since| since.as_millis() as u64),
            bytes_on_disk,
        };
        let mut metadata = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o444)
            .open(temporary.join(METADATA_FILE))?;
        to_writer(
            &mut metadata,
            &SnapshotMetadata {
                schema_version: METADATA_SCHEMA,
                snapshot: snapshot.clone(),
            },
        )?;
        metadata.sync_all()?;
        set_mode(&temporary.join(METADATA_FILE), 0o444)?;
        // A config no restore could use must not become a snapshot.
        rewrite_tap(
            &read_bounded(&temporary.join(SNAPSHOT_CONFIG_FILE), CONFIG_LIMIT_BYTES)?,
            &record.request.tap_name,
        )
        .context("the captured VM config is unusable")?;
        set_mode(&temporary, 0o755)?;
        std::fs::rename(&temporary, &published).context("publish the snapshot")?;
        Ok(snapshot)
    })();
    if operation.is_err() {
        let _ = std::fs::remove_dir_all(&temporary);
    }
    operation
}

/// Remove a published snapshot. VMs restored from it keep running: their
/// links and clones hold the data.
pub(super) fn remove_snapshot(
    config: &JailerdConfig,
    image_id: &Sha256Digest,
    key: &Sha256Digest,
) -> Result<bool> {
    let directory = snapshot_directory(config, image_id, key);
    match std::fs::remove_dir_all(&directory) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("remove {}", directory.display())),
    }
}

fn directories(path: &Path) -> Result<Vec<PathBuf>> {
    let entries = match std::fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).with_context(|| format!("list {}", path.display())),
    };
    let mut found = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        if entry.file_type()?.is_dir()
            && Sha256Digest::parse(name.to_string_lossy().into_owned()).is_ok()
        {
            found.push(entry.path());
        }
    }
    found.sort();
    Ok(found)
}

/// Every published snapshot. One that does not read back is left out; the
/// agent then captures it again and the publish replaces nothing.
pub(super) fn list_snapshots(config: &JailerdConfig) -> Result<Vec<SnapshotInfo>> {
    let mut snapshots = Vec::new();
    for template in directories(&config.jail_root.join("templates"))? {
        for directory in directories(&template.join(SNAPSHOTS_DIRECTORY))? {
            if let Ok(snapshot) = read_metadata(&directory) {
                snapshots.push(snapshot);
            }
        }
    }
    ensure!(
        snapshots.len() <= MAX_LISTED_SNAPSHOTS,
        "the store holds more snapshots than one listing carries"
    );
    Ok(snapshots)
}

/// What a template's snapshots hold on disk, for store accounting. The
/// root disk is left out: it is a clone that shares nearly all of its
/// blocks with the template's chunks, which are counted already (measured:
/// 4.7 GB apparent, a few hundred MB its own).
pub(super) fn template_snapshot_bytes(template: &Path) -> u64 {
    let Ok(snapshots) = std::fs::read_dir(template.join(SNAPSHOTS_DIRECTORY)) else {
        return 0;
    };
    snapshots
        .filter_map(Result::ok)
        .filter_map(|snapshot| std::fs::read_dir(snapshot.path()).ok())
        .flatten()
        .filter_map(Result::ok)
        .filter(|file| file.file_name() != ROOT_DISK_FILE)
        .filter_map(|file| file.metadata().ok())
        .map(|metadata| metadata.blocks().saturating_mul(512))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_restore_config_changes_the_tap_name_and_nothing_else() -> Result<()> {
        let captured = br#"{"cpus":{"boot_vcpus":2},"net":[{"tap":"tapcapture","mac":"02:00:00:00:00:01","id":"_net0"}],"vsock":{"cid":3}}"#;
        let restored: serde_json::Value = serde_json::from_slice(&rewrite_tap(captured, "tap7")?)?;
        assert_eq!(
            restored,
            serde_json::json!({
                "cpus": {"boot_vcpus": 2},
                "net": [{"tap": "tap7", "mac": "02:00:00:00:00:01", "id": "_net0"}],
                "vsock": {"cid": 3}
            })
        );
        Ok(())
    }

    #[test]
    fn a_config_without_exactly_one_network_device_is_refused() {
        for config in [
            r#"{}"#,
            r#"{"net":[]}"#,
            r#"{"net":[{"tap":"a"},{"tap":"b"}]}"#,
            r#"{"net":["tap"]}"#,
            r#"not json"#,
        ] {
            assert!(rewrite_tap(config.as_bytes(), "tap7").is_err(), "{config}");
        }
    }
}
