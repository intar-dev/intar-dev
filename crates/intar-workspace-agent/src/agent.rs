use crate::checkpoint::{
    BuiltinCheckpointApplier, CheckpointApplier, CheckpointError, CommandCheckpointApplier,
    download_and_stage, verify_tmpfs,
};
use crate::client::{ClientError, ControlPlane, HttpControlPlane};
use crate::config::{AgentConfig, REPORT_INTERVAL_SECONDS};
use crate::kino::{KinoClient, KinoSnapshot};
use crate::model::{AgentPhase, AgentReport, CONTRACT_VERSION, HealthStatus, ReportResponse};
use crate::recordings::{remove_uploaded_recording, stage_next_completed_recording};
use crate::run_cli::{
    CompletionCache, RunCliBroker, RunCliCommand, RunCliCommandGate, local_error,
};
use crate::secrets::SanitizedError;
use crate::state::{
    GenerationState, StateError, StateStore, read_bootstrap_capability, remove_bootstrap_capability,
};
use intar_contracts::run_cli::{
    RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1, RunCliRequestV1, RunCliResponseV1,
    RunCliResultV1,
};
use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

// A terminal workshop bundle reconstructs every module in order on one clean
// publication server. Keep the timeout below the provider report credential
// lifetime while allowing the full cumulative plan to finish.
const CHECKPOINT_APPLY_TIMEOUT_SECONDS: u64 = 3 * 60 * 60;
// Dynamic shell completion must never advertise stale aliases. The broker
// serves this cache without a network round trip, so keep its lease bounded
// even if the next regular report is delayed.
const COMPLETION_CACHE_TTL: Duration = Duration::from_secs(15);
const COMPLETION_REFRESH_TIMEOUT: Duration = Duration::from_millis(900);
static NEXT_COMPLETION_REFRESH_REQUEST: AtomicU64 = AtomicU64::new(1);

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
        let completion_cache = self
            .config
            .run_cli_enabled
            .then(|| CompletionCache::new(COMPLETION_CACHE_TTL));
        let command_gate = completion_cache
            .as_ref()
            .map(|_| RunCliCommandGate::closed());

        // Bind the private learner socket before bootstrap, reporting, or a
        // potentially long checkpoint reconstruction. Completion can safely
        // return the empty cache throughout startup; the closed gate prevents
        // normal commands from queuing work that could execute after boot.
        let (_run_cli_broker, mut run_cli_commands) =
            if let (Some(cache), Some(gate)) = (completion_cache.as_ref(), command_gate.as_ref()) {
                let (broker, commands) = RunCliBroker::start(
                    &self.config.reconstruction_user,
                    cache.clone(),
                    gate.clone(),
                )
                .await
                .map_err(|error| {
                    AgentError::Safe(SanitizedError::new(
                        format!("failed to start run CLI broker: {error}"),
                        &[],
                    ))
                })?;
                (Some(broker), commands)
            } else {
                // A closed receiver keeps the select branch inert without opening
                // the root-owned Unix socket.
                let (sender, commands) = tokio::sync::mpsc::channel(1);
                drop(sender);
                (None, commands)
            };

        let mut state = self.bootstrap_or_load().await?;

        if !state.checkpoint_applied() {
            self.apply_checkpoint(&mut state).await?;
        }

        if let Some(cache) = completion_cache.as_ref() {
            // Prewarm only after the guest has published a current Kino
            // snapshot. The bound listener still returns an empty result on a
            // control-plane failure.
            cache.invalidate();
            match self.report_current(&mut state).await {
                Ok(()) if self.refresh_completion_cache(&state, cache).await => {}
                Ok(()) => warn!("run CLI completion cache prewarm failed"),
                Err(error) => {
                    let safe = self.sanitize_error(&state, &error.to_string());
                    warn!(error = %safe.as_str(), "workspace report failed during run CLI completion prewarm");
                }
            }
        }
        if let Some(gate) = command_gate.as_ref() {
            gate.open();
        }

        info!(
            execution_id = %self.config.identity.execution_id,
            generation = self.config.identity.generation,
            interval_seconds = REPORT_INTERVAL_SECONDS,
            "workspace agent reporting started"
        );
        let mut report_ticker = tokio::time::interval(Duration::from_secs(REPORT_INTERVAL_SECONDS));
        report_ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        if completion_cache.is_some() {
            // The prewarm above already performed the interval's first report.
            // Consume Tokio's immediate tick so it cannot race a just-published
            // cache with a duplicate report.
            report_ticker.tick().await;
        }
        loop {
            tokio::select! {
                _ = report_ticker.tick() => {
                    if let Some(cache) = completion_cache.as_ref() {
                        // Do not expose an alias while a new authoritative
                        // report or its cache refresh is in flight.
                        cache.invalidate();
                    }
                    match self.report_current(&mut state).await {
                        Ok(()) => {
                            if let Some(cache) = completion_cache.as_ref()
                                && !self.refresh_completion_cache(&state, cache).await
                            {
                                warn!("run CLI completion cache refresh failed");
                            }
                        }
                        Err(error) => {
                            let safe = self.sanitize_error(&state, &error.to_string());
                            warn!(error = %safe.as_str(), "workspace report failed; will retry");
                        }
                    }
                    if let Err(error) = self.upload_next_completed_recording(&state).await {
                        let safe = self.sanitize_error(&state, &error.to_string());
                        warn!(error = %safe.as_str(), "completed terminal recording upload failed; will retry");
                    }
                }
                Some(command) = run_cli_commands.recv() => {
                    if let Some(cache) = completion_cache.as_ref() {
                        self.handle_run_cli_command(&mut state, cache, command).await;
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

    async fn handle_run_cli_command(
        &self,
        state: &mut GenerationState,
        completion_cache: &CompletionCache,
        command: RunCliCommand,
    ) {
        let request = command.request;
        let response = self
            .run_cli_request(state, completion_cache, &request)
            .await;
        // The caller may have disconnected. The state-owning operation has
        // already completed, so dropping the one-shot response is safe.
        let _ = command.response.send(response);
    }

    async fn run_cli_request(
        &self,
        state: &mut GenerationState,
        completion_cache: &CompletionCache,
        request: &RunCliRequestV1,
    ) -> RunCliResponseV1 {
        // `StateStore::load` and all state mutations fence this identity. Keep
        // the check here too: a stale in-memory state can never be used to
        // proxy a request after a generation replacement.
        if state.identity() != &self.config.identity {
            completion_cache.invalidate();
            return local_error(
                &request.request_id,
                RunCliErrorCodeV1::Unavailable,
                "This workspace is no longer active. Reconnect through Intar, then try again.",
                false,
            );
        }

        // The broker routes completion directly to its local cache. Keep this
        // defensive local branch too: a malformed caller can never make a Tab
        // press consume the report credential or wait on the control plane.
        if matches!(request.action, RunCliActionV1::Completion) {
            return completion_cache.response(&request.request_id);
        }

        if run_cli_action_mutates_completion_cache(&request.action) {
            completion_cache.invalidate();
        }

        if matches!(request.action, RunCliActionV1::CheckSync) {
            // A check action needs an immediate report before the control
            // plane builds its authoritative safe view. This runs inside this
            // loop so report sequence persistence and generation state cannot
            // race with another process.
            if self.report_current(state).await.is_err() {
                completion_cache.invalidate();
                return local_error(
                    &request.request_id,
                    RunCliErrorCodeV1::Unavailable,
                    "Checks are unavailable right now. Try again.",
                    true,
                );
            }
        }

        let response = match self
            .control_plane
            .run_cli(state.report_credential(), request)
            .await
        {
            Ok(response)
                if response.request_id == request.request_id
                    && response.validate_for_action(&request.action).is_ok() =>
            {
                response
            }
            Ok(_) => local_error(
                &request.request_id,
                RunCliErrorCodeV1::Internal,
                "The Intar service returned an invalid response. Try again.",
                true,
            ),
            Err(_) => local_error(
                &request.request_id,
                RunCliErrorCodeV1::Unavailable,
                "The Intar service is unavailable. Try again.",
                true,
            ),
        };
        if state.identity() != &self.config.identity {
            completion_cache.invalidate();
        } else if let RunCliResultV1::Ok { view } = &response.result {
            if !completion_cache.replace_from_view(view) {
                completion_cache.invalidate();
            }
        } else {
            completion_cache.invalidate();
        }
        response
    }

    /// Refresh aliases only through the explicit narrow completion action.
    /// This is called from the state-owning report loop, never from a learner
    /// completion connection.
    async fn refresh_completion_cache(
        &self,
        state: &GenerationState,
        completion_cache: &CompletionCache,
    ) -> bool {
        // Do not retain an older snapshot while an authoritative lookup is in
        // flight. A timeout or control-plane failure therefore yields no Tab
        // candidates rather than stale candidates.
        completion_cache.invalidate();
        if state.identity() != &self.config.identity {
            return false;
        }
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: format!(
                "completion-refresh-{}",
                NEXT_COMPLETION_REFRESH_REQUEST.fetch_add(1, Ordering::Relaxed)
            ),
            action: RunCliActionV1::Completion,
        };
        let response = match tokio::time::timeout(
            COMPLETION_REFRESH_TIMEOUT,
            self.control_plane
                .run_cli(state.report_credential(), &request),
        )
        .await
        {
            Ok(Ok(response))
                if response.request_id == request.request_id
                    && response.validate_for_action(&request.action).is_ok() =>
            {
                response
            }
            Ok(Ok(_)) | Ok(Err(_)) | Err(_) => return false,
        };
        if state.identity() != &self.config.identity {
            return false;
        }
        let RunCliResultV1::Completion { aliases } = response.result else {
            return false;
        };
        completion_cache.replace_aliases(aliases)
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

fn run_cli_action_mutates_completion_cache(action: &RunCliActionV1) -> bool {
    matches!(
        action,
        RunCliActionV1::HintReveal { .. }
            | RunCliActionV1::SolutionReveal
            | RunCliActionV1::CheckSync
    )
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
    use super::{WorkspaceAgent, tcp_ready, valid_linux_boot_id};
    use crate::checkpoint::{BuiltinCheckpointApplier, CheckpointApplier};
    use crate::client::{ClientError, ControlPlane};
    use crate::config::AgentConfig;
    use crate::kino::KinoClient;
    use crate::model::{
        AgentReport, BootstrapResponse, CheckpointCompression, CheckpointDescriptor,
        ExecutionIdentity, ReportResponse,
    };
    use crate::run_cli::{CompletionCache, local_error};
    use crate::secrets::SecretString;
    use crate::state::StateStore;
    use axum::response::IntoResponse;
    use futures_util::future::BoxFuture;
    use intar_contracts::run_cli::{
        RUN_CLI_PROTOCOL_VERSION, RunCliActionV1, RunCliErrorCodeV1, RunCliHintEntryV1,
        RunCliHintGroupV1, RunCliHintStateV1, RunCliRequestV1, RunCliResponseV1, RunCliResultV1,
        RunCliRunKindV1, RunCliRunV1, RunCliSolutionStateV1, RunCliSolutionV1, RunCliViewV1,
    };
    use prost::Message;
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tempfile::TempDir;
    use url::Url;

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

    #[tokio::test]
    async fn check_sync_reports_inside_the_state_loop_before_forwarding() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind Kino fixture");
        let address = listener.local_addr().expect("Kino fixture address");
        let router = axum::Router::new().route("/probes", axum::routing::get(kino_snapshot));
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("serve Kino fixture");
        });

        let temp = TempDir::new().expect("temporary state directory");
        let identity = execution_identity(2);
        let config = test_config(
            temp.path(),
            identity.clone(),
            Url::parse(&format!("http://{address}/probes")).expect("Kino URL"),
        );
        let control_plane = Arc::new(RecordingControlPlane::default());
        let agent = test_agent(config, control_plane.clone());
        let mut state = agent
            .state_store
            .install_bootstrap(bootstrap_response(identity))
            .expect("install state");
        agent
            .state_store
            .mark_checkpoint_applied(&mut state, vec!["00".to_owned()])
            .expect("mark checkpoint applied");
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "check-1".to_owned(),
            action: RunCliActionV1::CheckSync,
        };

        let completion_cache = CompletionCache::new(Duration::from_secs(60));
        let response = agent
            .run_cli_request(&mut state, &completion_cache, &request)
            .await;
        assert_eq!(response.request_id, "check-1");
        assert_eq!(
            control_plane.events.lock().expect("events lock").as_slice(),
            ["report", "cli"]
        );
        assert_eq!(control_plane.reports.load(Ordering::SeqCst), 1);
        assert_eq!(
            control_plane
                .credentials
                .lock()
                .expect("credentials lock")
                .as_slice(),
            [
                "generation-report-credential",
                "generation-report-credential"
            ]
        );
        let persisted = agent
            .state_store
            .load()
            .expect("load persisted state")
            .expect("state exists");
        assert_eq!(persisted.last_reserved_report_sequence(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn stale_generation_cannot_proxy_a_run_cli_request() {
        let temp = TempDir::new().expect("temporary state directory");
        let configured_identity = execution_identity(2);
        let control_plane = Arc::new(RecordingControlPlane::default());
        let agent = test_agent(
            test_config(
                temp.path(),
                configured_identity,
                Url::parse("http://127.0.0.1:18081/probes").expect("Kino URL"),
            ),
            control_plane.clone(),
        );
        let stale_identity = execution_identity(1);
        let stale_store = StateStore::new(temp.path().join("stale.json"), stale_identity.clone());
        let mut stale_state = stale_store
            .install_bootstrap(bootstrap_response(stale_identity))
            .expect("install stale state");
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "status-1".to_owned(),
            action: RunCliActionV1::Status,
        };

        let completion_cache = CompletionCache::new(Duration::from_secs(60));
        assert!(completion_cache.replace_aliases(vec!["general".to_owned()]));
        let response = agent
            .run_cli_request(&mut stale_state, &completion_cache, &request)
            .await;
        let RunCliResultV1::Error { error } = response.result else {
            panic!("stale generation must return an error");
        };
        assert_eq!(error.code, RunCliErrorCodeV1::Unavailable);
        assert!(control_plane.events.lock().expect("events lock").is_empty());
        assert!(matches!(
            completion_cache.response("completion-1").result,
            RunCliResultV1::Completion { ref aliases } if aliases.is_empty()
        ));
    }

    #[tokio::test]
    async fn non_check_actions_are_forwarded_without_local_policy_changes() {
        let temp = TempDir::new().expect("temporary state directory");
        let identity = execution_identity(2);
        let control_plane = Arc::new(RecordingControlPlane::default());
        let agent = test_agent(
            test_config(
                temp.path(),
                identity.clone(),
                Url::parse("http://127.0.0.1:18081/probes").expect("Kino URL"),
            ),
            control_plane.clone(),
        );
        let mut state = agent
            .state_store
            .install_bootstrap(bootstrap_response(identity))
            .expect("install state");
        let completion_cache = CompletionCache::new(Duration::from_secs(60));

        let actions = [
            RunCliActionV1::Status,
            RunCliActionV1::Hints,
            RunCliActionV1::HintReveal {
                alias: "check-1".to_owned(),
                expected_ordinal: 1,
            },
            RunCliActionV1::Solution,
            // The server owns the workshop facilitator-only policy; this
            // privileged guest broker must not make a divergent decision.
            RunCliActionV1::SolutionReveal,
        ];
        for (index, action) in actions.into_iter().enumerate() {
            let request = RunCliRequestV1 {
                protocol_version: RUN_CLI_PROTOCOL_VERSION,
                request_id: format!("action-{}", index + 1),
                action,
            };
            let _ = agent
                .run_cli_request(&mut state, &completion_cache, &request)
                .await;
        }

        assert_eq!(control_plane.reports.load(Ordering::SeqCst), 0);
        assert_eq!(
            control_plane.events.lock().expect("events lock").as_slice(),
            ["cli", "cli", "cli", "cli", "cli"]
        );
        assert_eq!(
            control_plane.requests.lock().expect("requests lock")[2].action,
            RunCliActionV1::HintReveal {
                alias: "check-1".to_owned(),
                expected_ordinal: 1,
            }
        );
    }

    #[tokio::test]
    async fn authoritative_refresh_fails_closed_and_normal_views_publish_aliases_only() {
        let temp = TempDir::new().expect("temporary state directory");
        let identity = execution_identity(2);
        let control_plane = Arc::new(RecordingControlPlane::default());
        *control_plane
            .completion_aliases
            .lock()
            .expect("completion aliases lock") =
            Some(vec!["check-3".to_owned(), "general".to_owned()]);
        *control_plane.normal_view.lock().expect("normal view lock") = Some(cli_view());
        let agent = test_agent(
            test_config(
                temp.path(),
                identity.clone(),
                Url::parse("http://127.0.0.1:18081/probes").expect("Kino URL"),
            ),
            control_plane.clone(),
        );
        let mut state = agent
            .state_store
            .install_bootstrap(bootstrap_response(identity))
            .expect("install state");
        let cache = CompletionCache::new(Duration::from_secs(60));

        assert!(agent.refresh_completion_cache(&state, &cache).await);
        assert_eq!(
            cache.response("completion-1").result,
            RunCliResultV1::Completion {
                aliases: vec!["check-3".to_owned(), "general".to_owned()],
            }
        );

        // A failed one-second refresh must clear the previous alias set. The
        // broker may be briefly less helpful, but it must not suggest a hint
        // which is no longer ready.
        *control_plane
            .completion_aliases
            .lock()
            .expect("completion aliases lock") = None;
        assert!(!agent.refresh_completion_cache(&state, &cache).await);
        assert!(matches!(
            cache.response("completion-after-error").result,
            RunCliResultV1::Completion { ref aliases } if aliases.is_empty()
        ));

        cache.invalidate();
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "status-1".to_owned(),
            action: RunCliActionV1::Status,
        };
        let response = agent.run_cli_request(&mut state, &cache, &request).await;
        assert!(matches!(response.result, RunCliResultV1::Ok { .. }));
        let completion = cache.response("completion-2");
        assert_eq!(
            completion.result,
            RunCliResultV1::Completion {
                aliases: vec!["check-3".to_owned(), "general".to_owned()],
            }
        );
        let serialized = serde_json::to_string(&completion).expect("serialize completion");
        assert!(!serialized.contains("body_markdown"));
        assert!(!serialized.contains("probe_id"));
        assert!(!serialized.contains("retry_scope"));
        assert!(
            control_plane
                .requests
                .lock()
                .expect("requests lock")
                .iter()
                .any(|request| matches!(request.action, RunCliActionV1::Completion))
        );
    }

    #[tokio::test]
    async fn failed_mutation_invalidates_completion_cache() {
        let temp = TempDir::new().expect("temporary state directory");
        let identity = execution_identity(2);
        let control_plane = Arc::new(RecordingControlPlane::default());
        let agent = test_agent(
            test_config(
                temp.path(),
                identity.clone(),
                Url::parse("http://127.0.0.1:18081/probes").expect("Kino URL"),
            ),
            control_plane,
        );
        let mut state = agent
            .state_store
            .install_bootstrap(bootstrap_response(identity))
            .expect("install state");
        let cache = CompletionCache::new(Duration::from_secs(60));
        assert!(cache.replace_aliases(vec!["general".to_owned()]));
        let request = RunCliRequestV1 {
            protocol_version: RUN_CLI_PROTOCOL_VERSION,
            request_id: "hint-1".to_owned(),
            action: RunCliActionV1::HintReveal {
                alias: "general".to_owned(),
                expected_ordinal: 1,
            },
        };

        let response = agent.run_cli_request(&mut state, &cache, &request).await;
        assert!(matches!(response.result, RunCliResultV1::Error { .. }));
        assert!(matches!(
            cache.response("completion-1").result,
            RunCliResultV1::Completion { ref aliases } if aliases.is_empty()
        ));
    }

    #[derive(Default)]
    struct RecordingControlPlane {
        reports: AtomicUsize,
        events: Mutex<Vec<&'static str>>,
        credentials: Mutex<Vec<String>>,
        requests: Mutex<Vec<RunCliRequestV1>>,
        completion_aliases: Mutex<Option<Vec<String>>>,
        normal_view: Mutex<Option<RunCliViewV1>>,
    }

    impl ControlPlane for RecordingControlPlane {
        fn bootstrap<'a>(
            &'a self,
            _identity: &'a ExecutionIdentity,
            _capability: &'a SecretString,
        ) -> BoxFuture<'a, Result<BootstrapResponse, ClientError>> {
            Box::pin(async { Err(ClientError::InvalidCredential) })
        }

        fn report<'a>(
            &'a self,
            credential: &'a SecretString,
            report: &'a AgentReport,
        ) -> BoxFuture<'a, Result<ReportResponse, ClientError>> {
            self.reports.fetch_add(1, Ordering::SeqCst);
            self.events.lock().expect("events lock").push("report");
            self.credentials
                .lock()
                .expect("credentials lock")
                .push(credential.expose().to_owned());
            let sequence = report.sequence;
            Box::pin(async move {
                Ok(ReportResponse {
                    accepted_sequence: sequence,
                    drain_recordings: false,
                    next_checkpoint: None,
                })
            })
        }

        fn upload_artifact<'a>(
            &'a self,
            _credential: &'a SecretString,
            _identity: &'a ExecutionIdentity,
            _kind: &'a str,
            _path: &'a Path,
            _max_bytes: u64,
        ) -> BoxFuture<'a, Result<String, ClientError>> {
            Box::pin(async { Err(ClientError::InvalidCredential) })
        }

        fn run_cli<'a>(
            &'a self,
            credential: &'a SecretString,
            request: &'a RunCliRequestV1,
        ) -> BoxFuture<'a, Result<intar_contracts::run_cli::RunCliResponseV1, ClientError>>
        {
            self.events.lock().expect("events lock").push("cli");
            self.requests
                .lock()
                .expect("requests lock")
                .push(request.clone());
            self.credentials
                .lock()
                .expect("credentials lock")
                .push(credential.expose().to_owned());
            let response = match request.action {
                RunCliActionV1::Completion => self
                    .completion_aliases
                    .lock()
                    .expect("completion aliases lock")
                    .clone()
                    .map(|aliases| RunCliResponseV1 {
                        protocol_version: RUN_CLI_PROTOCOL_VERSION,
                        request_id: request.request_id.clone(),
                        result: RunCliResultV1::Completion { aliases },
                    })
                    .unwrap_or_else(|| {
                        local_error(
                            &request.request_id,
                            RunCliErrorCodeV1::Unavailable,
                            "The Intar service is unavailable. Try again.",
                            true,
                        )
                    }),
                _ => self
                    .normal_view
                    .lock()
                    .expect("normal view lock")
                    .clone()
                    .map(|view| RunCliResponseV1 {
                        protocol_version: RUN_CLI_PROTOCOL_VERSION,
                        request_id: request.request_id.clone(),
                        result: RunCliResultV1::Ok { view },
                    })
                    .unwrap_or_else(|| {
                        local_error(
                            &request.request_id,
                            RunCliErrorCodeV1::Unavailable,
                            "The Intar service is unavailable. Try again.",
                            true,
                        )
                    }),
            };
            Box::pin(async move { Ok(response) })
        }
    }

    fn cli_view() -> RunCliViewV1 {
        RunCliViewV1 {
            retry_scope: "scope".to_owned(),
            run: RunCliRunV1 {
                kind: RunCliRunKindV1::Workshop,
                title: "Workshop".to_owned(),
                context: None,
            },
            checks: Vec::new(),
            hint_groups: vec![
                RunCliHintGroupV1 {
                    alias: "general".to_owned(),
                    label: "General guidance".to_owned(),
                    revealed_count: 0,
                    total_count: 1,
                    can_reveal: true,
                    entries: vec![RunCliHintEntryV1 {
                        ordinal: 1,
                        state: RunCliHintStateV1::Ready,
                        title: None,
                        body_markdown: None,
                    }],
                },
                RunCliHintGroupV1 {
                    alias: "check-3".to_owned(),
                    label: "Check 3".to_owned(),
                    revealed_count: 0,
                    total_count: 1,
                    can_reveal: true,
                    entries: vec![RunCliHintEntryV1 {
                        ordinal: 1,
                        state: RunCliHintStateV1::Ready,
                        title: None,
                        body_markdown: None,
                    }],
                },
                RunCliHintGroupV1 {
                    alias: "check-4".to_owned(),
                    label: "Check 4".to_owned(),
                    revealed_count: 0,
                    total_count: 1,
                    can_reveal: false,
                    entries: vec![RunCliHintEntryV1 {
                        ordinal: 1,
                        state: RunCliHintStateV1::Locked,
                        title: None,
                        body_markdown: None,
                    }],
                },
            ],
            solution: RunCliSolutionV1 {
                state: RunCliSolutionStateV1::Unavailable,
                assisted: false,
                body_markdown: None,
            },
        }
    }

    fn execution_identity(generation: u32) -> ExecutionIdentity {
        ExecutionIdentity {
            execution_id: "execution-1".to_owned(),
            workspace_id: "workspace-1".to_owned(),
            generation,
        }
    }

    fn bootstrap_response(identity: ExecutionIdentity) -> BootstrapResponse {
        BootstrapResponse {
            contract_version: crate::model::CONTRACT_VERSION,
            identity,
            report_credential: SecretString::new("generation-report-credential"),
            checkpoint: CheckpointDescriptor {
                checkpoint_id: "00".to_owned(),
                signed_url: SecretString::new(
                    "https://assets.intar.dev/checkpoint?signature=secret",
                ),
                sha256: "a".repeat(64),
                size_bytes: 1,
                compression: CheckpointCompression::None,
                signature_b64: base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    [0_u8; 64],
                ),
                signing_key_id: "runtime-v1".to_owned(),
                expires_at_unix_ms: i64::MAX,
            },
        }
    }

    fn test_config(root: &Path, identity: ExecutionIdentity, kino_url: Url) -> AgentConfig {
        AgentConfig {
            identity,
            control_plane_endpoint: Url::parse("https://intar.dev/api/runtime/workspace-agent/")
                .expect("control plane URL"),
            bootstrap_capability_path: root.join("bootstrap"),
            state_path: root.join("state.json"),
            checkpoint_tmpfs_dir: root.join("checkpoints"),
            checkpoint_apply_program: None,
            checkpoint_signing_keys: BTreeMap::from([(
                "runtime-v1".to_owned(),
                base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0_u8; 32]),
            )]),
            reconstruction_user: "intar".to_owned(),
            reconstruction_home: PathBuf::from("/home/intar"),
            kino_url,
            max_checkpoint_bytes: 1024,
            max_artifact_bytes: 1024,
            recording_dir: root.join("recordings"),
            recording_upload_staging_dir: root.join("recording-staging"),
            recording_drain_program: root.join("recording-drain"),
            require_checkpoint_tmpfs: false,
            run_cli_enabled: false,
        }
    }

    fn test_agent(
        config: AgentConfig,
        control_plane: Arc<RecordingControlPlane>,
    ) -> WorkspaceAgent {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let kino = KinoClient::new(config.kino_url.clone()).expect("Kino client");
        WorkspaceAgent::new_for_test(
            config,
            control_plane,
            reqwest::Client::new(),
            kino,
            Arc::new(BuiltinCheckpointApplier::root()) as Arc<dyn CheckpointApplier>,
        )
    }

    async fn kino_snapshot() -> axum::response::Response {
        let bytes = intar_kino_proto::kino_v1::ProbesSnapshotV1 {
            generated_at_unix_ms: 1,
            probes: Vec::new(),
            ssh_host_keys_openssh: vec!["ssh-ed25519 AAAATEST intar".to_owned()],
        }
        .encode_to_vec();
        (
            [(axum::http::header::CONTENT_TYPE, "application/x-protobuf")],
            bytes,
        )
            .into_response()
    }
}
