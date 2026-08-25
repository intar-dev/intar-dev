use super::*;
#[cfg(target_os = "linux")]
use crate::kino_probe::{ProbeSummary, ProbeView};
use cloud_hypervisor_client::Error as ChError;
use intar_jailer_protocol::{CpuQuota, CpuQuotaAttestation};
use russh::client::Handler as _;
use serde_json::json;
use tempfile::tempdir;

fn ch_is_not_created_error(err: &ChError) -> bool {
    matches!(err, ChError::HttpStatus { status: 404, .. })
}

fn launch_operation_fixture() -> (VmLaunchRequest, PreparedImageV2Result) {
    let image_sha256 = Sha256Digest::parse("e".repeat(64)).expect("image digest");
    let artifact_sha256 = Sha256Digest::parse("f".repeat(64)).expect("artifact digest");
    let prepared_source = |name: &str, access| ArtifactSource {
        source_root: PREPARED_IMAGE_SOURCE_ROOT,
        relative_path: PathBuf::from(image_sha256.as_str()).join(name),
        sha256: Some(artifact_sha256.clone()),
        access,
    };
    let agent_source = |name: &str, access| ArtifactSource {
        source_root: 0,
        relative_path: PathBuf::from(name),
        sha256: None,
        access,
    };
    let prepared = PreparedImageV2Result {
        image_sha256: image_sha256.clone(),
        virtual_size_bytes: 4 * 1024 * 1024 * 1024,
        root_disk: prepared_source("root.raw", ArtifactAccess::ReadWrite),
        kernel: prepared_source("kernel", ArtifactAccess::ReadOnly),
        initrd: Some(prepared_source("initrd", ArtifactAccess::ReadOnly)),
        fast_template_store: true,
    };
    let request = VmLaunchRequest {
        run_id: ValidatedId::parse("run-1").expect("run ID"),
        vm_id: ValidatedId::parse("vm-1").expect("VM ID"),
        cpu_millis: 1_000,
        vcpu_count: 1,
        memory_mib: 512,
        root_disk_size_bytes: 4 * 1024 * 1024 * 1024,
        tap_name: "tap-test".to_string(),
        mac_address: "02:00:00:00:00:01".to_string(),
        guest_ip_cidr: "10.77.0.2/28".to_string(),
        ssh_public_port: Some(22_000),
        vsock_cid: 3,
        artifacts: SourceArtifacts {
            root_disk: prepared.root_disk.clone(),
            kernel: prepared.kernel.clone(),
            initrd: prepared.initrd.clone(),
            runtime_disk: agent_source("runtime.raw", ArtifactAccess::ReadOnly),
            recording_disk: agent_source("recordings.vfat", ArtifactAccess::ReadWrite),
        },
    };
    (request, prepared)
}

mod launch;
fn ch_is_not_started_error(err: &ChError) -> bool {
    matches!(err, ChError::HttpStatus { status: 405, .. })
}

fn ch_vm_info_is_absent_status(status: u16) -> bool {
    status == 404
}

fn ch_vm_info_is_ambiguous_status(status: u16) -> bool {
    !ch_vm_info_is_absent_status(status) && status >= 500
}

fn ch_delete_confirms_absence_status(status: u16) -> bool {
    status == 204 || status == 404
}

fn test_vm_status(name: &str, run_id: Option<&str>) -> VmStatusResponse {
    VmStatusResponse {
        name: name.to_string(),
        state: VmLifecycleState::Queued,
        created_at: "1970-01-01T00:00:00Z".to_string(),
        updated_at: "1970-01-01T00:00:00Z".to_string(),
        details: Some(VmDetails {
            image_key: None,
            image_sha256: None,
            run_id: run_id.map(str::to_string),
            root_disk_path: format!("/tmp/{name}/root.raw"),
            seed_disk_path: format!("/tmp/{name}/runtime.img"),
            recording_disk_path: None,
            spool_dir: None,
            mac: "02:00:00:00:00:01".to_string(),
            cpu_millis: Some(125),
            vcpu_count: Some(1),
            guest_ip: None,
            guest_ip_cidr: None,
            gateway: None,
            bridge_name: None,
            ssh_public_port: None,
            tap_name: None,
            ch_socket_path: None,
            ch_pid: None,
            ch_start_time_ticks: None,
            host_boot_id: None,
            ch_executable_sha256: None,
            jail_generation: None,
            jail_unit_name: None,
            jail_cgroup_path: None,
            jail_root_path: None,
            jail_root_inode: None,
            jail_uid: None,
            jail_gid: None,
            jail_netns_name: None,
            kino_vsock_cid: None,
            kino_vsock_port: None,
            kino_vsock_path: None,
            ssh_host_keys_openssh: Vec::new(),
            cpu_runtime: None,
        }),
        error: None,
        lease_duration_seconds: None,
        lease_expires_at: None,
        created_at_s: 0,
        updated_at_s: 0,
        running_at_s: None,
    }
}

mod archive;
mod artifacts;
fn test_ssh_access_config() -> SshAccessConfig {
    SshAccessConfig {
        enabled: true,
        public_port_start: 2200,
        public_port_end: 2299,
        advertised_host: Some("bridge.example.test".to_string()),
    }
}

mod api;
mod lifecycle;
mod network;
mod readiness;
