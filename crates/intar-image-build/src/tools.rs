//! The tools a build needs that no distribution package brings, pinned: what
//! `intar-image-cli setup` puts on a pipeline's runner. The builder host's
//! `tools/image-build/setup-layered-builder.sh` installs the same ones, and
//! a test here fails when the two disagree.

use std::fs;
use std::io;
use std::path::Path;

use anyhow::{Context, Result, bail};

pub const BUILDKIT_VERSION: &str = "v0.30.0";
/// Of `buildkit-<version>.linux-amd64.tar.gz`.
pub const BUILDKIT_ARCHIVE_SHA256: &str =
    "2da148c50540409988c837e62b72176e4a9ad7855548a2dd6ea1cd0c0d2d360d";
/// Of `buildkit-<version>.linux-arm64.tar.gz`.
pub const BUILDKIT_ARCHIVE_SHA256_ARM64: &str =
    "d0c9601e49f441dcc5c6493c884275a5470dcc9c188c96573c4dd503f2fde97d";
/// The daemon of the same version as a container, by its index digest. The
/// image brings the emulators an arm64 base is built with on an amd64 host;
/// the index also has a linux/arm64 image, for an arm64 host.
pub const BUILDKIT_IMAGE: &str =
    "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f";
/// What the daemon may keep before it collects, in bytes: with the converted
/// bases beside it, the OCI cache's 8 GiB.
pub const BUILDKIT_MAX_USED_BYTES: u64 = 6 * 1024 * 1024 * 1024;

pub const UMOCI_VERSION: &str = "v0.6.0";
/// Of `umoci.linux.amd64`.
pub const UMOCI_SHA256: &str = "b51c267ec394499e42c6fde47f240b7b7dba57ea49df0b5acd304378b82a3b71";
/// Of `umoci.linux.arm64`.
pub const UMOCI_SHA256_ARM64: &str =
    "5cfd17f2e7a4bcf9ed67ea1b955ca893d200349b9ce6a3d3707dba415f458a1f";

/// Writes the regular file `member` of the gzipped tar `archive` to `dest`.
/// `member` is its path in the archive, with or without a leading directory.
///
/// # Errors
/// Returns an error when the archive cannot be read or has no such file.
pub fn extract_member(archive: &Path, member: &str, dest: &Path) -> Result<()> {
    let file =
        fs::File::open(archive).with_context(|| format!("failed to open {}", archive.display()))?;
    let mut entries = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in entries
        .entries()
        .with_context(|| format!("{} is not a gzipped tar", archive.display()))?
    {
        let mut entry = entry.with_context(|| format!("failed to read {}", archive.display()))?;
        let path = entry.path()?.into_owned();
        let named = path.ends_with(member);
        if !named || !entry.header().entry_type().is_file() {
            continue;
        }
        let mut out = fs::File::create(dest)
            .with_context(|| format!("failed to create {}", dest.display()))?;
        io::copy(&mut entry, &mut out)
            .with_context(|| format!("failed to write {}", dest.display()))?;
        return Ok(());
    }
    bail!("{} holds no file '{member}'", archive.display())
}

#[cfg(test)]
mod tests {
    use super::{
        BUILDKIT_ARCHIVE_SHA256, BUILDKIT_IMAGE, BUILDKIT_MAX_USED_BYTES, BUILDKIT_VERSION,
        UMOCI_SHA256, UMOCI_VERSION,
    };

    #[test]
    fn the_pins_are_the_builder_hosts() {
        let script = include_str!("../../../tools/image-build/setup-layered-builder.sh");
        let value = |name: &str| {
            let line = script
                .lines()
                .find(|line| line.starts_with(&format!("readonly {name}=")))
                .unwrap_or_else(|| panic!("the script sets {name}"));
            line.split('"').nth(1).expect("a quoted value").to_owned()
        };
        assert_eq!(value("BUILDKIT_VERSION"), BUILDKIT_VERSION);
        assert_eq!(value("BUILDKIT_ARCHIVE_SHA256"), BUILDKIT_ARCHIVE_SHA256);
        assert_eq!(value("UMOCI_VERSION"), UMOCI_VERSION);
        assert_eq!(value("UMOCI_SHA256"), UMOCI_SHA256);
        assert_eq!(
            value("BUILDKIT_MAX_USED_BYTES"),
            BUILDKIT_MAX_USED_BYTES.to_string()
        );
        // The daemon's image is of the client's version.
        assert!(BUILDKIT_IMAGE.starts_with(&format!("moby/buildkit:{BUILDKIT_VERSION}@sha256:")));
    }
}
