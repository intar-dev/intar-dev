#![forbid(unsafe_code)]

use std::fmt;
use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::sync::Arc;

#[cfg(target_os = "linux")]
use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};

use serde::{Deserialize, Serialize};

/// Default Cloud Hypervisor API unix socket path.
pub const DEFAULT_SOCKET_PATH: &str = "/run/cloud-hypervisor/cloud-hypervisor.sock";

#[derive(Debug)]
pub enum Error {
    Http(reqwest::Error),
    SocketPath {
        path: PathBuf,
        source: io::Error,
    },
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
            Error::SocketPath { path, source } => {
                write!(f, "invalid unix socket path {}: {source}", path.display())
            }
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

/// A Unix socket endpoint whose parent directory stays pinned by file
/// descriptor on Linux.
///
/// Linux limits the pathname supplied to `connect(2)` to `sockaddr_un.sun_path`
/// even when the socket itself lives at a valid, longer host-visible path. We
/// open the parent with `openat2(2)` and connect through the short,
/// process-local `/proc/self/fd/<fd>/<name>` spelling instead. The original
/// path remains available for persistence and diagnostics, and no symlink is
/// followed while the parent directory is opened.
#[derive(Clone, Debug)]
pub struct UnixSocketEndpoint {
    logical_path: PathBuf,
    connection_path: PathBuf,
    #[cfg(target_os = "linux")]
    _parent: Arc<std::os::fd::OwnedFd>,
}

impl UnixSocketEndpoint {
    pub fn new(path: impl Into<PathBuf>) -> Result<Self, Error> {
        let logical_path = path.into();

        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd as _;

            let file_name = logical_path
                .file_name()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| Error::SocketPath {
                    path: logical_path.clone(),
                    source: io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "socket path must have a file name",
                    ),
                })?;
            let parent_path = logical_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let parent = openat2(
                rustix::fs::CWD,
                parent_path,
                OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
                ResolveFlags::NO_MAGICLINKS | ResolveFlags::NO_SYMLINKS,
            )
            .map_err(|source| Error::SocketPath {
                path: logical_path.clone(),
                source: io::Error::from(source),
            })?;
            let connection_path =
                PathBuf::from(format!("/proc/self/fd/{}", parent.as_raw_fd())).join(file_name);
            Ok(Self {
                logical_path,
                connection_path,
                _parent: Arc::new(parent),
            })
        }

        #[cfg(not(target_os = "linux"))]
        Ok(Self {
            connection_path: logical_path.clone(),
            logical_path,
        })
    }

    pub fn logical_path(&self) -> &Path {
        &self.logical_path
    }

    pub fn connect(&self) -> io::Result<UnixStream> {
        UnixStream::connect(&self.connection_path)
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
    _socket_endpoint: UnixSocketEndpoint,
    http: reqwest::Client,
}

impl Client {
    pub fn new(socket_path: impl Into<String>) -> Result<Self, Error> {
        let socket_path = socket_path.into();
        let socket_endpoint = UnixSocketEndpoint::new(PathBuf::from(&socket_path))?;
        let http = reqwest::Client::builder()
            .unix_socket(socket_endpoint.connection_path.clone())
            .build()?;
        Ok(Self {
            socket_path,
            _socket_endpoint: socket_endpoint,
            http,
        })
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

    #[cfg(target_os = "linux")]
    use std::fs;
    #[cfg(target_os = "linux")]
    use std::io::{Read as _, Write as _};
    #[cfg(target_os = "linux")]
    use std::os::unix::net::UnixListener;
    #[cfg(target_os = "linux")]
    use std::thread;

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

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_anchored_endpoint_connects_beyond_sun_path_limit() {
        let temp = tempfile::tempdir().expect("create socket test directory");
        let short_socket = temp.path().join("short.sock");
        let listener = UnixListener::bind(&short_socket).expect("bind short unix socket");

        let mut long_parent = temp.path().to_path_buf();
        while long_parent.join("cloud-hypervisor.sock").as_os_str().len() <= 140 {
            long_parent.push("long-configurable-jail-root-segment");
        }
        fs::create_dir_all(&long_parent).expect("create long socket parent");
        let long_socket = long_parent.join("cloud-hypervisor.sock");
        fs::hard_link(&short_socket, &long_socket).expect("hard-link unix socket");

        assert!(UnixStream::connect(&long_socket).is_err());
        let endpoint = UnixSocketEndpoint::new(&long_socket).expect("anchor long socket path");
        assert_eq!(endpoint.logical_path(), long_socket);
        let _client = endpoint
            .connect()
            .expect("connect through pinned parent fd");
        let _server = listener.accept().expect("accept fd-relative connection");

        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept HTTP connection");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1_024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let length = stream.read(&mut buffer).expect("read HTTP request");
                assert_ne!(length, 0, "HTTP client closed before sending headers");
                request.extend_from_slice(&buffer[..length]);
            }
            assert!(request.starts_with(b"GET /api/v1/vmm.ping HTTP/1.1\r\n"));
            stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .expect("write HTTP response");
        });
        let logical_path = long_socket.to_str().expect("test path is UTF-8");
        let client = Client::new(logical_path).expect("create client for long socket path");
        assert_eq!(client.socket_path(), logical_path);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime");
        runtime.block_on(client.ping()).expect("ping long socket");
        server.join().expect("HTTP server thread");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_anchored_endpoint_rejects_symlinked_parent() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("create socket test directory");
        let target = temp.path().join("target");
        fs::create_dir(&target).expect("create target directory");
        let link = temp.path().join("link");
        symlink(&target, &link).expect("create parent symlink");

        let error = UnixSocketEndpoint::new(link.join("cloud-hypervisor.sock"))
            .expect_err("symlinked socket parent must fail closed");
        assert!(matches!(error, Error::SocketPath { .. }));
    }
}
