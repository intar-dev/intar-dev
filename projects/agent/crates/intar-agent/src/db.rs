#![forbid(unsafe_code)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use tokio::sync::{mpsc, oneshot};
use tracing::{error, info, warn};

pub const RPC_DIRECTION_SERVER_TO_HOST: &str = "server_to_host";
pub const RPC_DIRECTION_HOST_TO_SERVER: &str = "host_to_server";
pub const RPC_KIND_REQUEST: &str = "rpc.request";
pub const RPC_KIND_RESPONSE: &str = "rpc.response";

#[derive(Debug, Clone)]
pub struct VmRow {
    pub name: String,
    pub state: String,
    pub created_at_s: i64,
    pub updated_at_s: i64,
    pub running_at_s: Option<i64>,
    pub error: Option<String>,
    pub root_disk_path: Option<String>,
    pub seed_disk_path: Option<String>,
    pub mac: Option<String>,
    pub lease_duration_seconds: Option<i64>,
    pub guest_ip: Option<String>,
    pub ssh_public_port: Option<i64>,
    pub tap_name: Option<String>,
    pub ch_socket_path: Option<String>,
    pub ch_pid: Option<i64>,
    pub kino_vsock_cid: Option<i64>,
    pub kino_vsock_port: Option<i64>,
    pub kino_vsock_path: Option<String>,
    pub kino_host_socket_path: Option<String>,
    pub run_id: Option<String>,
    pub recording_disk_path: Option<String>,
    pub spool_dir: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VmProbeStateRow {
    pub vm_name: String,
    pub run_id: String,
    pub fingerprint: String,
    pub collection_state: String,
    pub collection_error: Option<String>,
    pub summary_json: String,
    pub snapshot_json: String,
    pub generated_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct RpcCallRow {
    pub call_id: String,
    pub direction: String,
    pub method: String,
    pub request_message_id: Option<String>,
    pub response_message_id: Option<String>,
    pub request_json: String,
    pub status: String,
    pub request_acked_at_ms: Option<i64>,
    pub response_acked_at_ms: Option<i64>,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub deadline_at_ms: Option<i64>,
    pub expires_at_ms: Option<i64>,
    pub response_json: Option<String>,
    pub error_json: Option<String>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct TransportStateRow {
    pub server_acked_seq: i64,
    pub host_acked_seq: i64,
    pub host_transport_id: Option<String>,
    pub server_transport_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TransportHelloSync {
    pub server_acked_seq: i64,
    pub host_acked_seq: i64,
    pub server_transport_id: Option<String>,
    pub host_transport_id: Option<String>,
    pub server_reset: bool,
    pub host_reset: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InventorySnapshotRow {
    pub generation: String,
    pub message_id: String,
    pub payload_json: String,
    pub occurred_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveJobRow {
    pub run_id: String,
    pub vm_name: String,
    pub vm_created_at_ms: i64,
    pub delete_requested_at_ms: i64,
    pub deleted_at_ms: i64,
    pub artifacts_dir: String,
    pub next_attempt_at_ms: i64,
    pub retry_count: i64,
    pub last_error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct RpcEnvelopeRow {
    pub direction: String,
    pub seq: i64,
    pub message_id: String,
    pub call_id: Option<String>,
    pub kind: String,
    pub method: String,
    pub payload_json: String,
    pub occurred_at_ms: i64,
    pub applied_at_ms: Option<i64>,
    pub acked_at_ms: Option<i64>,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct RpcEnvelopeInput {
    pub direction: String,
    pub message_id: String,
    pub call_id: Option<String>,
    pub kind: String,
    pub method: String,
    pub payload_json: String,
    pub occurred_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct Db {
    tx: mpsc::Sender<Op>,
}

enum Op {
    UpsertVm(Box<VmRow>),
    DeleteVm(String),
    LoadVmProbeState {
        vm_name: String,
        resp: oneshot::Sender<Result<Option<VmProbeStateRow>>>,
    },
    LoadAllVmProbeStates {
        resp: oneshot::Sender<Result<Vec<VmProbeStateRow>>>,
    },
    UpsertVmProbeState {
        row: Box<VmProbeStateRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    #[cfg(test)]
    LoadRpcCall {
        call_id: String,
        resp: oneshot::Sender<Result<Option<RpcCallRow>>>,
    },
    LoadRunnableInboundCalls {
        resp: oneshot::Sender<Result<Vec<RpcCallRow>>>,
    },
    UpsertRpcCall {
        row: Box<RpcCallRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    PersistRpcCallWithOutboundEnvelope {
        row: Box<RpcCallRow>,
        envelope: Option<Box<RpcEnvelopeInput>>,
        resp: oneshot::Sender<Result<()>>,
    },
    #[cfg(test)]
    LoadInboundEnvelopeByMessageId {
        message_id: String,
        resp: oneshot::Sender<Result<Option<RpcEnvelopeRow>>>,
    },
    ApplyInboundEnvelope {
        seq: i64,
        envelope: Box<RpcEnvelopeInput>,
        call: Option<Box<RpcCallRow>>,
        applied_at_ms: i64,
        resp: oneshot::Sender<Result<i64>>,
    },
    FailRunningInboundCalls {
        failed_at_ms: i64,
        updated_at_ms: i64,
        error_json: String,
        resp: oneshot::Sender<Result<Vec<RpcCallRow>>>,
    },
    PruneRpcState {
        before_updated_at_ms: i64,
        resp: oneshot::Sender<Result<usize>>,
    },
    LoadTransportState {
        resp: oneshot::Sender<Result<TransportStateRow>>,
    },
    EnsureHostTransportId {
        transport_id: String,
        resp: oneshot::Sender<Result<String>>,
    },
    SyncTransportAfterServerHello {
        server_transport_id: Option<String>,
        server_acked_seq: i64,
        host_transport_id: Option<String>,
        host_acked_seq: i64,
        acked_at_ms: i64,
        resp: oneshot::Sender<Result<TransportHelloSync>>,
    },
    LoadInventorySnapshot {
        resp: oneshot::Sender<Result<Option<InventorySnapshotRow>>>,
    },
    UpsertInventorySnapshot {
        row: Box<InventorySnapshotRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    UpsertArchiveJob {
        row: Box<ArchiveJobRow>,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadDueArchiveJobs {
        now_ms: i64,
        limit: usize,
        resp: oneshot::Sender<Result<Vec<ArchiveJobRow>>>,
    },
    DeleteArchiveJob {
        run_id: String,
        vm_name: String,
        resp: oneshot::Sender<Result<()>>,
    },
    UpdateArchiveJobRetry {
        run_id: String,
        vm_name: String,
        next_attempt_at_ms: i64,
        retry_count: i64,
        last_error: Option<String>,
        updated_at_ms: i64,
        resp: oneshot::Sender<Result<()>>,
    },
    LoadPendingOutboundEnvelopes {
        limit: usize,
        resp: oneshot::Sender<Result<Vec<RpcEnvelopeRow>>>,
    },
    MarkOutboundAcked {
        ack_upto: i64,
        acked_at_ms: i64,
        resp: oneshot::Sender<Result<i64>>,
    },
}

impl Db {
    pub async fn open() -> Result<(Self, Vec<VmRow>)> {
        let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
        if let Some(p) = dirs::state_dir() {
            candidates.push((p.join("intar-agent"), "state_dir"));
        }
        if let Some(p) = dirs::cache_dir() {
            let cache_path = p.join("intar-agent");
            if !candidates
                .iter()
                .any(|(existing, _)| *existing == cache_path)
            {
                candidates.push((cache_path, "cache_dir"));
            }
        }
        if candidates.is_empty() {
            anyhow::bail!("state/cache dir unavailable");
        }

        let mut db_dir = None;
        let mut root_kind = None;
        let mut failures = Vec::new();
        for (candidate, kind) in candidates {
            match tokio::fs::create_dir_all(&candidate).await {
                Ok(_) => {
                    db_dir = Some(candidate);
                    root_kind = Some(kind);
                    break;
                }
                Err(e) => {
                    warn!(
                        path = %candidate.display(),
                        root_kind = kind,
                        error = %e,
                        "failed to create db dir candidate"
                    );
                    failures.push(format!("{kind}: {} ({e})", candidate.display()));
                }
            }
        }

        let db_dir = db_dir.ok_or_else(|| {
            anyhow::anyhow!(
                "failed to create db dir from dirs::state_dir()/dirs::cache_dir: {}",
                failures.join("; ")
            )
        })?;
        let kind = root_kind.expect("root_kind must be set when db_dir is set");
        let db_path = db_dir.join("intar-agent.sqlite3");
        info!(path = %db_path.display(), root_kind = kind, "opening sqlite db");

        let (tx, rx) = mpsc::channel::<Op>(256);
        let (init_tx, init_rx) = oneshot::channel::<Result<Vec<VmRow>>>();

        std::thread::spawn(move || db_thread_main(db_path, rx, init_tx));

        let rows = init_rx
            .await
            .context("db thread dropped without sending init result")??;

        Ok((Self { tx }, rows))
    }

    #[cfg(test)]
    pub async fn open_for_test_at(db_path: PathBuf) -> Result<(Self, Vec<VmRow>)> {
        let (tx, rx) = mpsc::channel::<Op>(256);
        let (init_tx, init_rx) = oneshot::channel::<Result<Vec<VmRow>>>();

        std::thread::spawn(move || db_thread_main(db_path, rx, init_tx));

        let rows = init_rx
            .await
            .context("db thread dropped without sending init result")??;

        Ok((Self { tx }, rows))
    }

    pub async fn upsert_vm(&self, row: VmRow) -> Result<()> {
        self.tx
            .send(Op::UpsertVm(Box::new(row)))
            .await
            .context("db channel closed")?;
        Ok(())
    }

    pub async fn delete_vm(&self, name: String) -> Result<()> {
        self.tx
            .send(Op::DeleteVm(name))
            .await
            .context("db channel closed")?;
        Ok(())
    }

    pub async fn load_vm_probe_state(&self, vm_name: String) -> Result<Option<VmProbeStateRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<VmProbeStateRow>>>();
        self.tx
            .send(Op::LoadVmProbeState {
                vm_name,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped vm probe state response")?
    }

    pub async fn load_all_vm_probe_states(&self) -> Result<Vec<VmProbeStateRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<VmProbeStateRow>>>();
        self.tx
            .send(Op::LoadAllVmProbeStates { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped all vm probe states response")?
    }

    pub async fn upsert_vm_probe_state(&self, row: VmProbeStateRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertVmProbeState {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped vm probe state upsert response")?
    }

    #[cfg(test)]
    pub async fn load_rpc_call(&self, call_id: String) -> Result<Option<RpcCallRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<RpcCallRow>>>();
        self.tx
            .send(Op::LoadRpcCall {
                call_id,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped rpc call response")?
    }

    pub async fn load_runnable_inbound_calls(&self) -> Result<Vec<RpcCallRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<RpcCallRow>>>();
        self.tx
            .send(Op::LoadRunnableInboundCalls { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped runnable inbound calls response")?
    }

    pub async fn upsert_rpc_call(&self, row: RpcCallRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertRpcCall {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped upsert rpc call response")?
    }

    pub async fn persist_rpc_call_with_outbound_envelope(
        &self,
        row: RpcCallRow,
        envelope: Option<RpcEnvelopeInput>,
    ) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::PersistRpcCallWithOutboundEnvelope {
                row: Box::new(row),
                envelope: envelope.map(Box::new),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped rpc call/outbound envelope response")?
    }

    #[cfg(test)]
    pub async fn load_inbound_envelope_by_message_id(
        &self,
        message_id: String,
    ) -> Result<Option<RpcEnvelopeRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<RpcEnvelopeRow>>>();
        self.tx
            .send(Op::LoadInboundEnvelopeByMessageId {
                message_id,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped inbound envelope lookup response")?
    }

    pub async fn apply_inbound_envelope(
        &self,
        seq: i64,
        envelope: RpcEnvelopeInput,
        call: Option<RpcCallRow>,
        applied_at_ms: i64,
    ) -> Result<i64> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<i64>>();
        self.tx
            .send(Op::ApplyInboundEnvelope {
                seq,
                envelope: Box::new(envelope),
                call: call.map(Box::new),
                applied_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped apply inbound envelope response")?
    }

    pub async fn fail_running_inbound_calls(
        &self,
        failed_at_ms: i64,
        updated_at_ms: i64,
        error_json: String,
    ) -> Result<Vec<RpcCallRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<RpcCallRow>>>();
        self.tx
            .send(Op::FailRunningInboundCalls {
                failed_at_ms,
                updated_at_ms,
                error_json,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped fail running inbound calls response")?
    }

    pub async fn prune_rpc_state(&self, before_updated_at_ms: i64) -> Result<usize> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<usize>>();
        self.tx
            .send(Op::PruneRpcState {
                before_updated_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped prune rpc state response")?
    }

    pub async fn load_transport_state(&self) -> Result<TransportStateRow> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<TransportStateRow>>();
        self.tx
            .send(Op::LoadTransportState { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped transport state response")?
    }

    pub async fn ensure_host_transport_id(&self, transport_id: String) -> Result<String> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<String>>();
        self.tx
            .send(Op::EnsureHostTransportId {
                transport_id,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped host transport id response")?
    }

    pub async fn sync_transport_after_server_hello(
        &self,
        server_transport_id: Option<String>,
        server_acked_seq: i64,
        host_transport_id: Option<String>,
        host_acked_seq: i64,
        acked_at_ms: i64,
    ) -> Result<TransportHelloSync> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<TransportHelloSync>>();
        self.tx
            .send(Op::SyncTransportAfterServerHello {
                server_transport_id,
                server_acked_seq,
                host_transport_id,
                host_acked_seq,
                acked_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped server hello sync response")?
    }

    pub async fn load_inventory_snapshot(&self) -> Result<Option<InventorySnapshotRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Option<InventorySnapshotRow>>>();
        self.tx
            .send(Op::LoadInventorySnapshot { resp: resp_tx })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped inventory snapshot response")?
    }

    pub async fn upsert_inventory_snapshot(&self, row: InventorySnapshotRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertInventorySnapshot {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped inventory snapshot upsert response")?
    }

    pub async fn upsert_archive_job(&self, row: ArchiveJobRow) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpsertArchiveJob {
                row: Box::new(row),
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped archive job upsert response")?
    }

    pub async fn load_due_archive_jobs(
        &self,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<ArchiveJobRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<ArchiveJobRow>>>();
        self.tx
            .send(Op::LoadDueArchiveJobs {
                now_ms,
                limit,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped due archive jobs response")?
    }

    pub async fn delete_archive_job(&self, run_id: String, vm_name: String) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::DeleteArchiveJob {
                run_id,
                vm_name,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped delete archive job response")?
    }

    pub async fn update_archive_job_retry(
        &self,
        run_id: String,
        vm_name: String,
        next_attempt_at_ms: i64,
        retry_count: i64,
        last_error: Option<String>,
        updated_at_ms: i64,
    ) -> Result<()> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<()>>();
        self.tx
            .send(Op::UpdateArchiveJobRetry {
                run_id,
                vm_name,
                next_attempt_at_ms,
                retry_count,
                last_error,
                updated_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped update archive job retry response")?
    }

    pub async fn load_pending_outbound_envelopes(
        &self,
        limit: usize,
    ) -> Result<Vec<RpcEnvelopeRow>> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<Vec<RpcEnvelopeRow>>>();
        self.tx
            .send(Op::LoadPendingOutboundEnvelopes {
                limit,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped pending outbound envelopes response")?
    }

    pub async fn mark_outbound_acked(&self, ack_upto: i64, acked_at_ms: i64) -> Result<i64> {
        let (resp_tx, resp_rx) = oneshot::channel::<Result<i64>>();
        self.tx
            .send(Op::MarkOutboundAcked {
                ack_upto,
                acked_at_ms,
                resp: resp_tx,
            })
            .await
            .context("db channel closed")?;

        resp_rx
            .await
            .context("db thread dropped mark-outbound-acked response")?
    }
}

fn db_thread_main(
    db_path: PathBuf,
    mut rx: mpsc::Receiver<Op>,
    init_tx: oneshot::Sender<Result<Vec<VmRow>>>,
) {
    let mut conn = match open_or_reset_database(&db_path) {
        Ok(conn) => conn,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };

    let initial_rows = match load_all_vms(&conn) {
        Ok(rows) => rows,
        Err(error) => {
            let _ = init_tx.send(Err(error));
            return;
        }
    };
    let _ = init_tx.send(Ok(initial_rows));

    while let Some(op) = rx.blocking_recv() {
        match op {
            Op::UpsertVm(row) => {
                if let Err(error) = upsert_vm(&conn, &row) {
                    error!(error = %error, vm = row.name, "sqlite upsert vm failed");
                }
            }
            Op::DeleteVm(name) => {
                if let Err(error) = delete_vm(&conn, &name) {
                    error!(error = %error, vm = name, "sqlite delete vm failed");
                }
            }
            Op::LoadVmProbeState { vm_name, resp } => {
                let _ = resp.send(load_vm_probe_state(&conn, &vm_name));
            }
            Op::LoadAllVmProbeStates { resp } => {
                let _ = resp.send(load_all_vm_probe_states(&conn));
            }
            Op::UpsertVmProbeState { row, resp } => {
                let _ = resp.send(upsert_vm_probe_state(&conn, &row));
            }
            #[cfg(test)]
            Op::LoadRpcCall { call_id, resp } => {
                let _ = resp.send(load_rpc_call(&conn, &call_id));
            }
            Op::LoadRunnableInboundCalls { resp } => {
                let _ = resp.send(load_runnable_inbound_calls(&conn));
            }
            Op::UpsertRpcCall { row, resp } => {
                let _ = resp.send(upsert_rpc_call(&conn, &row));
            }
            Op::PersistRpcCallWithOutboundEnvelope {
                row,
                envelope,
                resp,
            } => {
                let _ = resp.send(persist_rpc_call_with_outbound_envelope(
                    &mut conn,
                    &row,
                    envelope.as_deref(),
                ));
            }
            #[cfg(test)]
            Op::LoadInboundEnvelopeByMessageId { message_id, resp } => {
                let _ = resp.send(load_inbound_envelope_by_message_id(&conn, &message_id));
            }
            Op::ApplyInboundEnvelope {
                seq,
                envelope,
                call,
                applied_at_ms,
                resp,
            } => {
                let _ = resp.send(apply_inbound_envelope(
                    &mut conn,
                    seq,
                    &envelope,
                    call.as_deref(),
                    applied_at_ms,
                ));
            }
            Op::FailRunningInboundCalls {
                failed_at_ms,
                updated_at_ms,
                error_json,
                resp,
            } => {
                let _ = resp.send(fail_running_inbound_calls(
                    &mut conn,
                    failed_at_ms,
                    updated_at_ms,
                    &error_json,
                ));
            }
            Op::PruneRpcState {
                before_updated_at_ms,
                resp,
            } => {
                let _ = resp.send(prune_rpc_state(&conn, before_updated_at_ms));
            }
            Op::LoadTransportState { resp } => {
                let _ = resp.send(load_transport_state(&conn));
            }
            Op::EnsureHostTransportId { transport_id, resp } => {
                let _ = resp.send(ensure_host_transport_id(&conn, &transport_id));
            }
            Op::SyncTransportAfterServerHello {
                server_transport_id,
                server_acked_seq,
                host_transport_id,
                host_acked_seq,
                acked_at_ms,
                resp,
            } => {
                let _ = resp.send(sync_transport_after_server_hello(
                    &mut conn,
                    server_transport_id.as_deref(),
                    server_acked_seq,
                    host_transport_id.as_deref(),
                    host_acked_seq,
                    acked_at_ms,
                ));
            }
            Op::LoadInventorySnapshot { resp } => {
                let _ = resp.send(load_inventory_snapshot(&conn));
            }
            Op::UpsertInventorySnapshot { row, resp } => {
                let _ = resp.send(upsert_inventory_snapshot(&conn, &row));
            }
            Op::UpsertArchiveJob { row, resp } => {
                let _ = resp.send(upsert_archive_job(&conn, &row));
            }
            Op::LoadDueArchiveJobs {
                now_ms,
                limit,
                resp,
            } => {
                let _ = resp.send(load_due_archive_jobs(&conn, now_ms, limit));
            }
            Op::DeleteArchiveJob {
                run_id,
                vm_name,
                resp,
            } => {
                let _ = resp.send(delete_archive_job(&conn, &run_id, &vm_name));
            }
            Op::UpdateArchiveJobRetry {
                run_id,
                vm_name,
                next_attempt_at_ms,
                retry_count,
                last_error,
                updated_at_ms,
                resp,
            } => {
                let _ = resp.send(update_archive_job_retry(
                    &conn,
                    &run_id,
                    &vm_name,
                    next_attempt_at_ms,
                    retry_count,
                    last_error.as_deref(),
                    updated_at_ms,
                ));
            }
            Op::LoadPendingOutboundEnvelopes { limit, resp } => {
                let _ = resp.send(load_pending_outbound_envelopes(&conn, limit));
            }
            Op::MarkOutboundAcked {
                ack_upto,
                acked_at_ms,
                resp,
            } => {
                let _ = resp.send(mark_outbound_acked(&mut conn, ack_upto, acked_at_ms));
            }
        }
    }
}

fn open_or_reset_database(db_path: &Path) -> Result<Connection> {
    open_prepared_connection(db_path).map_err(|error| {
        anyhow::anyhow!(
            "sqlite db at {} is incompatible with the baseline schema; purge the file and restart: {error}",
            db_path.display()
        )
    })
}

fn open_prepared_connection(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("failed to open sqlite db at {}", db_path.display()))?;
    prepare_connection(&conn)?;
    ensure_baseline_schema(&conn)?;
    Ok(conn)
}

fn prepare_connection(conn: &Connection) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))
        .context("failed to set busy_timeout")?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
        .context("failed to set sqlite pragmas")?;
    Ok(())
}

fn ensure_baseline_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(BASELINE_SCHEMA_SQL)
        .context("failed to apply baseline sqlite schema")?;

    apply_additive_migrations(conn)?;

    let has_any_tables: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%');",
            [],
            |row| row.get(0),
        )
        .context("failed to check existing sqlite tables")?;

    if has_any_tables && !schema_is_compatible(conn)? {
        anyhow::bail!("sqlite schema is incompatible with the baseline schema");
    }
    Ok(())
}

fn apply_additive_migrations(conn: &Connection) -> Result<()> {
    if !table_has_column(conn, "transport_state", "host_transport_id")? {
        conn.execute(
            "ALTER TABLE transport_state ADD COLUMN host_transport_id TEXT;",
            [],
        )
        .context("add transport_state.host_transport_id")?;
    }
    if !table_has_column(conn, "transport_state", "server_transport_id")? {
        conn.execute(
            "ALTER TABLE transport_state ADD COLUMN server_transport_id TEXT;",
            [],
        )
        .context("add transport_state.server_transport_id")?;
    }
    if !table_has_column(conn, "vms", "ssh_public_port")? {
        conn.execute("ALTER TABLE vms ADD COLUMN ssh_public_port INTEGER;", [])
            .context("add vms.ssh_public_port")?;
    }
    Ok(())
}

fn schema_is_compatible(conn: &Connection) -> Result<bool> {
    let requirements = [
        ("vms", "name"),
        ("vms", "spool_dir"),
        ("vms", "ssh_public_port"),
        ("vm_probe_state", "snapshot_json"),
        ("rpc_calls", "call_id"),
        ("rpc_calls", "request_message_id"),
        ("rpc_calls", "response_message_id"),
        ("rpc_calls", "request_acked_at_ms"),
        ("rpc_envelopes", "message_id"),
        ("rpc_envelopes", "applied_at_ms"),
        ("transport_state", "server_acked_seq"),
        ("transport_state", "host_next_seq"),
        ("transport_state", "host_acked_seq"),
        ("transport_state", "host_transport_id"),
        ("transport_state", "server_transport_id"),
        ("inventory_snapshot_state", "message_id"),
        ("archive_jobs", "run_id"),
    ];

    for (table, column) in requirements {
        if !table_has_column(conn, table, column)? {
            return Ok(false);
        }
    }

    Ok(true)
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let pragma = format!("PRAGMA table_info({table});");
    let mut stmt = conn
        .prepare(&pragma)
        .with_context(|| format!("prepare table_info for {table}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .with_context(|| format!("query table_info for {table}"))?;
    for value in rows {
        if value? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn load_all_vms(conn: &Connection) -> Result<Vec<VmRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  name,
  state,
  created_at_s,
  updated_at_s,
  running_at_s,
  error,
  root_disk_path,
  seed_disk_path,
  mac,
  lease_duration_seconds,
  guest_ip,
  ssh_public_port,
  tap_name,
  ch_socket_path,
  ch_pid,
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  kino_host_socket_path,
  run_id,
  recording_disk_path,
  spool_dir
FROM vms
ORDER BY created_at_s ASC;
"#,
        )
        .context("prepare load_all_vms query")?;

    let rows = stmt
        .query_map([], |row| {
            Ok(VmRow {
                name: row.get(0)?,
                state: row.get(1)?,
                created_at_s: row.get(2)?,
                updated_at_s: row.get(3)?,
                running_at_s: row.get(4)?,
                error: row.get(5)?,
                root_disk_path: row.get(6)?,
                seed_disk_path: row.get(7)?,
                mac: row.get(8)?,
                lease_duration_seconds: row.get(9)?,
                guest_ip: row.get(10)?,
                ssh_public_port: row.get(11)?,
                tap_name: row.get(12)?,
                ch_socket_path: row.get(13)?,
                ch_pid: row.get(14)?,
                kino_vsock_cid: row.get(15)?,
                kino_vsock_port: row.get(16)?,
                kino_vsock_path: row.get(17)?,
                kino_host_socket_path: row.get(18)?,
                run_id: row.get(19)?,
                recording_disk_path: row.get(20)?,
                spool_dir: row.get(21)?,
            })
        })
        .context("query load_all_vms")?;

    rows.collect::<rusqlite::Result<Vec<VmRow>>>()
        .context("collect load_all_vms rows")
}

fn upsert_vm(conn: &Connection, row: &VmRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vms (
  name,
  state,
  created_at_s,
  updated_at_s,
  running_at_s,
  error,
  root_disk_path,
  seed_disk_path,
  mac,
  lease_duration_seconds,
  guest_ip,
  ssh_public_port,
  tap_name,
  ch_socket_path,
  ch_pid,
  kino_vsock_cid,
  kino_vsock_port,
  kino_vsock_path,
  kino_host_socket_path,
  run_id,
  recording_disk_path,
  spool_dir
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22
)
ON CONFLICT(name) DO UPDATE SET
  state = excluded.state,
  created_at_s = excluded.created_at_s,
  updated_at_s = excluded.updated_at_s,
  running_at_s = excluded.running_at_s,
  error = excluded.error,
  root_disk_path = excluded.root_disk_path,
  seed_disk_path = excluded.seed_disk_path,
  mac = excluded.mac,
  lease_duration_seconds = excluded.lease_duration_seconds,
  guest_ip = excluded.guest_ip,
  ssh_public_port = excluded.ssh_public_port,
  tap_name = excluded.tap_name,
  ch_socket_path = excluded.ch_socket_path,
  ch_pid = excluded.ch_pid,
  kino_vsock_cid = excluded.kino_vsock_cid,
  kino_vsock_port = excluded.kino_vsock_port,
  kino_vsock_path = excluded.kino_vsock_path,
  kino_host_socket_path = excluded.kino_host_socket_path,
  run_id = excluded.run_id,
  recording_disk_path = excluded.recording_disk_path,
  spool_dir = excluded.spool_dir;
"#,
        params![
            row.name,
            row.state,
            row.created_at_s,
            row.updated_at_s,
            row.running_at_s,
            row.error,
            row.root_disk_path,
            row.seed_disk_path,
            row.mac,
            row.lease_duration_seconds,
            row.guest_ip,
            row.ssh_public_port,
            row.tap_name,
            row.ch_socket_path,
            row.ch_pid,
            row.kino_vsock_cid,
            row.kino_vsock_port,
            row.kino_vsock_path,
            row.kino_host_socket_path,
            row.run_id,
            row.recording_disk_path,
            row.spool_dir,
        ],
    )
    .context("upsert vms row")?;

    Ok(())
}

fn delete_vm(conn: &Connection, name: &str) -> Result<()> {
    conn.execute("DELETE FROM vms WHERE name = ?1;", params![name])
        .context("delete vms row")?;
    conn.execute(
        "DELETE FROM vm_probe_state WHERE vm_name = ?1;",
        params![name],
    )
    .context("delete vm_probe_state row")?;
    Ok(())
}

fn load_vm_probe_state(conn: &Connection, vm_name: &str) -> Result<Option<VmProbeStateRow>> {
    conn.query_row(
        r#"
SELECT
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
FROM vm_probe_state
WHERE vm_name = ?1
LIMIT 1;
"#,
        params![vm_name],
        |row| {
            Ok(VmProbeStateRow {
                vm_name: row.get(0)?,
                run_id: row.get(1)?,
                fingerprint: row.get(2)?,
                collection_state: row.get(3)?,
                collection_error: row.get(4)?,
                summary_json: row.get(5)?,
                snapshot_json: row.get(6)?,
                generated_at_ms: row.get(7)?,
                updated_at_ms: row.get(8)?,
            })
        },
    )
    .optional()
    .context("load vm_probe_state row")
}

fn load_all_vm_probe_states(conn: &Connection) -> Result<Vec<VmProbeStateRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
FROM vm_probe_state
ORDER BY updated_at_ms ASC, vm_name ASC;
"#,
        )
        .context("prepare load_all_vm_probe_states query")?;

    let rows = stmt
        .query_map([], |row| {
            Ok(VmProbeStateRow {
                vm_name: row.get(0)?,
                run_id: row.get(1)?,
                fingerprint: row.get(2)?,
                collection_state: row.get(3)?,
                collection_error: row.get(4)?,
                summary_json: row.get(5)?,
                snapshot_json: row.get(6)?,
                generated_at_ms: row.get(7)?,
                updated_at_ms: row.get(8)?,
            })
        })
        .context("query load_all_vm_probe_states")?;

    rows.collect::<rusqlite::Result<Vec<VmProbeStateRow>>>()
        .context("collect load_all_vm_probe_states rows")
}

fn upsert_vm_probe_state(conn: &Connection, row: &VmProbeStateRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO vm_probe_state (
  vm_name,
  run_id,
  fingerprint,
  collection_state,
  collection_error,
  summary_json,
  snapshot_json,
  generated_at_ms,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
ON CONFLICT(vm_name) DO UPDATE SET
  run_id = excluded.run_id,
  fingerprint = excluded.fingerprint,
  collection_state = excluded.collection_state,
  collection_error = excluded.collection_error,
  summary_json = excluded.summary_json,
  snapshot_json = excluded.snapshot_json,
  generated_at_ms = excluded.generated_at_ms,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.vm_name,
            row.run_id,
            row.fingerprint,
            row.collection_state,
            row.collection_error,
            row.summary_json,
            row.snapshot_json,
            row.generated_at_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert vm_probe_state row")?;

    Ok(())
}

#[cfg(test)]
fn load_rpc_call(conn: &Connection, call_id: &str) -> Result<Option<RpcCallRow>> {
    conn.query_row(
        r#"
SELECT
  call_id,
  direction,
  method,
  request_message_id,
  response_message_id,
  request_json,
  status,
  request_acked_at_ms,
  response_acked_at_ms,
  started_at_ms,
  finished_at_ms,
  deadline_at_ms,
  expires_at_ms,
  response_json,
  error_json,
  updated_at_ms
FROM rpc_calls
WHERE call_id = ?1
LIMIT 1;
"#,
        params![call_id],
        rpc_call_from_row,
    )
    .optional()
    .context("load rpc_calls row")
}

fn load_runnable_inbound_calls(conn: &Connection) -> Result<Vec<RpcCallRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  call_id,
  direction,
  method,
  request_message_id,
  response_message_id,
  request_json,
  status,
  request_acked_at_ms,
  response_acked_at_ms,
  started_at_ms,
  finished_at_ms,
  deadline_at_ms,
  expires_at_ms,
  response_json,
  error_json,
  updated_at_ms
FROM rpc_calls
WHERE direction = ?1
  AND status = 'request_acked'
ORDER BY request_acked_at_ms ASC, updated_at_ms ASC, call_id ASC;
"#,
        )
        .context("prepare runnable inbound rpc_calls query")?;

    let rows = stmt
        .query_map(params![RPC_DIRECTION_SERVER_TO_HOST], rpc_call_from_row)
        .context("query runnable inbound rpc_calls rows")?;

    rows.collect::<rusqlite::Result<Vec<RpcCallRow>>>()
        .context("collect runnable inbound rpc_calls rows")
}

fn rpc_call_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RpcCallRow> {
    Ok(RpcCallRow {
        call_id: row.get(0)?,
        direction: row.get(1)?,
        method: row.get(2)?,
        request_message_id: row.get(3)?,
        response_message_id: row.get(4)?,
        request_json: row.get(5)?,
        status: row.get(6)?,
        request_acked_at_ms: row.get(7)?,
        response_acked_at_ms: row.get(8)?,
        started_at_ms: row.get(9)?,
        finished_at_ms: row.get(10)?,
        deadline_at_ms: row.get(11)?,
        expires_at_ms: row.get(12)?,
        response_json: row.get(13)?,
        error_json: row.get(14)?,
        updated_at_ms: row.get(15)?,
    })
}

fn upsert_rpc_call(conn: &Connection, row: &RpcCallRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO rpc_calls (
  call_id,
  direction,
  method,
  request_message_id,
  response_message_id,
  request_json,
  status,
  request_acked_at_ms,
  response_acked_at_ms,
  started_at_ms,
  finished_at_ms,
  deadline_at_ms,
  expires_at_ms,
  response_json,
  error_json,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
ON CONFLICT(call_id) DO UPDATE SET
  direction = excluded.direction,
  method = excluded.method,
  request_message_id = excluded.request_message_id,
  response_message_id = excluded.response_message_id,
  request_json = excluded.request_json,
  status = excluded.status,
  request_acked_at_ms = excluded.request_acked_at_ms,
  response_acked_at_ms = excluded.response_acked_at_ms,
  started_at_ms = excluded.started_at_ms,
  finished_at_ms = excluded.finished_at_ms,
  deadline_at_ms = excluded.deadline_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  response_json = excluded.response_json,
  error_json = excluded.error_json,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.call_id,
            row.direction,
            row.method,
            row.request_message_id,
            row.response_message_id,
            row.request_json,
            row.status,
            row.request_acked_at_ms,
            row.response_acked_at_ms,
            row.started_at_ms,
            row.finished_at_ms,
            row.deadline_at_ms,
            row.expires_at_ms,
            row.response_json,
            row.error_json,
            row.updated_at_ms,
        ],
    )
    .context("upsert rpc_calls row")?;
    Ok(())
}

fn upsert_rpc_call_in_tx(tx: &Transaction<'_>, row: &RpcCallRow) -> Result<()> {
    tx.execute(
        r#"
INSERT INTO rpc_calls (
  call_id,
  direction,
  method,
  request_message_id,
  response_message_id,
  request_json,
  status,
  request_acked_at_ms,
  response_acked_at_ms,
  started_at_ms,
  finished_at_ms,
  deadline_at_ms,
  expires_at_ms,
  response_json,
  error_json,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
ON CONFLICT(call_id) DO UPDATE SET
  direction = excluded.direction,
  method = excluded.method,
  request_message_id = excluded.request_message_id,
  response_message_id = excluded.response_message_id,
  request_json = excluded.request_json,
  status = excluded.status,
  request_acked_at_ms = excluded.request_acked_at_ms,
  response_acked_at_ms = excluded.response_acked_at_ms,
  started_at_ms = excluded.started_at_ms,
  finished_at_ms = excluded.finished_at_ms,
  deadline_at_ms = excluded.deadline_at_ms,
  expires_at_ms = excluded.expires_at_ms,
  response_json = excluded.response_json,
  error_json = excluded.error_json,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.call_id,
            row.direction,
            row.method,
            row.request_message_id,
            row.response_message_id,
            row.request_json,
            row.status,
            row.request_acked_at_ms,
            row.response_acked_at_ms,
            row.started_at_ms,
            row.finished_at_ms,
            row.deadline_at_ms,
            row.expires_at_ms,
            row.response_json,
            row.error_json,
            row.updated_at_ms,
        ],
    )
    .context("upsert rpc_calls row in transaction")?;
    Ok(())
}

fn persist_rpc_call_with_outbound_envelope(
    conn: &mut Connection,
    row: &RpcCallRow,
    envelope: Option<&RpcEnvelopeInput>,
) -> Result<()> {
    let tx = conn
        .transaction()
        .context("begin rpc call/outbound envelope transaction")?;
    upsert_rpc_call_in_tx(&tx, row)?;
    if let Some(envelope) = envelope {
        let _ = queue_outbound_envelope_in_tx(&tx, envelope)?;
    }
    tx.commit()
        .context("commit rpc call/outbound envelope transaction")?;
    Ok(())
}

#[cfg(test)]
fn load_inbound_envelope_by_message_id(
    conn: &Connection,
    message_id: &str,
) -> Result<Option<RpcEnvelopeRow>> {
    conn.query_row(
        r#"
SELECT
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
FROM rpc_envelopes
WHERE direction = ?1
  AND message_id = ?2
LIMIT 1;
"#,
        params![RPC_DIRECTION_SERVER_TO_HOST, message_id],
        rpc_envelope_from_row,
    )
    .optional()
    .context("load inbound rpc_envelopes row by message_id")
}

fn rpc_envelope_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RpcEnvelopeRow> {
    Ok(RpcEnvelopeRow {
        direction: row.get(0)?,
        seq: row.get(1)?,
        message_id: row.get(2)?,
        call_id: row.get(3)?,
        kind: row.get(4)?,
        method: row.get(5)?,
        payload_json: row.get(6)?,
        occurred_at_ms: row.get(7)?,
        applied_at_ms: row.get(8)?,
        acked_at_ms: row.get(9)?,
        expires_at_ms: row.get(10)?,
    })
}

fn apply_inbound_envelope(
    conn: &mut Connection,
    seq: i64,
    envelope: &RpcEnvelopeInput,
    call: Option<&RpcCallRow>,
    applied_at_ms: i64,
) -> Result<i64> {
    let tx = conn
        .transaction()
        .context("begin apply_inbound_envelope transaction")?;

    upsert_inbound_envelope_in_tx(&tx, seq, envelope, applied_at_ms)?;
    if let Some(call) = call {
        upsert_rpc_call_in_tx(&tx, call)?;
    }

    let next_ack = advance_server_acked_seq_in_tx(&tx, seq)?;
    tx.commit()
        .context("commit apply_inbound_envelope transaction")?;
    Ok(next_ack)
}

fn upsert_inbound_envelope_in_tx(
    tx: &Transaction<'_>,
    seq: i64,
    envelope: &RpcEnvelopeInput,
    applied_at_ms: i64,
) -> Result<()> {
    if envelope.direction != RPC_DIRECTION_SERVER_TO_HOST {
        anyhow::bail!("apply_inbound_envelope requires server_to_host direction");
    }

    if let Some(existing) = tx
        .query_row(
            r#"
SELECT
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
FROM rpc_envelopes
WHERE direction = ?1
  AND message_id = ?2
LIMIT 1;
"#,
            params![RPC_DIRECTION_SERVER_TO_HOST, envelope.message_id],
            rpc_envelope_from_row,
        )
        .optional()
        .context("load existing inbound envelope in transaction")?
    {
        if existing.kind != envelope.kind
            || existing.method != envelope.method
            || existing.payload_json != envelope.payload_json
            || existing.call_id != envelope.call_id
        {
            anyhow::bail!(
                "inbound envelope payload mismatch for existing message_id {}",
                envelope.message_id
            );
        }

        tx.execute(
            r#"
UPDATE rpc_envelopes
SET seq = MAX(seq, ?1),
    applied_at_ms = COALESCE(applied_at_ms, ?2)
WHERE direction = ?3
  AND message_id = ?4;
"#,
            params![
                seq,
                applied_at_ms,
                RPC_DIRECTION_SERVER_TO_HOST,
                envelope.message_id
            ],
        )
        .context("update existing inbound envelope in transaction")?;
        return Ok(());
    }

    tx.execute(
        r#"
INSERT INTO rpc_envelopes (
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10);
"#,
        params![
            envelope.direction,
            seq,
            envelope.message_id,
            envelope.call_id,
            envelope.kind,
            envelope.method,
            envelope.payload_json,
            envelope.occurred_at_ms,
            applied_at_ms,
            envelope.expires_at_ms,
        ],
    )
    .context("insert inbound rpc_envelopes row in transaction")?;
    Ok(())
}

fn fail_running_inbound_calls(
    conn: &mut Connection,
    failed_at_ms: i64,
    updated_at_ms: i64,
    error_json: &str,
) -> Result<Vec<RpcCallRow>> {
    let tx = conn
        .transaction()
        .context("begin fail_running_inbound_calls transaction")?;

    let stale_rows = {
        let mut stmt = tx
            .prepare(
                r#"
SELECT
  call_id,
  direction,
  method,
  request_message_id,
  response_message_id,
  request_json,
  status,
  request_acked_at_ms,
  response_acked_at_ms,
  started_at_ms,
  finished_at_ms,
  deadline_at_ms,
  expires_at_ms,
  response_json,
  error_json,
  updated_at_ms
FROM rpc_calls
WHERE direction = ?1
  AND status = 'running'
ORDER BY request_acked_at_ms ASC, updated_at_ms ASC, call_id ASC;
"#,
            )
            .context("prepare stale inbound rpc_calls query")?;
        stmt.query_map(params![RPC_DIRECTION_SERVER_TO_HOST], rpc_call_from_row)
            .context("query stale inbound rpc_calls rows")?
            .collect::<rusqlite::Result<Vec<RpcCallRow>>>()
            .context("collect stale inbound rpc_calls rows")?
    };

    if stale_rows.is_empty() {
        tx.commit()
            .context("commit fail_running_inbound_calls transaction")?;
        return Ok(Vec::new());
    }

    for row in &stale_rows {
        let response_message_id = row
            .response_message_id
            .clone()
            .unwrap_or_else(|| format!("response:{}", row.call_id));
        let response_payload = format!(
            "{{\"status\":\"failed\",\"startedAt\":{},\"finishedAt\":{},\"error\":{}}}",
            opt_i64_to_json(row.started_at_ms),
            failed_at_ms,
            error_json
        );
        let next_row = RpcCallRow {
            call_id: row.call_id.clone(),
            direction: row.direction.clone(),
            method: row.method.clone(),
            request_message_id: row.request_message_id.clone(),
            response_message_id: Some(response_message_id.clone()),
            request_json: row.request_json.clone(),
            status: "failed".to_string(),
            request_acked_at_ms: row.request_acked_at_ms,
            response_acked_at_ms: row.response_acked_at_ms,
            started_at_ms: row.started_at_ms,
            finished_at_ms: Some(failed_at_ms),
            deadline_at_ms: row.deadline_at_ms,
            expires_at_ms: row.expires_at_ms,
            response_json: None,
            error_json: Some(error_json.to_string()),
            updated_at_ms,
        };
        upsert_rpc_call_in_tx(&tx, &next_row)?;
        let response_envelope = RpcEnvelopeInput {
            direction: RPC_DIRECTION_HOST_TO_SERVER.to_string(),
            message_id: response_message_id,
            call_id: Some(row.call_id.clone()),
            kind: RPC_KIND_RESPONSE.to_string(),
            method: row.method.clone(),
            payload_json: response_payload,
            occurred_at_ms: failed_at_ms,
            expires_at_ms: row.expires_at_ms,
        };
        let _ = queue_outbound_envelope_in_tx(&tx, &response_envelope)?;
    }

    tx.commit()
        .context("commit fail_running_inbound_calls transaction")?;

    Ok(stale_rows
        .into_iter()
        .map(|mut row| {
            row.status = "failed".to_string();
            row.response_message_id = row
                .response_message_id
                .or_else(|| Some(format!("response:{}", row.call_id)));
            row.finished_at_ms = Some(failed_at_ms);
            row.error_json = Some(error_json.to_string());
            row.updated_at_ms = updated_at_ms;
            row
        })
        .collect())
}

fn prune_rpc_state(conn: &Connection, before_updated_at_ms: i64) -> Result<usize> {
    let pruned_calls = conn
        .execute(
            r#"
DELETE FROM rpc_calls
WHERE expires_at_ms IS NOT NULL
  AND expires_at_ms < ?1;
"#,
            params![before_updated_at_ms],
        )
        .context("prune expired rpc_calls rows")?;
    conn.execute(
        r#"
DELETE FROM rpc_envelopes
WHERE expires_at_ms IS NOT NULL
  AND expires_at_ms < ?1;
"#,
        params![before_updated_at_ms],
    )
    .context("prune expired rpc_envelopes rows")?;
    conn.execute(
        r#"
DELETE FROM rpc_envelopes
WHERE direction = ?1
  AND acked_at_ms IS NOT NULL
  AND acked_at_ms < ?2;
"#,
        params![RPC_DIRECTION_HOST_TO_SERVER, before_updated_at_ms],
    )
    .context("prune old acked outbound rpc_envelopes rows")?;
    Ok(pruned_calls)
}

fn load_transport_state(conn: &Connection) -> Result<TransportStateRow> {
    conn.query_row(
        r#"
SELECT
  server_acked_seq,
  host_acked_seq,
  host_transport_id,
  server_transport_id
FROM transport_state
WHERE singleton = 1;
"#,
        [],
        |row| {
            Ok(TransportStateRow {
                server_acked_seq: row.get(0)?,
                host_acked_seq: row.get(1)?,
                host_transport_id: row.get(2)?,
                server_transport_id: row.get(3)?,
            })
        },
    )
    .context("load transport_state row")
}

fn ensure_host_transport_id(conn: &Connection, transport_id: &str) -> Result<String> {
    let current: Option<String> = conn
        .query_row(
            "SELECT host_transport_id FROM transport_state WHERE singleton = 1;",
            [],
            |row| row.get(0),
        )
        .context("load transport_state.host_transport_id")?;
    if let Some(existing) = current.filter(|value| !value.trim().is_empty()) {
        return Ok(existing);
    }

    conn.execute(
        "UPDATE transport_state SET host_transport_id = ?1 WHERE singleton = 1;",
        params![transport_id],
    )
    .context("update transport_state.host_transport_id")?;
    Ok(transport_id.to_string())
}

fn advance_server_acked_seq_in_tx(tx: &Transaction<'_>, ack_seq: i64) -> Result<i64> {
    let current: i64 = tx
        .query_row(
            "SELECT server_acked_seq FROM transport_state WHERE singleton = 1;",
            [],
            |row| row.get(0),
        )
        .context("load transport_state.server_acked_seq in transaction")?;
    let next = current.max(ack_seq);
    tx.execute(
        "UPDATE transport_state SET server_acked_seq = ?1 WHERE singleton = 1;",
        params![next],
    )
    .context("update transport_state.server_acked_seq in transaction")?;
    Ok(next)
}

fn advance_host_acked_seq_in_tx(
    tx: &Transaction<'_>,
    ack_upto: i64,
    acked_at_ms: i64,
) -> Result<i64> {
    let (current, host_next_seq): (i64, i64) = tx
        .query_row(
            "SELECT host_acked_seq, host_next_seq FROM transport_state WHERE singleton = 1;",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .context("load transport_state.host_acked_seq/host_next_seq")?;
    let max_sent_seq = host_next_seq.saturating_sub(1);
    let clamped_ack_upto = ack_upto.clamp(0, max_sent_seq);
    let next = current.max(clamped_ack_upto);

    tx.execute(
        "UPDATE transport_state SET host_acked_seq = ?1 WHERE singleton = 1;",
        params![next],
    )
    .context("update transport_state.host_acked_seq")?;
    tx.execute(
        r#"
UPDATE rpc_envelopes
SET acked_at_ms = ?1
WHERE direction = ?2
  AND seq <= ?3;
"#,
        params![acked_at_ms, RPC_DIRECTION_HOST_TO_SERVER, next],
    )
    .context("mark outbound rpc_envelopes as acked")?;
    tx.execute(
        r#"
UPDATE rpc_calls
SET response_acked_at_ms = COALESCE(response_acked_at_ms, ?1)
WHERE call_id IN (
  SELECT DISTINCT call_id
  FROM rpc_envelopes
  WHERE direction = ?2
    AND seq <= ?3
    AND kind = ?4
    AND call_id IS NOT NULL
);
"#,
        params![
            acked_at_ms,
            RPC_DIRECTION_HOST_TO_SERVER,
            next,
            RPC_KIND_RESPONSE
        ],
    )
    .context("mark rpc.response call rows as acked")?;
    tx.execute(
        r#"
UPDATE rpc_calls
SET request_acked_at_ms = COALESCE(request_acked_at_ms, ?1)
WHERE call_id IN (
  SELECT DISTINCT call_id
  FROM rpc_envelopes
  WHERE direction = ?2
    AND seq <= ?3
    AND kind = ?4
    AND call_id IS NOT NULL
);
"#,
        params![
            acked_at_ms,
            RPC_DIRECTION_HOST_TO_SERVER,
            next,
            RPC_KIND_REQUEST
        ],
    )
    .context("mark rpc.request call rows as acked")?;
    tx.execute(
        r#"
DELETE FROM rpc_envelopes
WHERE direction = ?1
  AND seq <= ?2
  AND kind = ?3
  AND call_id IS NOT NULL;
"#,
        params![RPC_DIRECTION_HOST_TO_SERVER, next, RPC_KIND_RESPONSE],
    )
    .context("prune acked outbound rpc.response rows")?;

    Ok(next)
}

fn sync_transport_after_server_hello(
    conn: &mut Connection,
    server_transport_id: Option<&str>,
    server_acked_seq: i64,
    host_transport_id: Option<&str>,
    host_acked_seq: i64,
    acked_at_ms: i64,
) -> Result<TransportHelloSync> {
    let tx = conn
        .transaction()
        .context("begin sync_transport_after_server_hello transaction")?;
    let current = load_transport_state_in_tx(&tx)?;
    let next_server_transport_id = server_transport_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let next_host_transport_id = host_transport_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let server_reset = current.server_transport_id != next_server_transport_id;
    let host_reset = current.host_transport_id != next_host_transport_id;

    if server_reset {
        tx.execute(
            "DELETE FROM rpc_envelopes WHERE direction = ?1;",
            params![RPC_DIRECTION_SERVER_TO_HOST],
        )
        .context("clear inbound rpc_envelopes after server transport reset")?;
        tx.execute(
            "DELETE FROM rpc_calls WHERE direction = ?1;",
            params![RPC_DIRECTION_SERVER_TO_HOST],
        )
        .context("clear inbound rpc_calls after server transport reset")?;
        tx.execute(
            r#"
UPDATE transport_state
SET server_transport_id = ?1,
    server_acked_seq = ?2
WHERE singleton = 1;
"#,
            params![next_server_transport_id, server_acked_seq.max(0)],
        )
        .context("reset transport_state after server transport reset")?;
    } else {
        let next_server_acked_seq = current.server_acked_seq.max(server_acked_seq.max(0));
        tx.execute(
            r#"
UPDATE transport_state
SET server_transport_id = COALESCE(?1, server_transport_id),
    server_acked_seq = ?2
WHERE singleton = 1;
"#,
            params![next_server_transport_id, next_server_acked_seq],
        )
        .context("update transport_state from server hello")?;
    }

    if host_reset {
        tx.execute(
            "DELETE FROM rpc_envelopes WHERE direction = ?1;",
            params![RPC_DIRECTION_HOST_TO_SERVER],
        )
        .context("clear outbound rpc_envelopes after host transport reset")?;
        tx.execute(
            r#"
UPDATE transport_state
SET host_transport_id = ?1,
    host_next_seq = 1,
    host_acked_seq = 0
WHERE singleton = 1;
"#,
            params![next_host_transport_id],
        )
        .context("reset transport_state after host transport reset")?;
    } else {
        tx.execute(
            r#"
UPDATE transport_state
SET host_transport_id = COALESCE(?1, host_transport_id)
WHERE singleton = 1;
"#,
            params![next_host_transport_id],
        )
        .context("update host transport id from server hello")?;
        if host_acked_seq > current.host_acked_seq {
            let _ = advance_host_acked_seq_in_tx(&tx, host_acked_seq, acked_at_ms)?;
        }
    }

    let next = load_transport_state_in_tx(&tx)?;
    tx.commit()
        .context("commit sync_transport_after_server_hello transaction")?;
    Ok(TransportHelloSync {
        server_acked_seq: next.server_acked_seq,
        host_acked_seq: next.host_acked_seq,
        server_transport_id: next.server_transport_id,
        host_transport_id: next.host_transport_id,
        server_reset,
        host_reset,
    })
}

fn load_transport_state_in_tx(tx: &Transaction<'_>) -> Result<TransportStateRow> {
    tx.query_row(
        r#"
SELECT
  server_acked_seq,
  host_acked_seq,
  host_transport_id,
  server_transport_id
FROM transport_state
WHERE singleton = 1;
"#,
        [],
        |row| {
            Ok(TransportStateRow {
                server_acked_seq: row.get(0)?,
                host_acked_seq: row.get(1)?,
                host_transport_id: row.get(2)?,
                server_transport_id: row.get(3)?,
            })
        },
    )
    .context("load transport_state row in transaction")
}

fn load_inventory_snapshot(conn: &Connection) -> Result<Option<InventorySnapshotRow>> {
    conn.query_row(
        r#"
SELECT generation, message_id, payload_json, occurred_at_ms
FROM inventory_snapshot_state
WHERE singleton = 1
LIMIT 1;
"#,
        [],
        |row| {
            Ok(InventorySnapshotRow {
                generation: row.get(0)?,
                message_id: row.get(1)?,
                payload_json: row.get(2)?,
                occurred_at_ms: row.get(3)?,
            })
        },
    )
    .optional()
    .context("load inventory snapshot state")
}

fn upsert_inventory_snapshot(conn: &Connection, row: &InventorySnapshotRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO inventory_snapshot_state (
  singleton,
  generation,
  message_id,
  payload_json,
  occurred_at_ms
) VALUES (1, ?1, ?2, ?3, ?4)
ON CONFLICT(singleton) DO UPDATE SET
  generation = excluded.generation,
  message_id = excluded.message_id,
  payload_json = excluded.payload_json,
  occurred_at_ms = excluded.occurred_at_ms;
"#,
        params![
            row.generation,
            row.message_id,
            row.payload_json,
            row.occurred_at_ms
        ],
    )
    .context("upsert inventory snapshot state")?;
    Ok(())
}

fn upsert_archive_job(conn: &Connection, row: &ArchiveJobRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO archive_jobs (
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(run_id, vm_name) DO UPDATE SET
  vm_created_at_ms = excluded.vm_created_at_ms,
  delete_requested_at_ms = excluded.delete_requested_at_ms,
  deleted_at_ms = excluded.deleted_at_ms,
  artifacts_dir = excluded.artifacts_dir,
  next_attempt_at_ms = excluded.next_attempt_at_ms,
  retry_count = excluded.retry_count,
  last_error = excluded.last_error,
  created_at_ms = excluded.created_at_ms,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.run_id,
            row.vm_name,
            row.vm_created_at_ms,
            row.delete_requested_at_ms,
            row.deleted_at_ms,
            row.artifacts_dir,
            row.next_attempt_at_ms,
            row.retry_count,
            row.last_error,
            row.created_at_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert archive job")?;
    Ok(())
}

fn load_due_archive_jobs(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<ArchiveJobRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
FROM archive_jobs
WHERE next_attempt_at_ms <= ?1
ORDER BY next_attempt_at_ms ASC, updated_at_ms ASC, vm_name ASC
LIMIT ?2;
"#,
        )
        .context("prepare load due archive jobs query")?;
    stmt.query_map(params![now_ms, limit as i64], |row| {
        Ok(ArchiveJobRow {
            run_id: row.get(0)?,
            vm_name: row.get(1)?,
            vm_created_at_ms: row.get(2)?,
            delete_requested_at_ms: row.get(3)?,
            deleted_at_ms: row.get(4)?,
            artifacts_dir: row.get(5)?,
            next_attempt_at_ms: row.get(6)?,
            retry_count: row.get(7)?,
            last_error: row.get(8)?,
            created_at_ms: row.get(9)?,
            updated_at_ms: row.get(10)?,
        })
    })
    .context("query due archive jobs")?
    .collect::<rusqlite::Result<Vec<ArchiveJobRow>>>()
    .context("collect due archive jobs rows")
}

fn delete_archive_job(conn: &Connection, run_id: &str, vm_name: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM archive_jobs WHERE run_id = ?1 AND vm_name = ?2;",
        params![run_id, vm_name],
    )
    .context("delete archive job")?;
    Ok(())
}

fn update_archive_job_retry(
    conn: &Connection,
    run_id: &str,
    vm_name: &str,
    next_attempt_at_ms: i64,
    retry_count: i64,
    last_error: Option<&str>,
    updated_at_ms: i64,
) -> Result<()> {
    conn.execute(
        r#"
UPDATE archive_jobs
SET next_attempt_at_ms = ?3,
    retry_count = ?4,
    last_error = ?5,
    updated_at_ms = ?6
WHERE run_id = ?1
  AND vm_name = ?2;
"#,
        params![
            run_id,
            vm_name,
            next_attempt_at_ms,
            retry_count,
            last_error,
            updated_at_ms,
        ],
    )
    .context("update archive job retry")?;
    Ok(())
}

fn queue_outbound_envelope_in_tx(
    tx: &Transaction<'_>,
    envelope: &RpcEnvelopeInput,
) -> Result<RpcEnvelopeRow> {
    if envelope.direction != RPC_DIRECTION_HOST_TO_SERVER {
        anyhow::bail!("queue_outbound_envelope requires host_to_server direction");
    }

    if let Some(existing) = tx
        .query_row(
            r#"
SELECT
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
FROM rpc_envelopes
WHERE direction = ?1
  AND message_id = ?2
LIMIT 1;
"#,
            params![RPC_DIRECTION_HOST_TO_SERVER, envelope.message_id],
            rpc_envelope_from_row,
        )
        .optional()
        .context("load existing outbound envelope by message_id")?
    {
        if existing.kind != envelope.kind
            || existing.method != envelope.method
            || existing.payload_json != envelope.payload_json
            || existing.call_id != envelope.call_id
        {
            anyhow::bail!(
                "outbound envelope payload mismatch for existing message_id {}",
                envelope.message_id
            );
        }
        return Ok(existing);
    }

    let next_seq: i64 = tx
        .query_row(
            "SELECT host_next_seq FROM transport_state WHERE singleton = 1;",
            [],
            |row| row.get(0),
        )
        .context("load transport_state.host_next_seq in transaction")?;

    tx.execute(
        r#"
INSERT INTO rpc_envelopes (
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9);
"#,
        params![
            envelope.direction,
            next_seq,
            envelope.message_id,
            envelope.call_id,
            envelope.kind,
            envelope.method,
            envelope.payload_json,
            envelope.occurred_at_ms,
            envelope.expires_at_ms,
        ],
    )
    .context("insert outbound rpc_envelopes row in transaction")?;

    tx.execute(
        "UPDATE transport_state SET host_next_seq = ?1 WHERE singleton = 1;",
        params![next_seq + 1],
    )
    .context("advance transport_state.host_next_seq in transaction")?;

    Ok(RpcEnvelopeRow {
        direction: envelope.direction.clone(),
        seq: next_seq,
        message_id: envelope.message_id.clone(),
        call_id: envelope.call_id.clone(),
        kind: envelope.kind.clone(),
        method: envelope.method.clone(),
        payload_json: envelope.payload_json.clone(),
        occurred_at_ms: envelope.occurred_at_ms,
        applied_at_ms: None,
        acked_at_ms: None,
        expires_at_ms: envelope.expires_at_ms,
    })
}

fn load_pending_outbound_envelopes(conn: &Connection, limit: usize) -> Result<Vec<RpcEnvelopeRow>> {
    let ack_upto = load_transport_state(conn)?.host_acked_seq;
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  direction,
  seq,
  message_id,
  call_id,
  kind,
  method,
  payload_json,
  occurred_at_ms,
  applied_at_ms,
  acked_at_ms,
  expires_at_ms
FROM rpc_envelopes
WHERE direction = ?1
  AND seq > ?2
  AND acked_at_ms IS NULL
ORDER BY seq ASC
LIMIT ?3;
"#,
        )
        .context("prepare load_pending_outbound_envelopes query")?;

    let rows = stmt
        .query_map(
            params![
                RPC_DIRECTION_HOST_TO_SERVER,
                ack_upto,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            rpc_envelope_from_row,
        )
        .context("query load_pending_outbound_envelopes")?;

    rows.collect::<rusqlite::Result<Vec<RpcEnvelopeRow>>>()
        .context("collect load_pending_outbound_envelopes rows")
}

fn mark_outbound_acked(conn: &mut Connection, ack_upto: i64, acked_at_ms: i64) -> Result<i64> {
    let tx = conn
        .transaction()
        .context("begin mark_outbound_acked transaction")?;
    let next = advance_host_acked_seq_in_tx(&tx, ack_upto, acked_at_ms)?;
    tx.commit()
        .context("commit mark_outbound_acked transaction")?;

    Ok(next)
}

fn opt_i64_to_json(value: Option<i64>) -> String {
    value
        .map(|value| value.to_string())
        .unwrap_or_else(|| "null".to_string())
}

const BASELINE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS vms (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  created_at_s INTEGER NOT NULL,
  updated_at_s INTEGER NOT NULL,
  running_at_s INTEGER,
  error TEXT,
  root_disk_path TEXT,
  seed_disk_path TEXT,
  mac TEXT,
  lease_duration_seconds INTEGER,
  guest_ip TEXT,
  ssh_public_port INTEGER,
  tap_name TEXT,
  ch_socket_path TEXT,
  ch_pid INTEGER,
  kino_vsock_cid INTEGER,
  kino_vsock_port INTEGER,
  kino_vsock_path TEXT,
  kino_host_socket_path TEXT,
  run_id TEXT,
  recording_disk_path TEXT,
  spool_dir TEXT
);

CREATE INDEX IF NOT EXISTS idx_vms_lease
  ON vms(lease_duration_seconds, running_at_s, state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vms_guest_ip ON vms(guest_ip);

CREATE TABLE IF NOT EXISTS vm_probe_state (
  vm_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_state TEXT NOT NULL,
  collection_error TEXT,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vm_probe_state_run_id
  ON vm_probe_state(run_id, updated_at_ms);

CREATE TABLE IF NOT EXISTS rpc_calls (
  call_id TEXT PRIMARY KEY,
  direction TEXT NOT NULL,
  method TEXT NOT NULL,
  request_message_id TEXT,
  response_message_id TEXT,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL,
  request_acked_at_ms INTEGER,
  response_acked_at_ms INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  deadline_at_ms INTEGER,
  expires_at_ms INTEGER,
  response_json TEXT,
  error_json TEXT,
  updated_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_calls_request_message
  ON rpc_calls(request_message_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_calls_response_message
  ON rpc_calls(response_message_id);

CREATE INDEX IF NOT EXISTS idx_rpc_calls_direction_status
  ON rpc_calls(direction, status, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_rpc_calls_expires
  ON rpc_calls(expires_at_ms, updated_at_ms);

CREATE TABLE IF NOT EXISTS transport_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  server_acked_seq INTEGER NOT NULL,
  host_next_seq INTEGER NOT NULL,
  host_acked_seq INTEGER NOT NULL,
  host_transport_id TEXT,
  server_transport_id TEXT
);

INSERT OR IGNORE INTO transport_state (
  singleton,
  server_acked_seq,
  host_next_seq,
  host_acked_seq
) VALUES (1, 0, 1, 0);

CREATE TABLE IF NOT EXISTS inventory_snapshot_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_jobs (
  run_id TEXT NOT NULL,
  vm_name TEXT NOT NULL,
  vm_created_at_ms INTEGER NOT NULL,
  delete_requested_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  artifacts_dir TEXT NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, vm_name)
);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_due
  ON archive_jobs(next_attempt_at_ms, updated_at_ms);

CREATE TABLE IF NOT EXISTS rpc_envelopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  call_id TEXT,
  kind TEXT NOT NULL,
  method TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL,
  applied_at_ms INTEGER,
  acked_at_ms INTEGER,
  expires_at_ms INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_envelopes_direction_seq
  ON rpc_envelopes(direction, seq);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rpc_envelopes_direction_message
  ON rpc_envelopes(direction, message_id);

CREATE INDEX IF NOT EXISTS idx_rpc_envelopes_direction_pending
  ON rpc_envelopes(direction, acked_at_ms, seq);

CREATE INDEX IF NOT EXISTS idx_rpc_envelopes_call
  ON rpc_envelopes(call_id, direction, seq);
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn test_db_path() -> PathBuf {
        let temp = tempdir().expect("temp dir");
        let path = temp.path().join("intar-agent-test.sqlite3");
        std::mem::forget(temp);
        path
    }

    fn test_rpc_call(call_id: &str, direction: &str, status: &str) -> RpcCallRow {
        RpcCallRow {
            call_id: call_id.to_string(),
            direction: direction.to_string(),
            method: "host.ping".to_string(),
            request_message_id: Some(format!("request:{call_id}")),
            response_message_id: None,
            request_json: "{}".to_string(),
            status: status.to_string(),
            request_acked_at_ms: Some(100),
            response_acked_at_ms: None,
            started_at_ms: None,
            finished_at_ms: None,
            deadline_at_ms: Some(1_000),
            expires_at_ms: Some(2_000),
            response_json: None,
            error_json: None,
            updated_at_ms: 100,
        }
    }

    fn test_envelope(
        direction: &str,
        message_id: &str,
        call_id: Option<&str>,
        kind: &str,
    ) -> RpcEnvelopeInput {
        RpcEnvelopeInput {
            direction: direction.to_string(),
            message_id: message_id.to_string(),
            call_id: call_id.map(str::to_string),
            kind: kind.to_string(),
            method: "host.ping".to_string(),
            payload_json: "{}".to_string(),
            occurred_at_ms: 100,
            expires_at_ms: Some(2_000),
        }
    }

    #[tokio::test]
    async fn apply_inbound_envelope_records_message_and_advances_server_cursor() {
        let (db, initial_vms) = Db::open_for_test_at(test_db_path()).await.expect("open db");
        assert!(initial_vms.is_empty());

        let ack = db
            .apply_inbound_envelope(
                4,
                test_envelope(
                    RPC_DIRECTION_SERVER_TO_HOST,
                    "request:call-1",
                    Some("call-1"),
                    RPC_KIND_REQUEST,
                ),
                Some(test_rpc_call(
                    "call-1",
                    RPC_DIRECTION_SERVER_TO_HOST,
                    "request_acked",
                )),
                100,
            )
            .await
            .expect("apply inbound envelope");

        assert_eq!(ack, 4);
        assert_eq!(
            db.load_transport_state()
                .await
                .expect("state")
                .server_acked_seq,
            4
        );
        let inbound = db
            .load_inbound_envelope_by_message_id("request:call-1".to_string())
            .await
            .expect("load inbound envelope")
            .expect("inbound envelope row");
        assert_eq!(inbound.seq, 4);
        assert_eq!(inbound.kind, RPC_KIND_REQUEST);
        assert_eq!(
            db.load_rpc_call("call-1".to_string())
                .await
                .expect("load call")
                .expect("rpc call row")
                .status,
            "request_acked"
        );
    }

    #[tokio::test]
    async fn mark_outbound_acked_updates_response_ack_on_call() {
        let (db, _) = Db::open_for_test_at(test_db_path()).await.expect("open db");
        let mut row = test_rpc_call("call-1", RPC_DIRECTION_SERVER_TO_HOST, "succeeded");
        row.response_message_id = Some("response:call-1".to_string());
        row.finished_at_ms = Some(120);
        row.response_json = Some(r#"{"ok":true}"#.to_string());
        row.updated_at_ms = 120;

        db.persist_rpc_call_with_outbound_envelope(
            row,
            Some(test_envelope(
                RPC_DIRECTION_HOST_TO_SERVER,
                "response:call-1",
                Some("call-1"),
                RPC_KIND_RESPONSE,
            )),
        )
        .await
        .expect("persist call with response envelope");

        let acked = db.mark_outbound_acked(99, 200).await.expect("mark acked");
        assert_eq!(acked, 1);
        assert_eq!(
            db.load_transport_state()
                .await
                .expect("state")
                .host_acked_seq,
            1
        );
        let call = db
            .load_rpc_call("call-1".to_string())
            .await
            .expect("load call")
            .expect("rpc call row");
        assert_eq!(call.response_acked_at_ms, Some(200));
        assert!(
            db.load_pending_outbound_envelopes(8)
                .await
                .expect("pending")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn sync_transport_after_server_hello_adopts_server_cursor_on_first_contact() {
        let (db, _) = Db::open_for_test_at(test_db_path()).await.expect("open db");

        let sync = db
            .sync_transport_after_server_hello(
                Some("server-a".to_string()),
                7,
                Some("host-a".to_string()),
                0,
                100,
            )
            .await
            .expect("sync transport");

        assert_eq!(sync.server_acked_seq, 7);
        assert_eq!(sync.server_transport_id.as_deref(), Some("server-a"));
        assert_eq!(sync.host_transport_id.as_deref(), Some("host-a"));
        assert!(sync.server_reset);
        assert!(sync.host_reset);

        let state = db.load_transport_state().await.expect("state");
        assert_eq!(state.server_acked_seq, 7);
        assert_eq!(state.server_transport_id.as_deref(), Some("server-a"));
        assert_eq!(state.host_transport_id.as_deref(), Some("host-a"));
    }

    #[tokio::test]
    async fn sync_transport_after_server_hello_clears_inbound_state_when_server_changes() {
        let (db, _) = Db::open_for_test_at(test_db_path()).await.expect("open db");

        db.sync_transport_after_server_hello(
            Some("server-a".to_string()),
            4,
            Some("host-a".to_string()),
            0,
            100,
        )
        .await
        .expect("initial sync");
        db.apply_inbound_envelope(
            4,
            test_envelope(
                RPC_DIRECTION_SERVER_TO_HOST,
                "request:call-1",
                Some("call-1"),
                RPC_KIND_REQUEST,
            ),
            Some(test_rpc_call(
                "call-1",
                RPC_DIRECTION_SERVER_TO_HOST,
                "request_acked",
            )),
            100,
        )
        .await
        .expect("apply inbound");

        let sync = db
            .sync_transport_after_server_hello(
                Some("server-b".to_string()),
                0,
                Some("host-a".to_string()),
                0,
                200,
            )
            .await
            .expect("reset sync");

        assert_eq!(sync.server_acked_seq, 0);
        assert_eq!(sync.server_transport_id.as_deref(), Some("server-b"));
        assert!(sync.server_reset);
        assert!(!sync.host_reset);
        assert!(
            db.load_inbound_envelope_by_message_id("request:call-1".to_string())
                .await
                .expect("load envelope")
                .is_none()
        );
        assert!(
            db.load_rpc_call("call-1".to_string())
                .await
                .expect("load call")
                .is_none()
        );
    }

    #[test]
    fn upsert_vm_persists_row_with_ssh_public_port() {
        let path = test_db_path();
        let conn = open_prepared_connection(&path).expect("open db");
        let row = VmRow {
            name: "vm-1".to_string(),
            state: "running".to_string(),
            created_at_s: 100,
            updated_at_s: 200,
            running_at_s: Some(150),
            error: None,
            root_disk_path: Some("/tmp/root.qcow2".to_string()),
            seed_disk_path: Some("/tmp/seed.img".to_string()),
            mac: Some("02:00:00:00:00:01".to_string()),
            lease_duration_seconds: Some(3600),
            guest_ip: Some("10.200.0.2".to_string()),
            ssh_public_port: Some(22001),
            tap_name: Some("tap0".to_string()),
            ch_socket_path: Some("/tmp/ch.sock".to_string()),
            ch_pid: Some(1234),
            kino_vsock_cid: Some(42),
            kino_vsock_port: Some(12345),
            kino_vsock_path: Some("/tmp/kino.vsock".to_string()),
            kino_host_socket_path: Some("/tmp/kino.sock".to_string()),
            run_id: Some("run-1".to_string()),
            recording_disk_path: Some("/tmp/recording.qcow2".to_string()),
            spool_dir: Some("/tmp/spool".to_string()),
        };

        upsert_vm(&conn, &row).expect("upsert vm");

        let rows = load_all_vms(&conn).expect("load vms");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "vm-1");
        assert_eq!(rows[0].ssh_public_port, Some(22001));
        assert_eq!(rows[0].spool_dir.as_deref(), Some("/tmp/spool"));
    }
}
