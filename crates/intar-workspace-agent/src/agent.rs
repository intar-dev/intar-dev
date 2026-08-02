use crate::checkpoint::{
    BuiltinCheckpointApplier, CheckpointApplier, CheckpointError, CommandCheckpointApplier,
    download_and_stage, verify_tmpfs,
};
use crate::client::{ClientError, ControlPlane, HttpControlPlane};
use crate::config::{AgentConfig, REPORT_INTERVAL_SECONDS};
use crate::kino::{KinoClient, KinoSnapshot};
use crate::model::{AgentPhase, AgentReport, CONTRACT_VERSION, HealthStatus, ReportResponse};
use crate::recordings::{remove_uploaded_recording, stage_next_completed_recording};
use crate::secrets::SanitizedError;
use crate::state::{
    GenerationState, StateError, StateStore, read_bootstrap_capability, remove_bootstrap_capability,
};
use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

// A terminal workshop bundle reconstructs every module in order on one clean
// publication server. Keep the timeout below the provider report credential
// lifetime while allowing the full cumulative plan to finish.
const CHECKPOINT_APPLY_TIMEOUT_SECONDS: u64 = 3 * 60 * 60;

pub struct WorkspaceAgent {
    config: AgentConfig,
    control_plane: Arc<dyn ControlPlane>,
    download_client: reqwest::Client,
    kino: KinoClient,
    state_store: StateStore,
    checkpoint_applier: Arc<dyn CheckpointApplier>,
    boot_id: String,
}

impl WorkspaceAgent {
    pub fn from_config(config: AgentConfig) -> Result<Self, AgentError> {
        let boot_id = read_linux_boot_id()?;
        let control_plane = HttpControlPlane::new(&config).map_err(AgentError::Client)?;
        let download_client = control_plane.http_client();
        let kino = KinoClient::new(config.kino_url.clone())
            .map_err(|error| AgentError::Safe(SanitizedError::new(error.to_string(), &[])))?;
        let state_store = StateStore::new(config.state_path.clone(), config.identity.clone());
        let checkpoint_applier: Arc<dyn CheckpointApplier> =
            if let Some(program) = &config.checkpoint_apply_program {
                Arc::new(CommandCheckpointApplier::new(program.clone()))
            } else {
                Arc::new(BuiltinCheckpointApplier::new(
                    config.reconstruction_user.clone(),
                    config.reconstruction_home.clone(),
                ))
            };
        Ok(Self {
            config,
            control_plane: Arc::new(control_plane),
            download_client,
            kino,
            state_store,
            checkpoint_applier,
            boot_id,
        })
    }

    pub fn new_for_test(
        config: AgentConfig,
        control_plane: Arc<dyn ControlPlane>,
        download_client: reqwest::Client,
        kino: KinoClient,
        checkpoint_applier: Arc<dyn CheckpointApplier>,
    ) -> Self {
        let state_store = StateStore::new(config.state_path.clone(), config.identity.clone());
        Self {
            config,
            control_plane,
            download_client,
            kino,
            state_store,
            checkpoint_applier,
            boot_id: "00000000-0000-4000-8000-000000000001".to_owned(),
        }
    }

