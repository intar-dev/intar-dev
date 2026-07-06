use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

use anyhow::{Context as _, Result};

pub const INTAR_BUILD_SEED_LABEL: [u8; 11] = *b"INTARBUILD ";
pub const INTAR_BUILD_SEED_LABEL_TEXT: &str = "INTARBUILD";
pub const BUILD_ENV_FILENAME: &str = "build.env";
pub const AUTHORIZED_KEYS_FILENAME: &str = "authorized_keys";

const BUILD_SEED_BYTES: u64 = 16 * 1024 * 1024;

pub struct BuildSeedInput<'a> {
    pub path: &'a Path,
    pub ssh_authorized_keys_openssh: &'a [String],
    pub guest_ip_cidr: &'a str,
    pub gateway: &'a str,
    pub dns: &'a str,
    pub iface: Option<&'a str>,
}

pub fn write_build_seed(input: &BuildSeedInput<'_>) -> Result<()> {
    let mut image = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(input.path)
        .with_context(|| format!("failed to create build seed at {}", input.path.display()))?;

    image
        .set_len(BUILD_SEED_BYTES)
        .with_context(|| format!("failed to size build seed at {}", input.path.display()))?;

    let opts = fatfs::FormatVolumeOptions::new().volume_label(INTAR_BUILD_SEED_LABEL);
    fatfs::format_volume(&mut image, opts).context("failed to format build seed as vfat")?;
    image
        .seek(SeekFrom::Start(0))
        .context("failed to seek build seed")?;

    let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
        .context("failed to open formatted build seed filesystem")?;
    let root = fs.root_dir();
    write_file(&root, BUILD_ENV_FILENAME, &render_build_env(input))?;
    write_file(
        &root,
        AUTHORIZED_KEYS_FILENAME,
        &format!("{}\n", input.ssh_authorized_keys_openssh.join("\n")),
    )?;
    Ok(())
}

#[must_use]
pub fn render_build_env(input: &BuildSeedInput<'_>) -> String {
    let mut env = String::new();
    if let Some(iface) = input.iface.filter(|iface| !iface.is_empty()) {
        env.push_str(&format!("INTAR_BUILD_IFACE={}\n", shell_quote(iface)));
    }
    for (key, value) in [
        ("INTAR_BUILD_IP", input.guest_ip_cidr),
        ("INTAR_BUILD_GATEWAY", input.gateway),
        ("INTAR_BUILD_DNS", input.dns),
    ] {
        env.push_str(&format!("{key}={}\n", shell_quote(value)));
    }
    env
}

fn write_file(dir: &fatfs::Dir<'_, std::fs::File>, name: &str, content: &str) -> Result<()> {
    let mut file = dir
        .create_file(name)
        .with_context(|| format!("failed to create {name} in build seed"))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("failed to write {name} in build seed"))?;
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Read as _;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn build_seed_contains_env_and_authorized_keys() {
        let tempdir = tempdir().unwrap();
        let seed_path = tempdir.path().join("intarbuild.img");
        write_build_seed(&BuildSeedInput {
            path: &seed_path,
            ssh_authorized_keys_openssh: &["ssh-ed25519 AAAATEST intar-build".to_string()],
            guest_ip_cidr: "10.0.2.15/24",
            gateway: "10.0.2.2",
            dns: "10.0.2.3",
            iface: Some("eth0"),
        })
        .unwrap();

        let image = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&seed_path)
            .unwrap();
        let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new()).unwrap();
        assert_eq!(fs.volume_label(), INTAR_BUILD_SEED_LABEL_TEXT);

        let root = fs.root_dir();
        let mut build_env = String::new();
        root.open_file(BUILD_ENV_FILENAME)
            .unwrap()
            .read_to_string(&mut build_env)
            .unwrap();
        assert!(build_env.contains("INTAR_BUILD_IFACE='eth0'"));
        assert!(build_env.contains("INTAR_BUILD_IP='10.0.2.15/24'"));
        assert!(build_env.contains("INTAR_BUILD_GATEWAY='10.0.2.2'"));
        assert!(build_env.contains("INTAR_BUILD_DNS='10.0.2.3'"));

        let mut authorized_keys = String::new();
        root.open_file(AUTHORIZED_KEYS_FILENAME)
            .unwrap()
            .read_to_string(&mut authorized_keys)
            .unwrap();
        assert_eq!(authorized_keys, "ssh-ed25519 AAAATEST intar-build\n");
    }

    #[test]
    fn build_env_shell_quotes_values() {
        let tempdir = tempdir().unwrap();
        let rendered = render_build_env(&BuildSeedInput {
            path: &tempdir.path().join("unused.img"),
            ssh_authorized_keys_openssh: &[],
            guest_ip_cidr: "10.0.2.15/24",
            gateway: "10.0.2'2",
            dns: "10.0.2.3",
            iface: Some("eth0"),
        });
        assert!(rendered.contains("INTAR_BUILD_GATEWAY='10.0.2'\\''2'"));
    }

    #[test]
    fn build_env_omits_interface_when_none_is_configured() {
        let tempdir = tempdir().unwrap();
        let rendered = render_build_env(&BuildSeedInput {
            path: &tempdir.path().join("unused.img"),
            ssh_authorized_keys_openssh: &[],
            guest_ip_cidr: "10.0.2.15/24",
            gateway: "10.0.2.2",
            dns: "10.0.2.3",
            iface: None,
        });

        assert!(!rendered.contains("INTAR_BUILD_IFACE"));
        assert!(rendered.contains("INTAR_BUILD_IP='10.0.2.15/24'"));
        assert!(rendered.contains("INTAR_BUILD_GATEWAY='10.0.2.2'"));
    }
}
