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

/// Guest contract 3: the image's one unit runs [`GUEST_LOADER_PATH`], which
/// mounts the run disk at [`RUN_DISK_MOUNT`] and executes [`KINO_FILENAME`]
/// from it with `init`; [`BOOT_JSON_FILENAME`] on that disk is a
/// [`GuestBootV3`]; Kino reports on [`REPORT_PORT`] and the run CLI's broker
/// listens on [`RUN_CLI_PORT`], both on the host's vsock CID unless
/// `boot.json` names another [`GuestHostV3`].
pub const GUEST_CONTRACT: u32 = 3;
pub const REPORT_PORT: u32 = 18081;
pub const RUN_CLI_PORT: u32 = 18082;
pub const GUEST_LOADER_PATH: &str = "/usr/lib/intar/guest-loader";
pub const RUN_DISK_MOUNT: &str = "/run/intar/run";
pub const BOOT_JSON_FILENAME: &str = "boot.json";
pub const KINO_FILENAME: &str = "kino";

/// `boot.json`: everything one VM's Kino is told. The host writes it onto
/// the read-only run disk.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuestBootV3 {
    #[schemars(range(min = 3, max = 3))]
    pub contract: u32,
    pub hostname: String,
    pub network: GuestNetworkV3,
    /// Machine name to address, for `/etc/hosts`.
    pub peers: BTreeMap<String, String>,
    pub ssh: GuestSshV3,
    pub root_resize: bool,
    pub mode: crate::scenario::SpecMode,
    pub spec: crate::scenario::MachineSpecV1,
    /// Where Kino reaches the host for its reports and the run CLI's broker.
    /// Absent, it is the host's vsock CID, as on every agent host; a host
    /// that leaves it out writes the same bytes as before the field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<GuestHostV3>,
    /// Seconds the lab's ready scripts get in total, when the host knows the
    /// guest is slower than a learner's: an image build that boots what it
    /// built under emulation. Absent, Kino's own limit applies, as for every
    /// run of a lab; a host that leaves it out writes the same bytes as
    /// before the field existed. A Kino older than the field refuses a
    /// `boot.json` that has it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(range(min = 1, max = 3600))]
    pub ready_seconds: Option<u32>,
}

/// The most a host may give a lab's ready scripts ([`GuestBootV3::ready_seconds`]).
pub const MAX_READY_SECONDS: u32 = 3600;

