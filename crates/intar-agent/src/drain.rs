//! Local control uses the private agent state directory, never an HTTP write endpoint.
use anyhow::{Context as _, Result};
use fs2::FileExt;
use std::{
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};

fn directory() -> Result<PathBuf> {
    let directory = dirs::state_dir()
        .context("agent state directory unavailable")?
        .join("intar-agent");
    std::fs::create_dir_all(&directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(directory)
}

fn lock(directory: &Path, exclusive: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(directory.join("admission.lock"))?;
    // Never block the async executor while another task owns admission.
    if exclusive {
        file.try_lock_exclusive()
    } else {
        FileExt::try_lock_shared(&file)
    }
    .context("agent admission is busy; retry")?;
    Ok(file)
}

pub(crate) fn admit() -> Result<File> {
    admit_in(&directory()?)
}

fn admit_in(directory: &Path) -> Result<File> {
    let lock = lock(directory, false)?;
    anyhow::ensure!(!directory.join("drain").try_exists()?, "agent is draining");
    Ok(lock)
}

pub(crate) fn set(draining: bool) -> Result<()> {
    set_in(&directory()?, draining)
}

fn set_in(directory: &Path, draining: bool) -> Result<()> {
    let _lock = lock(directory, true)?;
    let path = directory.join("drain");
    if draining {
        File::create(&path)?.sync_all()?;
    } else if path.try_exists()? {
        std::fs::remove_file(&path)?;
    }
    File::open(directory)?.sync_all()?;
    Ok(())
}

pub(crate) fn is_draining() -> Result<bool> {
    directory()?
        .join("drain")
        .try_exists()
        .context("read drain state")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drain_is_durable_and_fences_in_flight_admission() {
        let directory = tempfile::tempdir().expect("temporary drain directory");
        let admitted = admit_in(directory.path()).expect("admit before drain");
        assert!(set_in(directory.path(), true).is_err());
        drop(admitted);
        set_in(directory.path(), true).expect("persist drain");
        assert!(directory.path().join("drain").exists());
        assert!(admit_in(directory.path()).is_err());
        set_in(directory.path(), false).expect("resume admission");
        assert!(admit_in(directory.path()).is_ok());
    }
}
