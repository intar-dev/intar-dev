use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const RUNTIME_DISK_LABEL: [u8; 11] = *b"INTARRUN   ";
pub const RECORDING_DISK_LABEL: [u8; 11] = *b"INTARREC   ";
pub const RUNTIME_ENV_FILENAME: &str = "runtime.env";
pub const RUNTIME_AUTHORIZED_KEYS_FILENAME: &str = "authorized_keys";
pub const GUEST_USERNAME: &str = "user";

pub const ENV_SSH_AUTHORIZED_KEYS_B64: &str = "INTAR_SSH_AUTHORIZED_KEYS_B64";
pub const ENV_KINO_VSOCK_CID: &str = "KINO_VSOCK_CID";
pub const ENV_KINO_VSOCK_PORT: &str = "KINO_VSOCK_PORT";
pub const ENV_KINO_HOST_READY_PORT: &str = "KINO_HOST_READY_PORT";
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

    pub fn parse(raw: &str) -> Result<Self, RuntimeEnvParseError> {
        let values = parse_env(raw)?;
        Ok(Self {
            ssh_authorized_keys_openssh: parse_authorized_keys(&values)?,
            kino_vsock_cid: parse_u32(&values, ENV_KINO_VSOCK_CID)?,
            kino_vsock_port: parse_u32(&values, ENV_KINO_VSOCK_PORT)?,
            kino_host_ready_port: parse_u32(&values, ENV_KINO_HOST_READY_PORT)?,
            vm_hostname: required(&values, ENV_VM_HOSTNAME)?,
            guest_ip_cidr: required(&values, ENV_GUEST_IP_CIDR)?,
            gateway: required(&values, ENV_GATEWAY)?,
            dns_servers: required(&values, ENV_DNS_SERVERS)?
                .split_whitespace()
                .map(ToOwned::to_owned)
                .collect(),
            root_resize_required: values
                .get(ENV_ROOT_RESIZE_REQUIRED)
                .map(|value| value != "0")
                .unwrap_or(true),
            peer_guest_ips: parse_peer_guest_ips(&values)?,
        })
    }
}

#[derive(Debug, Eq, PartialEq)]
pub enum RuntimeEnvParseError {
    InvalidLine(String),
    MissingKey(&'static str),
    InvalidNumber(&'static str),
    InvalidBase64(&'static str),
    InvalidUtf8(&'static str),
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

fn parse_env(raw: &str) -> Result<BTreeMap<String, String>, RuntimeEnvParseError> {
    let mut values = BTreeMap::new();
    for line in raw.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            return Err(RuntimeEnvParseError::InvalidLine(line.to_owned()));
        };
        values.insert(key.to_owned(), parse_value(value)?);
    }
    Ok(values)
}

fn parse_value(value: &str) -> Result<String, RuntimeEnvParseError> {
    if !(value.starts_with('\'') && value.ends_with('\'')) {
        return Ok(value.to_owned());
    }
    let inner = &value[1..value.len() - 1];
    Ok(inner.replace("'\\''", "'"))
}

fn required(
    values: &BTreeMap<String, String>,
    key: &'static str,
) -> Result<String, RuntimeEnvParseError> {
    values
        .get(key)
        .cloned()
        .ok_or(RuntimeEnvParseError::MissingKey(key))
}

fn parse_u32(
    values: &BTreeMap<String, String>,
    key: &'static str,
) -> Result<u32, RuntimeEnvParseError> {
    required(values, key)?
        .parse()
        .map_err(|_| RuntimeEnvParseError::InvalidNumber(key))
}

fn parse_authorized_keys(
    values: &BTreeMap<String, String>,
) -> Result<Vec<String>, RuntimeEnvParseError> {
    let raw = required(values, ENV_SSH_AUTHORIZED_KEYS_B64)?;
    let decoded = BASE64_STANDARD
        .decode(raw)
        .map_err(|_| RuntimeEnvParseError::InvalidBase64(ENV_SSH_AUTHORIZED_KEYS_B64))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| RuntimeEnvParseError::InvalidUtf8(ENV_SSH_AUTHORIZED_KEYS_B64))?;
    Ok(decoded
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect())
}

fn parse_peer_guest_ips(
    values: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, RuntimeEnvParseError> {
    let raw = required(values, ENV_PEER_HOSTS_B64)?;
    let decoded = BASE64_STANDARD
        .decode(raw)
        .map_err(|_| RuntimeEnvParseError::InvalidBase64(ENV_PEER_HOSTS_B64))?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| RuntimeEnvParseError::InvalidUtf8(ENV_PEER_HOSTS_B64))?;
    Ok(decoded
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let ip = fields.next()?;
            let peer_name = fields.next()?;
            Some((peer_name.to_owned(), ip.to_owned()))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_env_round_trips_shell_quoted_values() {
        let env = RuntimeEnv {
            ssh_authorized_keys_openssh: vec![
                "ssh-ed25519 AAAATEST stargate's key".to_owned(),
                "ssh-ed25519 AAAAOTHER browser key".to_owned(),
            ],
            kino_vsock_cid: 10_001,
            kino_vsock_port: 18_080,
            kino_host_ready_port: 18_081,
            vm_hostname: "broken-nginx".to_owned(),
            guest_ip_cidr: "10.200.0.2/24".to_owned(),
            gateway: "10.200.0.1".to_owned(),
            dns_servers: vec!["1.1.1.1".to_owned(), "8.8.8.8".to_owned()],
            root_resize_required: false,
            peer_guest_ips: BTreeMap::from([
                ("db".to_owned(), "10.200.0.3".to_owned()),
                ("redis-cache".to_owned(), "10.200.0.4".to_owned()),
            ]),
        };

        let rendered = env.render();
        assert!(rendered.contains("INTAR_SSH_AUTHORIZED_KEYS_B64='"));
        assert!(rendered.contains("KINO_HOST_READY_PORT='18081'"));
        assert!(rendered.contains("INTAR_PEER_DB_IP='10.200.0.3'"));
        assert!(rendered.contains("INTAR_PEER_REDIS_CACHE_IP='10.200.0.4'"));
        // The hosts fragment keeps the exact hyphenated VM name that the
        // env-var key form has to sanitize away.
        let hosts_b64 = rendered
            .lines()
            .find_map(|line| line.strip_prefix("INTAR_PEER_HOSTS_B64='"))
            .and_then(|value| value.strip_suffix('\''))
            .expect("peer hosts line present");
        let hosts = String::from_utf8(BASE64_STANDARD.decode(hosts_b64).expect("valid base64"))
            .expect("valid utf8");
        assert_eq!(hosts, "10.200.0.3 db\n10.200.0.4 redis-cache\n");
        assert_eq!(RuntimeEnv::parse(&rendered), Ok(env));
    }

    #[test]
    fn authorized_keys_are_newline_terminated() {
        // The guest supervisor reads these keys with `while read`; every key,
        // including the last, must be newline-terminated so none is dropped.
        let env = RuntimeEnv {
            ssh_authorized_keys_openssh: vec!["ssh-ed25519 AAAAONLYKEY only".to_owned()],
            kino_vsock_cid: 10_001,
            kino_vsock_port: 18_080,
            kino_host_ready_port: 18_081,
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