    pub async fn run(&self) -> Result<(), AgentError> {
        let mut state = self.bootstrap_or_load().await?;

        if !state.checkpoint_applied() {
            self.apply_checkpoint(&mut state).await?;
        }

        info!(
            execution_id = %self.config.identity.execution_id,
            generation = self.config.identity.generation,
            interval_seconds = REPORT_INTERVAL_SECONDS,
            "workspace agent reporting started"
        );
        let mut ticker = tokio::time::interval(Duration::from_secs(REPORT_INTERVAL_SECONDS));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(error) = self.report_current(&mut state).await {
                        let safe = self.sanitize_error(&state, &error.to_string());
                        warn!(error = %safe.as_str(), "workspace report failed; will retry");
                    }
                    if let Err(error) = self.upload_next_completed_recording(&state).await {
                        let safe = self.sanitize_error(&state, &error.to_string());
                        warn!(error = %safe.as_str(), "completed terminal recording upload failed; will retry");
                    }
                }
                _ = shutdown_signal() => {
                    info!("workspace agent shutdown requested");
                    return Ok(());
                }
            }
        }
    }

    pub async fn report_once(&self) -> Result<(), AgentError> {
        let mut state = self.bootstrap_or_load().await?;
        if !state.checkpoint_applied() {
            self.apply_checkpoint(&mut state).await?;
        }
        self.report_current(&mut state).await?;
        self.upload_next_completed_recording(&state).await
    }

    pub async fn upload_artifact(&self, kind: &str, path: &Path) -> Result<String, AgentError> {
        let state = self
            .state_store
            .load()
            .map_err(AgentError::State)?
            .ok_or_else(|| {
                AgentError::Safe(SanitizedError::new(
                    "agent has not completed bootstrap",
                    &[],
                ))
            })?;
        self.control_plane
            .upload_artifact(
                state.report_credential(),
                state.identity(),
                kind,
                path,
                self.config.max_artifact_bytes,
            )
            .await
            .map_err(|error| AgentError::Safe(self.sanitize_error(&state, &error.to_string())))
    }

    async fn upload_next_completed_recording(
        &self,
        state: &GenerationState,
    ) -> Result<(), AgentError> {
        let Some(path) = stage_next_completed_recording(
            &self.config.recording_dir,
            &self.config.recording_upload_staging_dir,
            self.config.max_artifact_bytes,
        )
        .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error.to_string())))?
        else {
            return Ok(());
        };
        self.control_plane
            .upload_artifact(
                state.report_credential(),
                state.identity(),
                "terminal_recording",
                &path,
                self.config.max_artifact_bytes,
            )
            .await
            .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error.to_string())))?;
        remove_uploaded_recording(&path)
            .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error.to_string())))
    }

    async fn bootstrap_or_load(&self) -> Result<GenerationState, AgentError> {
        if let Some(state) = self.state_store.load().map_err(AgentError::State)? {
            return Ok(state);
        }

        let capability = read_bootstrap_capability(&self.config.bootstrap_capability_path)
            .map_err(AgentError::State)?;
        let response = self
            .control_plane
            .bootstrap(&self.config.identity, &capability)
            .await
            .map_err(|error| {
                AgentError::Safe(SanitizedError::new(
                    error.to_string(),
                    &[capability.expose()],
                ))
            })?;
        response
            .validate_for(
                &self.config.identity,
                unix_time_ms(),
                self.config.max_checkpoint_bytes,
            )
            .map_err(|error| {
                AgentError::Safe(SanitizedError::new(error, &[capability.expose()]))
            })?;

        // Persist the generation credential before destroying the only bootstrap
        // capability. A subsequent process start can then never replay it.
        let state = self
            .state_store
            .install_bootstrap(response)
            .map_err(AgentError::State)?;
        remove_bootstrap_capability(&self.config.bootstrap_capability_path)
            .map_err(AgentError::State)?;
        info!("one-use bootstrap capability consumed and removed");
        Ok(state)
    }

    async fn apply_checkpoint(&self, state: &mut GenerationState) -> Result<(), AgentError> {
        fs_create_tmpfs_root(&self.config.checkpoint_tmpfs_dir)?;
        if self.config.require_checkpoint_tmpfs {
            verify_tmpfs(&self.config.checkpoint_tmpfs_dir).map_err(|error| {
                AgentError::Safe(self.sanitize_error(state, &error.to_string()))
            })?;
        }

        self.send_report(
            state,
            AgentPhase::ApplyingCheckpoint,
            HealthStatus::Unknown,
            false,
            Vec::new(),
            Vec::new(),
            None,
            false,
        )
        .await?;

        let checkpoint = state.checkpoint().clone();
        let checkpoint_work = async {
            let staged = download_and_stage(
                &self.download_client,
                &checkpoint,
                &self.config.checkpoint_tmpfs_dir,
                self.config.max_checkpoint_bytes,
                &self.config.checkpoint_signing_keys,
            )
            .await?;
            self.checkpoint_applier.apply(&staged).await
        };
        let apply_result = tokio::time::timeout(
            Duration::from_secs(CHECKPOINT_APPLY_TIMEOUT_SECONDS),
            async {
                let mut checkpoint_work = Box::pin(checkpoint_work);
                let mut heartbeat =
                    tokio::time::interval(Duration::from_secs(REPORT_INTERVAL_SECONDS));
                heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                // The applying report above is the initial heartbeat; make the
                // first interval tick wait instead of sending a duplicate.
                heartbeat.tick().await;
                loop {
                    tokio::select! {
                        result = &mut checkpoint_work => break result,
                        _ = heartbeat.tick() => {
                            if let Err(error) = self.send_report(
                                state,
                                AgentPhase::ApplyingCheckpoint,
                                HealthStatus::Unknown,
                                false,
                                Vec::new(),
                                Vec::new(),
                                None,
                                false,
                            ).await {
                                let safe = self.sanitize_error(state, &error.to_string());
                                warn!(
                                    error = %safe.as_str(),
                                    "checkpoint apply heartbeat failed; reconstruction continues"
                                );
                            }
                        }
                    }
                }
            },
        )
        .await
        .unwrap_or(Err(CheckpointError::ApplyTimedOut {
            seconds: CHECKPOINT_APPLY_TIMEOUT_SECONDS,
        }));
        let proof = match apply_result {
            Ok(proof) => proof,
            Err(error) => return Err(self.checkpoint_failed(state, error).await),
        };
        self.state_store
            .mark_checkpoint_applied(state, proof.completed_module_ids().to_vec())
            .map_err(AgentError::State)?;

        self.send_report(
            state,
            AgentPhase::StartingServices,
            HealthStatus::Unknown,
            false,
            Vec::new(),
            Vec::new(),
            None,
            false,
        )
        .await
        .map(|_| ())
    }

    async fn report_current(&self, state: &mut GenerationState) -> Result<(), AgentError> {
        match self
            .kino
            .poll(&[
                state.report_credential().expose(),
                state.checkpoint().signed_url.expose(),
            ])
            .await
        {
            Ok(KinoSnapshot {
                health,
                probes,
                ssh_host_keys_openssh,
            }) => {
                let terminal_ready = state.checkpoint_applied()
                    && !ssh_host_keys_openssh.is_empty()
                    && tcp_ready(
                        SocketAddr::from(([127, 0, 0, 1], 22)),
                        Duration::from_millis(500),
                    )
                    .await;
                let phase = match health {
                    HealthStatus::Healthy if terminal_ready => AgentPhase::Ready,
                    HealthStatus::Failed => AgentPhase::Failed,
                    _ => AgentPhase::Degraded,
                };
                let response = self
                    .send_report(
                        state,
                        phase,
                        health,
                        terminal_ready,
                        ssh_host_keys_openssh,
                        probes,
                        None,
                        false,
                    )
                    .await?;
                if response.drain_recordings {
                    self.complete_recording_drain(state).await?;
                }
                if !state.checkpoint_applied() {
                    self.apply_checkpoint(state).await?;
                }
                Ok(())
            }
            Err(error) => {
                let safe = self.sanitize_error(state, &error.to_string());
                let response = self
                    .send_report(
                        state,
                        AgentPhase::Degraded,
                        HealthStatus::Degraded,
                        false,
                        Vec::new(),
                        Vec::new(),
                        Some(safe),
                        false,
                    )
                    .await?;
                if response.drain_recordings {
                    self.complete_recording_drain(state).await?;
                }
                if !state.checkpoint_applied() {
                    self.apply_checkpoint(state).await?;
                }
                Ok(())
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_report(
        &self,
        state: &mut GenerationState,
        phase: AgentPhase,
        health: HealthStatus,
        terminal_ready: bool,
        ssh_host_keys_openssh: Vec<String>,
        probes: Vec<crate::model::ProbeObservation>,
        error: Option<SanitizedError>,
        recording_drain_completed: bool,
    ) -> Result<ReportResponse, AgentError> {
        let sequence = self
            .state_store
            .reserve_report_sequence(state)
            .map_err(AgentError::State)?;
        let report = AgentReport {
            contract_version: CONTRACT_VERSION,
            identity: self.config.identity.clone(),
            sequence,
            checkpoint_id: state.checkpoint().checkpoint_id.clone(),
            boot_id: self.boot_id.clone(),
            phase,
            health,
            terminal_ready,
            recording_drain_completed,
            completed_module_ids: state.completed_module_ids().to_vec(),
            ssh_host_keys_openssh,
            probes,
            error,
            reported_at_unix_ms: unix_time_ms(),
        };
        let response = self
            .control_plane
            .report(state.report_credential(), &report)
            .await
            .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error.to_string())))?;
        if response.accepted_sequence != sequence {
            return Err(AgentError::Safe(SanitizedError::new(
                format!(
                    "control plane accepted sequence {}, expected {sequence}",
                    response.accepted_sequence
                ),
                &[],
            )));
        }
        if let Some(next_checkpoint) = response.next_checkpoint.as_ref() {
            next_checkpoint
                .validate(unix_time_ms(), self.config.max_checkpoint_bytes)
                .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error)))?;
            self.state_store
                .install_next_checkpoint(state, next_checkpoint.clone())
                .map_err(AgentError::State)?;
        }
        Ok(response)
    }

    async fn complete_recording_drain(
        &self,
        state: &mut GenerationState,
    ) -> Result<(), AgentError> {
        let mut child = tokio::process::Command::new(&self.config.recording_drain_program);
        child
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(Duration::from_secs(40), child.status())
            .await
            .map_err(|_| {
                AgentError::Safe(SanitizedError::new(
                    "terminal recording drain program timed out",
                    &[],
                ))
            })?
            .map_err(|error| {
                AgentError::Safe(SanitizedError::new(
                    format!("failed to start terminal recording drain program: {error}"),
                    &[],
                ))
            })?;
        if !status.success() {
            return Err(AgentError::Safe(SanitizedError::new(
                format!("terminal recording drain program exited with {status}"),
                &[],
            )));
        }
        for _ in 0..1024 {
            let Some(path) = stage_next_completed_recording(
                &self.config.recording_dir,
                &self.config.recording_upload_staging_dir,
                self.config.max_artifact_bytes,
            )
            .map_err(|error| AgentError::Safe(self.sanitize_error(state, &error.to_string())))?
            else {
                self.send_report(
                    state,
                    AgentPhase::Degraded,
                    HealthStatus::Healthy,
                    false,
                    Vec::new(),
                    Vec::new(),
                    None,
                    true,
                )
                .await?;
                return Ok(());
            };
            self.control_plane
                .upload_artifact(
                    state.report_credential(),
                    state.identity(),
                    "terminal_recording",
                    &path,
                    self.config.max_artifact_bytes,
                )
                .await
                .map_err(|error| {
                    AgentError::Safe(self.sanitize_error(state, &error.to_string()))
                })?;
            remove_uploaded_recording(&path).map_err(|error| {
                AgentError::Safe(self.sanitize_error(state, &error.to_string()))
            })?;
        }
        Err(AgentError::Safe(SanitizedError::new(
            "terminal recording drain exceeded the file-count limit",
            &[],
        )))
    }

    async fn checkpoint_failed(
        &self,
        state: &mut GenerationState,
        error: CheckpointError,
    ) -> AgentError {
        let safe = self.sanitize_error(state, &error.to_string());
        let _ = self
            .send_report(
                state,
                AgentPhase::Failed,
                HealthStatus::Failed,
                false,
                Vec::new(),
                Vec::new(),
                Some(safe.clone()),
                false,
            )
            .await;
        AgentError::Safe(safe)
    }

    fn sanitize_error(&self, state: &GenerationState, error: &str) -> SanitizedError {
        SanitizedError::new(
            error,
            &[
                state.report_credential().expose(),
                state.checkpoint().signed_url.expose(),
            ],
        )
    }
}

