//! The QEMU the app ships with (#403): the system emulator and `qemu-img`
//! that `tools/workflows/qemu/build.sh` builds. The app runs these and no
//! others; a QEMU on `PATH` is never used.

use std::path::{Path, PathBuf};

/// Names the directory of a development build's QEMU, for a program that is
/// not beside one, such as a test.
const OVERRIDE: &str = "INTAR_QEMU";

pub struct Tools {
    pub system: PathBuf,
    pub img: PathBuf,
}

/// The app's QEMU for a program at `program`: `qemu/bin` beside it, as
/// `cuenv task jumper-qemu` unpacks it, or `Helpers` of the app bundle it is in.
pub fn tools(program: &Path, system: &str) -> Result<Tools, String> {
    let beside = program.parent().unwrap_or(Path::new("."));
    let places = [
        std::env::var_os(OVERRIDE).map(PathBuf::from),
        Some(beside.join("qemu").join("bin")),
        Some(beside.join("..").join("Helpers")),
    ];
    places
        .into_iter()
        .flatten()
        .map(|place| Tools {
            system: place.join(system),
            img: place.join("qemu-img"),
        })
        .find(|tools| tools.system.is_file() && tools.img.is_file())
        .ok_or_else(|| {
            "The app's own QEMU is missing, so it cannot start a machine. Install the app again."
                .to_owned()
        })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::tools;

    #[test]
    fn only_the_apps_own_qemu_is_found() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("MacOS").join("jumper");
        std::fs::create_dir_all(dir.path().join("MacOS")).unwrap();
        // Nothing beside the program: a QEMU on PATH is not looked for.
        let missing = tools(&program, "qemu-system-aarch64").err().unwrap();
        assert!(missing.contains("own QEMU is missing"), "{missing}");

        // An app bundle keeps its helper programs in Contents/Helpers.
        let helpers = dir.path().join("Helpers");
        std::fs::create_dir_all(&helpers).unwrap();
        std::fs::write(helpers.join("qemu-system-aarch64"), b"").unwrap();
        assert!(tools(&program, "qemu-system-aarch64").is_err());
        std::fs::write(helpers.join("qemu-img"), b"").unwrap();
        let found = tools(&program, "qemu-system-aarch64").ok().unwrap();
        assert!(found.system.ends_with("Helpers/qemu-system-aarch64"));

        // A development build has them unpacked beside it, and that wins.
        let beside = dir.path().join("MacOS").join("qemu").join("bin");
        std::fs::create_dir_all(&beside).unwrap();
        std::fs::write(beside.join("qemu-system-aarch64"), b"").unwrap();
        std::fs::write(beside.join("qemu-img"), b"").unwrap();
        let found = tools(&program, "qemu-system-aarch64").ok().unwrap();
        assert!(found.img.ends_with("qemu/bin/qemu-img"));
    }
}
