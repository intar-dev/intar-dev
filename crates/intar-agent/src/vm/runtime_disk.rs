#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::io::{Seek as _, SeekFrom, Write as _};
use std::path::Path;

use anyhow::{Context as _, Result};
use intar_contracts::guest::{RUNTIME_DISK_LABEL, RUNTIME_ENV_FILENAME, RuntimeEnv};

use super::manager::CreateVmNetwork;

const RUNTIME_DISK_BYTES: u64 = 16 * 1024 * 1024;

pub struct RuntimeDiskInput<'a> {
    pub path: &'a Path,
    pub ssh_authorized_keys_openssh: &'a [String],
    pub kino_vsock_cid: u32,
    pub kino_vsock_port: u32,
    pub kino_host_ready_port: u32,
    pub hostname: &'a str,
    pub network: &'a CreateVmNetwork,
    pub peer_guest_ips: &'a BTreeMap<String, String>,
}

pub fn write_runtime_disk(input: &RuntimeDiskInput<'_>) -> Result<()> {
    let mut img = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(input.path)
        .with_context(|| {
            format!(
                "failed to create scenario runtime disk at {}",
                input.path.display()
            )
        })?;

    img.set_len(RUNTIME_DISK_BYTES).with_context(|| {
        format!(
            "failed to set scenario runtime disk size at {}",
            input.path.display()
        )
    })?;

    let opts = fatfs::FormatVolumeOptions::new().volume_label(RUNTIME_DISK_LABEL);
    fatfs::format_volume(&mut img, opts)
        .context("failed to format scenario runtime disk as vfat")?;

    img.seek(SeekFrom::Start(0))
        .context("failed to seek scenario runtime disk")?;

    let fs = fatfs::FileSystem::new(img, fatfs::FsOptions::new())
        .context("failed to open formatted scenario runtime disk filesystem")?;
    let root = fs.root_dir();

    write_file(&root, RUNTIME_ENV_FILENAME, &runtime_env(input).render())?;

    Ok(())
}

fn runtime_env(input: &RuntimeDiskInput<'_>) -> RuntimeEnv {
    RuntimeEnv {
        ssh_authorized_keys_openssh: input.ssh_authorized_keys_openssh.to_vec(),
        kino_vsock_cid: input.kino_vsock_cid,
        kino_vsock_port: input.kino_vsock_port,
        kino_host_ready_port: input.kino_host_ready_port,
        vm_hostname: input.hostname.to_owned(),
        guest_ip_cidr: input.network.guest_ip_cidr.clone(),
        gateway: input.network.gateway.clone(),
        dns_servers: input.network.dns.clone(),
        peer_guest_ips: input.peer_guest_ips.clone(),
    }
}

fn write_file(dir: &fatfs::Dir<'_, std::fs::File>, name: &str, content: &str) -> Result<()> {
    let mut file = dir
        .create_file(name)
        .with_context(|| format!("failed to create {name} in scenario runtime disk"))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("failed to write {name} in scenario runtime disk"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::io::Read as _;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn runtime_disk_contains_runtime_env_file() {
        let tempdir = tempdir().expect("tempdir should exist");
        let disk_path = tempdir.path().join("runtime.img");
        let network = CreateVmNetwork {
            guest_ip_cidr: "10.200.0.2/24".to_string(),
            gateway: "10.200.0.1".to_string(),
            dns: vec!["1.1.1.1".to_string(), "8.8.8.8".to_string()],
        };
        let peer_guest_ips = BTreeMap::from([
            ("db".to_string(), "10.200.0.3".to_string()),
            ("redis-cache".to_string(), "10.200.0.4".to_string()),
        ]);

        write_runtime_disk(&RuntimeDiskInput {
            path: &disk_path,
            ssh_authorized_keys_openssh: &["ssh-ed25519 AAAATEST stargate-target".to_string()],
            kino_vsock_cid: 10_001,
            kino_vsock_port: 18_080,
            kino_host_ready_port: 18_081,
            hostname: "broken-nginx",
            network: &network,
            peer_guest_ips: &peer_guest_ips,
        })
        .expect("runtime disk should be created");

        let image = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&disk_path)
            .expect("runtime disk should be openable");
        let fs = fatfs::FileSystem::new(image, fatfs::FsOptions::new())
            .expect("runtime disk should contain a vfat filesystem");
        let root = fs.root_dir();

        let mut runtime_env = String::new();
        root.open_file("runtime.env")
            .expect("runtime.env should exist")
            .read_to_string(&mut runtime_env)
            .expect("runtime.env should be readable");
        assert!(runtime_env.contains("INTAR_SSH_AUTHORIZED_KEYS_B64='"));
        assert!(runtime_env.contains("KINO_VSOCK_CID='10001'"));
        assert!(runtime_env.contains("KINO_VSOCK_PORT='18080'"));
        assert!(runtime_env.contains("KINO_HOST_READY_PORT='18081'"));
        assert!(runtime_env.contains("INTAR_VM_HOSTNAME='broken-nginx'"));
        assert!(runtime_env.contains("INTAR_GUEST_IP_CIDR='10.200.0.2/24'"));
        assert!(runtime_env.contains("INTAR_GATEWAY='10.200.0.1'"));
        assert!(runtime_env.contains("INTAR_DNS_SERVERS='1.1.1.1 8.8.8.8'"));
        assert!(runtime_env.contains("INTAR_PEER_DB_IP='10.200.0.3'"));
        assert!(runtime_env.contains("INTAR_PEER_REDIS_CACHE_IP='10.200.0.4'"));
        assert!(runtime_env.contains("INTAR_PEER_HOSTS_B64='"));
    }
}
