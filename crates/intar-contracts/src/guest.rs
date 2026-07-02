use std::collections::BTreeMap;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64_STANDARD};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

pub const RUNTIME_DISK_LABEL: [u8; 11] = *b"INTARRUN   ";
pub const RECORDING_DISK_LABEL: [u8; 11] = *b"INTARREC   ";
pub const RUNTIME_ENV_FILENAME: &str = "runtime.env";
pub const GUEST_USERNAME: &str = "user";

pub const ENV_SSH_AUTHORIZED_KEYS_B64: &str = "INTAR_SSH_AUTHORIZED_KEYS_B64";
pub const ENV_KINO_VSOCK_CID: &str = "KINO_VSOCK_CID";
pub const ENV_KINO_VSOCK_PORT: &str = "KINO_VSOCK_PORT";
pub const ENV_KINO_HOST_READY_PORT: &str = "KINO_HOST_READY_PORT";
pub const ENV_VM_HOSTNAME: &str = "INTAR_VM_HOSTNAME";
pub const ENV_GUEST_IP_CIDR: &str = "INTAR_GUEST_IP_CIDR";
pub const ENV_GATEWAY: &str = "INTAR_GATEWAY";
pub const ENV_DNS_SERVERS: &str = "INTAR_DNS_SERVERS";

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
}

impl RuntimeEnv {
    pub fn render(&self) -> String {
        [
            render_line(
                ENV_SSH_AUTHORIZED_KEYS_B64,
                &BASE64_STANDARD.encode(self.ssh_authorized_keys_openssh.join("\n")),
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
        ]
        .join("")
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
        };

        let rendered = env.render();
        assert!(rendered.contains("INTAR_SSH_AUTHORIZED_KEYS_B64='"));
        assert!(rendered.contains("KINO_HOST_READY_PORT='18081'"));
        assert_eq!(RuntimeEnv::parse(&rendered), Ok(env));
    }
}
