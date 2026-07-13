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

/// A Unix socket endpoint whose socket inode stays pinned by file descriptor
/// on Linux.
///
/// Linux limits the pathname supplied to `connect(2)` to `sockaddr_un.sun_path`
/// even when the socket itself lives at a valid, longer host-visible path. We
/// open and validate the socket with `openat2(2)`, then connect through its
/// short, process-local `/proc/self/fd/<fd>` spelling. The original path
/// remains available for persistence and diagnostics, while the opened inode
/// prevents a later pathname replacement from redirecting API traffic.
#[derive(Clone, Debug)]
pub struct UnixSocketEndpoint {
    logical_path: PathBuf,
    connection_path: PathBuf,
    #[cfg(target_os = "linux")]
    _socket: Arc<std::os::fd::OwnedFd>,
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
            let parent_stat = rustix::fs::fstat(&parent).map_err(|source| Error::SocketPath {
                path: logical_path.clone(),
                source: io::Error::from(source),
            })?;
            if rustix::fs::FileType::from_raw_mode(parent_stat.st_mode)
                != rustix::fs::FileType::Directory
            {
                return Err(Error::SocketPath {
                    path: logical_path,
                    source: io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "socket parent is not a directory",
                    ),
                });
            }
            let socket = openat2(
                &parent,
                file_name,
                OFlags::PATH | OFlags::CLOEXEC | OFlags::NOFOLLOW,
                Mode::empty(),
                ResolveFlags::BENEATH
                    | ResolveFlags::NO_MAGICLINKS
                    | ResolveFlags::NO_SYMLINKS
                    | ResolveFlags::NO_XDEV,
            )
            .map_err(|source| Error::SocketPath {
                path: logical_path.clone(),
                source: io::Error::from(source),
            })?;
            let socket_stat = rustix::fs::fstat(&socket).map_err(|source| Error::SocketPath {
                path: logical_path.clone(),
                source: io::Error::from(source),
            })?;
            if rustix::fs::FileType::from_raw_mode(socket_stat.st_mode)
                != rustix::fs::FileType::Socket
            {
                return Err(Error::SocketPath {
                    path: logical_path,
                    source: io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "socket path is not a Unix socket",
                    ),
                });
            }
            if socket_stat.st_nlink != 1 {
                return Err(Error::SocketPath {
                    path: logical_path,
                    source: io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "socket inode must have exactly one link",
                    ),
                });
            }
            if socket_stat.st_uid != parent_stat.st_uid || socket_stat.st_gid != parent_stat.st_gid
            {
                return Err(Error::SocketPath {
                    path: logical_path,
                    source: io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "socket owner does not match its parent directory",
                    ),
                });
            }
            let connection_path = PathBuf::from(format!("/proc/self/fd/{}", socket.as_raw_fd()));
            Ok(Self {
                logical_path,
                connection_path,
                _socket: Arc::new(socket),
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

    /// PUT /api/v1/vm.add-disk
    pub async fn vm_add_disk(&self, cfg: &DiskConfig) -> Result<(), Error> {
        let url = Self::api_url("vm.add-disk");

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
    use std::os::unix::fs::MetadataExt as _;
    #[cfg(target_os = "linux")]
    use std::os::unix::net::UnixListener;
    #[cfg(target_os = "linux")]
    use std::thread;
    #[cfg(target_os = "linux")]
    use std::time::{Duration, Instant};

    #[cfg(target_os = "linux")]
    fn accept_for(listener: &UnixListener, timeout: Duration) -> Option<UnixStream> {
        listener
            .set_nonblocking(true)
            .expect("make test listener nonblocking");
        let deadline = Instant::now() + timeout;
        loop {
            match listener.accept() {
                Ok((stream, _)) => return Some(stream),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("accept test unix socket: {error}"),
            }
        }
    }

    #[cfg(target_os = "linux")]
    fn spawn_ping_server(
        listener: UnixListener,
        version: &'static str,
    ) -> thread::JoinHandle<bool> {
        thread::spawn(move || {
            let Some(mut stream) = accept_for(&listener, Duration::from_secs(2)) else {
                return false;
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set test HTTP read timeout");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1_024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let length = stream.read(&mut buffer).expect("read HTTP request");
                assert_ne!(length, 0, "HTTP client closed before sending headers");
                request.extend_from_slice(&buffer[..length]);
            }
            assert!(request.starts_with(b"GET /api/v1/vmm.ping HTTP/1.1\r\n"));
            let body = format!(r#"{{"version":"{version}"}}"#);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .expect("write HTTP response");
            true
        })
    }

    #[cfg(target_os = "linux")]
    fn spawn_add_disk_denial_server(
        listener: UnixListener,
        response_body: String,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            let mut stream = accept_for(&listener, Duration::from_secs(2))
                .expect("accept add-disk HTTP connection");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set add-disk HTTP read timeout");

            let mut request = Vec::new();
            let mut buffer = [0_u8; 1_024];
            let header_end = loop {
                if let Some(offset) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                    break offset + 4;
                }
                let length = stream.read(&mut buffer).expect("read add-disk headers");
                assert_ne!(length, 0, "HTTP client closed before sending headers");
                request.extend_from_slice(&buffer[..length]);
            };
            let headers = std::str::from_utf8(&request[..header_end])
                .expect("add-disk HTTP headers are UTF-8");
            assert!(headers.starts_with("PUT /api/v1/vm.add-disk HTTP/1.1\r\n"));
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().expect("valid Content-Length"))
                })
                .expect("add-disk request has Content-Length");
            while request.len() < header_end + content_length {
                let length = stream.read(&mut buffer).expect("read add-disk body");
                assert_ne!(length, 0, "HTTP client closed before sending body");
                request.extend_from_slice(&buffer[..length]);
            }
            let body: DiskConfig =
                serde_json::from_slice(&request[header_end..header_end + content_length])
                    .expect("deserialize add-disk request body");
            assert_eq!(body.path, "/run/landlock-api-canary");
            assert!(body.readonly);
            assert_eq!(body.id.as_deref(), Some("landlock-denied"));
            assert!(matches!(body.image_type, Some(DiskImageType::Raw)));

            // Cloud Hypervisor's micro-http drops pending responses on
            // EPOLLRDHUP. The typed client must keep its write side open until
            // it has received the complete response.
            stream
                .set_read_timeout(Some(Duration::from_millis(100)))
                .expect("shorten add-disk HTTP read timeout");
            let mut extra = [0_u8; 1];
            match stream.read(&mut extra) {
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Ok(0) => panic!("HTTP client half-closed before receiving the response"),
                Ok(_) => panic!("HTTP client sent bytes beyond its declared body"),
                Err(error) => panic!("unexpected add-disk connection state: {error}"),
            }

            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            )
            .expect("write add-disk denial response");
        })
    }

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
    fn typed_add_disk_preserves_v53_error_response_without_half_close() {
        let temp = tempfile::tempdir().expect("create add-disk test directory");
        let socket = temp.path().join("cloud-hypervisor.sock");
        let listener = UnixListener::bind(&socket).expect("bind add-disk Unix socket");
        let expected_chain = vec![
            "Error from API",
            "The disk could not be added to the VM",
            "Error from device manager",
            "Cannot open disk path",
            "I/O error (path=/run/landlock-api-canary op=open)",
            "Permission denied (os error 13)",
        ];
        let response_body = serde_json::to_string(&expected_chain).expect("serialize error chain");
        let server = spawn_add_disk_denial_server(listener, response_body.clone());
        let client = Client::new(socket.to_str().expect("socket path is UTF-8"))
            .expect("create add-disk client");
        let disk = DiskConfig {
            path: "/run/landlock-api-canary".to_owned(),
            readonly: true,
            id: Some("landlock-denied".to_owned()),
            image_type: Some(DiskImageType::Raw),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build add-disk test runtime");
        let error = runtime
            .block_on(client.vm_add_disk(&disk))
            .expect_err("Landlock-negative add-disk must fail");
        match error {
            Error::HttpStatus { status, body } => {
                assert_eq!(status, 500);
                assert_eq!(body, response_body);
            }
            error => panic!("unexpected add-disk error: {error}"),
        }
        server.join().expect("add-disk HTTP server");
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
        fs::remove_file(&short_socket).expect("remove short socket link");
        assert_eq!(
            fs::symlink_metadata(&long_socket)
                .expect("stat long socket")
                .nlink(),
            1
        );

        assert!(UnixStream::connect(&long_socket).is_err());
        let endpoint = UnixSocketEndpoint::new(&long_socket).expect("anchor long socket path");
        assert_eq!(endpoint.logical_path(), long_socket);
        let _client = endpoint
            .connect()
            .expect("connect through pinned parent fd");
        let _server =
            accept_for(&listener, Duration::from_secs(2)).expect("accept fd-relative connection");

        let server = spawn_ping_server(listener, "long-path");
        let logical_path = long_socket.to_str().expect("test path is UTF-8");
        let client = Client::new(logical_path).expect("create client for long socket path");
        assert_eq!(client.socket_path(), logical_path);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime");
        let ping = runtime.block_on(client.ping()).expect("ping long socket");
        assert_eq!(ping.version.as_deref(), Some("long-path"));
        assert!(server.join().expect("HTTP server thread"));
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

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_anchored_endpoint_rejects_final_symlink() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("create socket test directory");
        let target = temp.path().join("target.sock");
        let _listener = UnixListener::bind(&target).expect("bind target unix socket");
        let link = temp.path().join("link.sock");
        symlink(&target, &link).expect("create final socket symlink");

        let error =
            UnixSocketEndpoint::new(&link).expect_err("symlinked final socket must fail closed");
        assert!(matches!(error, Error::SocketPath { .. }));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_anchored_endpoint_rejects_non_socket_and_multi_link_socket() {
        let temp = tempfile::tempdir().expect("create socket test directory");
        let regular = temp.path().join("regular");
        fs::write(&regular, b"not a socket").expect("write regular file");
        assert!(UnixSocketEndpoint::new(&regular).is_err());

        let socket = temp.path().join("socket");
        let _listener = UnixListener::bind(&socket).expect("bind unix socket");
        let second_link = temp.path().join("socket-link");
        fs::hard_link(&socket, &second_link).expect("hard-link unix socket");
        assert_eq!(
            fs::symlink_metadata(&socket)
                .expect("stat multi-link socket")
                .nlink(),
            2
        );
        assert!(UnixSocketEndpoint::new(&socket).is_err());
        assert!(UnixSocketEndpoint::new(&second_link).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fd_anchored_clients_cannot_be_redirected_by_pathname_swap() {
        let temp = tempfile::tempdir().expect("create socket test directory");
        let logical_socket = temp.path().join("cloud-hypervisor.sock");
        let original_listener =
            UnixListener::bind(&logical_socket).expect("bind original unix socket");
        let endpoint =
            UnixSocketEndpoint::new(&logical_socket).expect("anchor original raw socket");
        let logical_path = logical_socket.to_str().expect("test path is UTF-8");
        let client = Client::new(logical_path).expect("anchor original reqwest socket");
        assert_eq!(endpoint.logical_path(), logical_socket);
        assert_eq!(client.socket_path(), logical_path);

        let retired_socket = temp.path().join("retired.sock");
        fs::rename(&logical_socket, &retired_socket).expect("rename original socket path");
        let replacement_listener =
            UnixListener::bind(&logical_socket).expect("bind replacement unix socket");

        let raw_client = endpoint
            .connect()
            .expect("connect raw client to pinned original inode");
        let raw_server = accept_for(&original_listener, Duration::from_secs(2))
            .expect("original listener must receive raw connection");
        assert!(
            accept_for(&replacement_listener, Duration::from_millis(50)).is_none(),
            "replacement listener received fd-anchored raw traffic"
        );
        drop(raw_client);
        drop(raw_server);

        let named_client =
            UnixStream::connect(&logical_socket).expect("connect to replacement by path");
        let named_server = accept_for(&replacement_listener, Duration::from_secs(2))
            .expect("replacement listener must remain reachable by name");
        drop(named_client);
        drop(named_server);

        let original_server = spawn_ping_server(original_listener, "original");
        let replacement_server = spawn_ping_server(replacement_listener, "replacement");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test runtime");
        let ping = runtime
            .block_on(async { tokio::time::timeout(Duration::from_secs(2), client.ping()).await })
            .expect("fd-anchored reqwest ping timed out")
            .expect("fd-anchored reqwest ping failed");
        assert_eq!(ping.version.as_deref(), Some("original"));
        assert!(original_server.join().expect("original HTTP server"));
        assert!(
            !replacement_server.join().expect("replacement HTTP server"),
            "replacement listener received fd-anchored reqwest traffic"
        );
    }
}
