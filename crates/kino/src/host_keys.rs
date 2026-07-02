use std::fs;
use std::path::Path;

const SSH_DIR: &str = "/etc/ssh";
const HOST_KEY_PREFIX: &str = "ssh_host_";
const HOST_KEY_SUFFIX: &str = ".pub";

pub(crate) fn collect_ssh_host_keys_openssh() -> Vec<String> {
    collect_ssh_host_keys_from_dir(Path::new(SSH_DIR))
}

fn collect_ssh_host_keys_from_dir(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    let mut keys = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            (name.starts_with(HOST_KEY_PREFIX) && name.ends_with(HOST_KEY_SUFFIX))
                .then(|| entry.path())
        })
        .filter_map(|path| fs::read_to_string(path).ok())
        .flat_map(|content| {
            content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    keys.sort();
    keys.dedup();
    keys
}

#[cfg(test)]
mod tests {
    use super::collect_ssh_host_keys_from_dir;

    #[test]
    fn collects_only_public_host_keys() {
        let dir = tempfile::tempdir().expect("tempdir should exist");
        std::fs::write(
            dir.path().join("ssh_host_ed25519_key.pub"),
            "ssh-ed25519 AAAAONE host\n",
        )
        .expect("write ed25519 key");
        std::fs::write(dir.path().join("ssh_host_ed25519_key"), "private")
            .expect("write private key");
        std::fs::write(
            dir.path().join("authorized_keys.pub"),
            "ssh-ed25519 AAAAUSER user",
        )
        .expect("write non-host key");

        assert_eq!(
            collect_ssh_host_keys_from_dir(dir.path()),
            vec!["ssh-ed25519 AAAAONE host".to_string()]
        );
    }
}
