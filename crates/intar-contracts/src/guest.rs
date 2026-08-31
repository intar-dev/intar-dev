use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const RUNTIME_DISK_LABEL: [u8; 11] = *b"INTARRUN   ";
pub const RECORDING_DISK_LABEL: [u8; 11] = *b"INTARREC   ";
pub const TOOLS_DISK_LABEL: &str = "INTARTOOLS";
pub const RUNTIME_ENV_FILENAME: &str = "runtime.env";
pub const RUNTIME_AUTHORIZED_KEYS_FILENAME: &str = "authorized_keys";
pub const GUEST_USERNAME: &str = "user";

pub const ENV_SSH_AUTHORIZED_KEYS_B64: &str = "INTAR_SSH_AUTHORIZED_KEYS_B64";
pub const ENV_KINO_VSOCK_CID: &str = "KINO_VSOCK_CID";
pub const ENV_KINO_VSOCK_PORT: &str = "KINO_VSOCK_PORT";
pub const ENV_KINO_HOST_READY_PORT: &str = "KINO_HOST_READY_PORT";
pub const ENV_KINO_SHA256: &str = "INTAR_KINO_SHA256";
pub const ENV_GUEST_BOOTSTRAP_ABI: &str = "INTAR_GUEST_BOOTSTRAP_ABI";
pub const ENV_VM_HOSTNAME: &str = "INTAR_VM_HOSTNAME";
pub const ENV_GUEST_IP_CIDR: &str = "INTAR_GUEST_IP_CIDR";
pub const ENV_GATEWAY: &str = "INTAR_GATEWAY";
pub const ENV_DNS_SERVERS: &str = "INTAR_DNS_SERVERS";
pub const ENV_ROOT_RESIZE_REQUIRED: &str = "INTAR_ROOT_RESIZE_REQUIRED";
pub const ENV_PEER_PREFIX: &str = "INTAR_PEER_";
pub const ENV_PEER_SUFFIX: &str = "_IP";
pub const ENV_PEER_HOSTS_B64: &str = "INTAR_PEER_HOSTS_B64";

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RuntimeEnv {
    pub ssh_authorized_keys_openssh: Vec<String>,
    pub kino_vsock_cid: u32,
    pub kino_vsock_port: u32,
    pub kino_host_ready_port: u32,
    pub kino_sha256: String,
    pub guest_bootstrap_abi: u16,
    pub vm_hostname: String,
    pub guest_ip_cidr: String,
    pub gateway: String,
    pub dns_servers: Vec<String>,
    /// Whether the host expanded the root block device beyond the image's
    /// built filesystem size. Older runtime disks omit this value and guests
    /// conservatively retain the resize step.
    pub root_resize_required: bool,
    pub peer_guest_ips: BTreeMap<String, String>,
}

impl RuntimeEnv {
    pub fn render(&self) -> String {
        let mut lines = [
            render_line(
                ENV_SSH_AUTHORIZED_KEYS_B64,
                // Terminate every key with a newline. The guest supervisor
                // reads these with `while read`, which drops a final line that
                // is not newline-terminated — so a single key (the common
                // case) would otherwise never be written to authorized_keys.
                &BASE64_STANDARD.encode(
                    self.ssh_authorized_keys_openssh
                        .iter()
                        .map(|key| format!("{key}\n"))
                        .collect::<String>(),
                ),
            ),
            render_line(ENV_KINO_VSOCK_CID, &self.kino_vsock_cid.to_string()),
            render_line(ENV_KINO_VSOCK_PORT, &self.kino_vsock_port.to_string()),
            render_line(
                ENV_KINO_HOST_READY_PORT,
                &self.kino_host_ready_port.to_string(),
            ),
            render_line(ENV_KINO_SHA256, &self.kino_sha256),
            render_line(
                ENV_GUEST_BOOTSTRAP_ABI,
                &self.guest_bootstrap_abi.to_string(),
            ),
            render_line(ENV_VM_HOSTNAME, &self.vm_hostname),
            render_line(ENV_GUEST_IP_CIDR, &self.guest_ip_cidr),
            render_line(ENV_GATEWAY, &self.gateway),
            render_line(ENV_DNS_SERVERS, &self.dns_servers.join(" ")),
            render_line(
                ENV_ROOT_RESIZE_REQUIRED,
                if self.root_resize_required { "1" } else { "0" },
            ),
            // The canonical peer map: a base64-encoded /etc/hosts fragment.
            // The per-peer INTAR_PEER_<VM>_IP variables below sanitize VM
            // names into env-var keys, which is lossy (`redis-cache` and
            // `redis_cache` collide) — this fragment preserves exact names so
            // the guest can install them as resolvable hostnames.
            render_line(
                ENV_PEER_HOSTS_B64,
                &BASE64_STANDARD.encode(
                    self.peer_guest_ips
                        .iter()
                        .map(|(peer_name, ip)| format!("{ip} {peer_name}\n"))
                        .collect::<String>(),
                ),
            ),
        ]
        .into_iter()
        .collect::<Vec<_>>();
        lines.extend(
            self.peer_guest_ips
                .iter()
                .map(|(peer_name, ip)| render_line(&peer_env_key(peer_name), ip)),
        );
        lines.join("")
    }
}

fn render_line(key: &str, value: &str) -> String {
    format!("{key}={}\n", shell_single_quoted(value))
}

fn peer_env_key(peer_name: &str) -> String {
    let suffix = peer_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("{ENV_PEER_PREFIX}{suffix}{ENV_PEER_SUFFIX}")
}

fn shell_single_quoted(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorized_keys_are_newline_terminated() {
        // The guest supervisor reads these keys with `while read`; every key,
        // including the last, must be newline-terminated so none is dropped.
        let env = RuntimeEnv {
            ssh_authorized_keys_openssh: vec!["ssh-ed25519 AAAAONLYKEY only".to_owned()],
            kino_vsock_cid: 10_001,
            kino_vsock_port: 18_080,
            kino_host_ready_port: 18_081,
            kino_sha256: "b".repeat(64),
            guest_bootstrap_abi: 1,
            vm_hostname: "pair-ping-db".to_owned(),
            guest_ip_cidr: "10.200.0.2/24".to_owned(),
            gateway: "10.200.0.1".to_owned(),
            dns_servers: vec!["1.1.1.1".to_owned()],
            root_resize_required: true,
            peer_guest_ips: BTreeMap::new(),
        };
        let rendered = env.render();
        let b64 = rendered
            .lines()
            .find_map(|line| line.strip_prefix("INTAR_SSH_AUTHORIZED_KEYS_B64='"))
            .and_then(|value| value.strip_suffix('\''))
            .expect("authorized keys line present");
        let decoded = String::from_utf8(BASE64_STANDARD.decode(b64).expect("valid base64"))
            .expect("valid utf8");
        assert_eq!(decoded, "ssh-ed25519 AAAAONLYKEY only\n");
    }
}