/// The host's end of Kino's two connections.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(tag = "transport", rename_all = "snake_case", deny_unknown_fields)]
pub enum GuestHostV3 {
    /// AF_VSOCK to the host's CID, on [`REPORT_PORT`] and [`RUN_CLI_PORT`].
    Vsock,
    /// TCP to this IP address, for a host without vsock: a learner's own
    /// computer running macOS or Windows. The ports are the host's choice,
    /// since every guest there reaches it at the same address and only the
    /// port tells two machines apart.
    Tcp {
        address: String,
        #[schemars(range(min = 1))]
        report_port: u16,
        #[schemars(range(min = 1))]
        run_cli_port: u16,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuestNetworkV3 {
    pub ip_cidr: String,
    pub gateway: String,
    /// Empty unless the machine has egress; peers resolve from `/etc/hosts`.
    pub dns: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GuestSshV3 {
    pub enabled: bool,
    pub authorized_keys: Vec<String>,
}

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
    fn boot_json_of_the_design_parses_and_unknown_fields_are_refused()
    -> Result<(), serde_json::Error> {
        let json = serde_json::json!({
            "contract": 3,
            "hostname": "control-plane",
            "network": {"ip_cidr": "10.42.0.2/24", "gateway": "10.42.0.1", "dns": []},
            "peers": {"web": "10.42.0.3"},
            "ssh": {"enabled": true, "authorized_keys": ["ssh-ed25519 AAAA run-key"]},
            "root_resize": true,
            "mode": "learn",
            "spec": {
                "scenario_id": "intar/klustered-01-repair-cluster-plumbing",
                "machine": "control-plane",
                "env": {"KUBECONFIG": "/etc/rancher/k3s/k3s.yaml"},
                "defer": ["k3s.service"],
                "ready": [{"name": "node", "script": "true"}],
                "tasks": [
                    {"id": "database-scheduled", "check": "true", "needs": []},
                    {"id": "dns-and-v2", "check": "true", "needs": ["database-scheduled"], "solve": "fix"},
                ],
            },
        });
        let boot: GuestBootV3 = serde_json::from_value(json.clone())?;
        assert_eq!(boot.contract, GUEST_CONTRACT);
        assert_eq!(serde_json::to_value(&boot)?, json);
        for pointer in ["", "/network", "/ssh", "/spec", "/spec/tasks/0"] {
            let mut unknown = json.clone();
            if let Some(object) = unknown
                .pointer_mut(pointer)
                .and_then(|value| value.as_object_mut())
            {
                object.insert("later".to_owned(), true.into());
            }
            assert!(
                serde_json::from_value::<GuestBootV3>(unknown).is_err(),
                "{pointer}"
            );
        }
        Ok(())
    }

    #[test]
    fn the_host_is_vsock_unless_boot_json_names_another() -> Result<(), serde_json::Error> {
        let boot = |host: Option<serde_json::Value>| {
            let mut json = serde_json::json!({
                "contract": 3, "hostname": "web",
                "network": {"ip_cidr": "10.77.52.2/28", "gateway": "10.77.52.1", "dns": []},
                "peers": {}, "ssh": {"enabled": false, "authorized_keys": []},
                "root_resize": false, "mode": "learn",
                "spec": {"scenario_id": "", "machine": "web", "env": {}, "defer": [], "ready": [], "tasks": []},
            });
            if let (Some(host), Some(object)) = (host, json.as_object_mut()) {
                object.insert("host".to_owned(), host);
            }
            serde_json::from_value::<GuestBootV3>(json)
        };
        // An agent host writes no `host`, and its boot.json keeps its bytes.
        let absent = boot(None)?;
        assert_eq!(absent.host, None);
        // Nor does it write `ready_seconds`: only a host that boots a slower
        // guest than a learner's does, and it reads back as given.
        assert_eq!(absent.ready_seconds, None);
        assert!(!serde_json::to_string(&absent)?.contains("ready_seconds"));
        let mut slower = serde_json::to_value(&absent)?;
        if let Some(object) = slower.as_object_mut() {
            object.insert("ready_seconds".to_owned(), 1800.into());
        }
        assert_eq!(
            serde_json::from_value::<GuestBootV3>(slower)?.ready_seconds,
            Some(1800)
        );
        assert!(!serde_json::to_string(&absent)?.contains("host\""));

        let tcp = boot(Some(serde_json::json!({
            "transport": "tcp", "address": "10.77.52.1", "report_port": 41081, "run_cli_port": 41082,
        })))?;
        assert_eq!(
            tcp.host,
            Some(GuestHostV3::Tcp {
                address: "10.77.52.1".to_owned(),
                report_port: 41081,
                run_cli_port: 41082,
            })
        );
        assert_eq!(
            boot(Some(serde_json::json!({"transport": "vsock"})))?.host,
            Some(GuestHostV3::Vsock)
        );
        for refused in [
            serde_json::json!({"transport": "udp"}),
            serde_json::json!({"transport": "tcp", "address": "10.77.52.1"}),
            serde_json::json!({"transport": "tcp", "address": "10.77.52.1", "report_port": 1, "run_cli_port": 2, "more": 3}),
            serde_json::json!({"transport": "tcp", "address": "10.77.52.1", "report_port": 70000, "run_cli_port": 2}),
            serde_json::json!("10.77.52.1"),
        ] {
            assert!(boot(Some(refused.clone())).is_err(), "{refused}");
        }
        Ok(())
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
            kino_sha256: "b".repeat(64),
            guest_bootstrap_abi: 2,
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
