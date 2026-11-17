use super::*;
use cloud_hypervisor_client::Error as ChError;
use intar_jailer_protocol::{CpuQuota, CpuQuotaAttestation};
use russh::client::Handler as _;
use serde_json::json;
use tempfile::tempdir;

fn ch_is_not_created_error(err: &ChError) -> bool {
    matches!(err, ChError::HttpStatus { status: 404, .. })
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
    VmStatusResponse::test_status(name, run_id)
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
mod reports;
