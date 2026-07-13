#![forbid(unsafe_code)]

use std::fmt;

use serde::{Deserialize, Serialize};

/// Default Cloud Hypervisor API unix socket path.
pub const DEFAULT_SOCKET_PATH: &str = "/run/cloud-hypervisor/cloud-hypervisor.sock";

#[derive(Debug)]
pub enum Error {
    Http(reqwest::Error),
    /// Non-2xx status code with (optional) response body.
    HttpStatus {
        status: u16,
        body: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Http(e) => write!(f, "request error: {e}"),
            Error::HttpStatus { status, body } => {
                write!(f, "http status {status} from cloud-hypervisor: {body}")
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<reqwest::Error> for Error {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

/// Cloud Hypervisor VMM ping response.
///
/// Fields are optional for forward/backward compatibility.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VmmPingResponse {
    pub build_version: Option<String>,
    pub version: Option<String>,
    pub pid: Option<u32>,
    pub features: Option<Vec<String>>,
}

/// Cloud Hypervisor VM info response.
///
/// Fields are optional for forward/backward compatibility.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VmInfo {
    pub config: VmConfig,
    pub state: VmState,
    pub memory_actual_size: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum VmState {
    Created,
    Running,
    Shutdown,
    Paused,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct VmConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<CpusConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<MemoryConfig>,
    pub payload: PayloadConfig,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disks: Option<Vec<DiskConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub net: Option<Vec<NetConfig>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<SerialConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub console: Option<ConsoleConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vsock: Option<VsockConfig>,
    /// Install Cloud Hypervisor's VM-specific Landlock rules when the VM is
    /// created. The launcher separately enables Landlock for the VMM's
    /// infrastructure threads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landlock_enable: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct PayloadConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmdline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initramfs: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CpusConfig {
    pub boot_vcpus: u32,
    pub max_vcpus: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MemoryConfig {
    pub size: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiskConfig {
    pub path: String,
    #[serde(default)]
    pub readonly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_type: Option<DiskImageType>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub enum DiskImageType {
    FixedVhd,
    Qcow2,
    Raw,
    Vhdx,
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct NetConfig {
    pub tap: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
}

/// Cloud Hypervisor serial output config.
///
/// Many fields are optional for forward/backward compatibility.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SerialConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub iommu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

/// Cloud Hypervisor console output config.
///
/// Many fields are optional for forward/backward compatibility.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConsoleConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    pub mode: String,
    #[serde(default)]
    pub iommu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub socket: Option<String>,
}

/// Cloud Hypervisor virtio-vsock config.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VsockConfig {
    pub cid: u64,
    pub socket: String,
    #[serde(default)]
    pub iommu: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pci_segment: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Client {
    socket_path: String,
    http: reqwest::Client,
}

impl Client {
    pub fn new(socket_path: impl Into<String>) -> Result<Self, Error> {
        let socket_path = socket_path.into();
        let http = reqwest::Client::builder()
            .unix_socket(socket_path.clone())
            .build()?;
        Ok(Self { socket_path, http })
    }

    pub fn new_default() -> Result<Self, Error> {
        Self::new(DEFAULT_SOCKET_PATH)
    }

    pub fn socket_path(&self) -> &str {
        &self.socket_path
    }

    fn api_url(path: &str) -> String {
        format!("http://localhost/api/v1/{path}")
    }

    /// GET /api/v1/vmm.ping
    pub async fn ping(&self) -> Result<VmmPingResponse, Error> {
        let url = Self::api_url("vmm.ping");

        let resp = self.http.get(url).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(resp.json::<VmmPingResponse>().await?)
    }

    /// GET /api/v1/vm.info
    pub async fn vm_info(&self) -> Result<VmInfo, Error> {
        let url = Self::api_url("vm.info");

        let resp = self.http.get(url).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(resp.json::<VmInfo>().await?)
    }

    /// PUT /api/v1/vm.create
    pub async fn vm_create(&self, cfg: &VmConfig) -> Result<(), Error> {
        let url = Self::api_url("vm.create");

        let resp = self.http.put(url).json(cfg).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    /// PUT /api/v1/vm.boot
    pub async fn vm_boot(&self) -> Result<(), Error> {
        let url = Self::api_url("vm.boot");

        let resp = self.http.put(url).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    /// PUT /api/v1/vm.shutdown
    pub async fn vm_shutdown(&self) -> Result<(), Error> {
        let url = Self::api_url("vm.shutdown");

        let resp = self.http.put(url).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }

    /// PUT /api/v1/vm.delete
    pub async fn vm_delete(&self) -> Result<(), Error> {
        let url = Self::api_url("vm.delete");

        let resp = self.http.put(url).send().await?;
        let status = resp.status();

        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            let body = body.trim().to_string();
            return Err(Error::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_config_serializes_vsock() {
        let vm = VmConfig {
            payload: PayloadConfig::default(),
            vsock: Some(VsockConfig {
                cid: 10_001,
                socket: "/tmp/kino.vsock".to_string(),
                iommu: false,
                pci_segment: None,
                id: Some("kino-vsock".to_string()),
            }),
            ..VmConfig::default()
        };

        let value = serde_json::to_value(vm).expect("serialize vm config");
        let vsock = value
            .get("vsock")
            .and_then(|v| v.as_object())
            .expect("vsock object should exist");

        assert_eq!(vsock.get("cid").and_then(|v| v.as_u64()), Some(10_001));
        assert_eq!(
            vsock.get("socket").and_then(|v| v.as_str()),
            Some("/tmp/kino.vsock")
        );
        assert_eq!(vsock.get("id").and_then(|v| v.as_str()), Some("kino-vsock"));
    }

    #[test]
    fn vm_config_serializes_landlock_enable() {
        let vm = VmConfig {
            payload: PayloadConfig::default(),
            landlock_enable: Some(true),
            ..VmConfig::default()
        };

        let value = serde_json::to_value(vm).expect("serialize vm config");
        assert_eq!(
            value.get("landlock_enable").and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}