fn read_linux_boot_id() -> Result<String, AgentError> {
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id").map_err(|error| {
        AgentError::Safe(SanitizedError::new(
            format!("failed to read Linux boot identity: {error}"),
            &[],
        ))
    })?;
    let boot_id = boot_id.trim();
    if !valid_linux_boot_id(boot_id) {
        return Err(AgentError::Safe(SanitizedError::new(
            "Linux boot identity is malformed",
            &[],
        )));
    }
    Ok(boot_id.to_owned())
}

fn valid_linux_boot_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte),
        })
}

fn fs_create_tmpfs_root(path: &Path) -> Result<(), AgentError> {
    std::fs::create_dir_all(path).map_err(|error| {
        AgentError::Safe(SanitizedError::new(
            format!("failed to create checkpoint staging directory: {error}"),
            &[],
        ))
    })
}

fn unix_time_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

async fn tcp_ready(address: SocketAddr, timeout: Duration) -> bool {
    tokio::time::timeout(timeout, tokio::net::TcpStream::connect(address))
        .await
        .is_ok_and(|result| result.is_ok())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                let _ = signal.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("{0}")]
    Safe(SanitizedError),
    #[error("agent state error: {0}")]
    State(StateError),
    #[error("control-plane client error: {0}")]
    Client(ClientError),
}

impl std::fmt::Display for SanitizedError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::{tcp_ready, valid_linux_boot_id};
    use std::time::Duration;

    #[tokio::test]
    async fn terminal_readiness_requires_a_listening_tcp_socket() {
        let unavailable = "127.0.0.1:0"
            .parse()
            .expect("parse unavailable readiness address");
        assert!(!tcp_ready(unavailable, Duration::from_millis(100)).await);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind readiness fixture");
        let address = listener.local_addr().expect("read readiness address");
        assert!(tcp_ready(address, Duration::from_secs(1)).await);
    }

    #[test]
    fn linux_boot_identity_is_canonical_lowercase_uuid() {
        assert!(valid_linux_boot_id("6c585ad0-cf7a-4c1e-a392-37b691c90c5d"));
        assert!(!valid_linux_boot_id("6C585AD0-CF7A-4C1E-A392-37B691C90C5D"));
        assert!(!valid_linux_boot_id("not-a-boot-id"));
    }
}
