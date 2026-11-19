//! Reads the sessions Kino finished off a machine's recordings disk.
//!
//! The disk is a FAT image the guest wrote, so nothing on it is trusted: only
//! plainly named `.krec` files of the root directory are copied, and only
//! once the machine has stopped.
//
// ponytail: the agent still has its own copy of this loop beside its jailer
// export logic (`intar-agent/src/vm/manager/cleanup.rs`); point it here when
// that code is next touched.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use anyhow::{Context as _, Result, ensure};

/// More sessions than the replay is rendered for are not worth copying.
const MAX_SESSIONS: usize = 500;

/// Copies every finished session from the FAT image at `disk` into
/// `directory`, and names the copies in the order the sessions began.
pub fn extract(disk: &Path, directory: &Path) -> Result<Vec<PathBuf>> {
    std::fs::create_dir_all(directory)
        .with_context(|| format!("create {}", directory.display()))?;
    let image = std::fs::File::open(disk).with_context(|| format!("open {}", disk.display()))?;
    let files = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
        .context("the recordings disk is not readable")?;
    let mut copied = Vec::new();
    for entry in files.root_dir().iter() {
        let entry = entry.context("read the recordings disk's directory")?;
        let name = entry.file_name();
        // A session still being written ends in `.krec.partial` and is left.
        let plain = name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'));
        if !entry.is_file() || !plain || !name.ends_with(".krec") || name.starts_with('.') {
            continue;
        }
        ensure!(
            copied.len() < MAX_SESSIONS,
            "the recordings disk holds more than {MAX_SESSIONS} sessions"
        );
        let destination = directory.join(&name);
        let mut bytes = Vec::new();
        entry
            .to_file()
            .read_to_end(&mut bytes)
            .with_context(|| format!("read {name}"))?;
        std::fs::File::create(&destination)
            .and_then(|mut file| file.write_all(&bytes))
            .with_context(|| format!("write {}", destination.display()))?;
        copied.push(destination);
    }
    // Kino's names start with the session's start time, so this is their order.
    copied.sort();
    Ok(copied)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_finished_sessions_in_order_and_nothing_else() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let disk = dir.path().join("rec.vfat");
        let image = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&disk)?;
        image.set_len(8 * 1024 * 1024)?;
        fatfs::format_volume(&image, fatfs::FormatVolumeOptions::new())?;
        {
            let files = fatfs::FileSystem::new(&image, fatfs::FsOptions::new())?;
            let root = files.root_dir();
            for (name, text) in [
                ("ssh-session-200-7.krec", "second"),
                ("ssh-session-100-5.krec", "first"),
                ("ssh-session-300-9.krec.partial", "cut off"),
                ("notes.txt", "not a session"),
            ] {
                root.create_file(name)?.write_all(text.as_bytes())?;
            }
            root.create_dir("nested.krec")?;
        }
        drop(image);

        let out = dir.path().join("out");
        let copied = extract(&disk, &out)?;
        let names: Vec<_> = copied
            .iter()
            .filter_map(|path| path.file_name()?.to_str())
            .collect();
        assert_eq!(names, ["ssh-session-100-5.krec", "ssh-session-200-7.krec"]);
        assert_eq!(std::fs::read_to_string(&copied[0])?, "first");
        assert_eq!(std::fs::read_dir(&out)?.count(), 2);
        Ok(())
    }
}
