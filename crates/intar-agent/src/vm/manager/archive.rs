use super::*;

#[derive(Debug, Clone)]
pub(super) struct PreparedVmDeletion {
    run_id: String,
    vm_name: String,
    vm_created_at_ms: i64,
    delete_requested_at_ms: i64,
    deleted_at_ms: i64,
    artifacts_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunUploadBeginRequest {
    run_id: String,
    vm_name: String,
    created_at_ms: i64,
    delete_requested_at_ms: i64,
    deleted_at_ms: i64,
    /// Advertises that this agent will durably report granular archive
    /// milestones. The web control plane keeps older agents on its coarse
    /// phase mapping when this field is absent or unknown.
    archive_progress_version: u8,
    artifacts: Vec<RunUploadArtifactDescriptor>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RunUploadArtifactDescriptor {
    ordinal: u32,
    kind: String,
    filename: String,
    content_type: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MultipartBeginResponse {
    done: bool,
    next_expected_part: u32,
}

/// The begin endpoint is deliberately backward-compatible. Older web
/// deployments return their existing run/vm payload without this field, so
/// the agent must treat any absent or unrecognized value as no handshake.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunUploadBeginResponse {
    #[serde(default)]
    archive_progress_version: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RunUploadBeginOutcome {
    Registered { archive_progress_enabled: bool },
    MissingRemote,
}

impl RunUploadBeginOutcome {
    fn archive_progress_enabled(self) -> bool {
        matches!(
            self,
            Self::Registered {
                archive_progress_enabled: true
            }
        )
    }
}

#[derive(Debug, Clone)]
pub(super) struct LocalArtifact {
    pub(super) ordinal: u32,
    pub(super) kind: String,
    pub(super) filename: String,
    pub(super) content_type: String,
    pub(super) size_bytes: u64,
    pub(super) sha256: String,
    pub(super) path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ArchiveUploadOutcome {
    Uploaded,
    DiscardedMissingRemote,
}

/// Private control-plane milestones. They are deliberately learner-safe: the
/// server projects only their aggregate rank, never paths, artifact names, or
/// retry details.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ArchiveStage {
    RawFilesSaved,
    ReplayPrepared,
    ReplaySkipped,
}

#[derive(Debug, Serialize)]
pub(super) struct RunArchiveStageRequest {
    pub(super) stage: ArchiveStage,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentBootstrapRequest<'a> {
    pub(super) host_id: &'a str,
    pub(super) bootstrap_token: &'a str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentBootstrapResponse {
    pub(super) access_token: String,
}

pub(super) async fn queue_archive_job(inner: &Inner, prepared: &PreparedVmDeletion) -> Result<()> {
    let now = now_unix_ms();
    inner
        .db
        .upsert_archive_job(ArchiveJobRow {
            run_id: prepared.run_id.clone(),
            vm_name: prepared.vm_name.clone(),
            vm_created_at_ms: prepared.vm_created_at_ms,
            delete_requested_at_ms: prepared.delete_requested_at_ms,
            deleted_at_ms: prepared.deleted_at_ms,
            artifacts_dir: prepared.artifacts_dir.display().to_string(),
            next_attempt_at_ms: now,
            retry_count: 0,
            last_error: None,
            created_at_ms: now,
            updated_at_ms: now,
        })
        .await
        .context("failed to persist archive job")?;

    // The durable row exists before waking the worker. `Notify` retains one
    // permit if the worker is between waits, and one wake is enough because a
    // retry scan drains every currently due row up to the normal batch limit.
    inner.archive_jobs_notify.notify_one();
    info!(
        event = "scenario_run_archive_queued",
        run_id = prepared.run_id,
        vm = prepared.vm_name,
        queued_at_ms = now,
        "queued durable archive job and woke archive worker"
    );
    Ok(())
}

pub(super) async fn retry_archive_jobs(inner: &Inner) -> Result<()> {
    let _guard = inner.archive_jobs_lock.lock().await;
    let jobs = inner
        .db
        .load_due_archive_jobs(now_unix_ms(), ARCHIVE_JOB_BATCH_SIZE)
        .await
        .context("failed to load due archive jobs")?;
    let filled_batch = archive_batch_needs_follow_up(jobs.len());

    for job in jobs {
        process_archive_job(inner, job).await?;
    }

    // `Notify` coalesces adjacent queue insertions into one permit. When this
    // scan filled the bounded batch, schedule another immediate scan so the
    // next due job does not wait for the ten-second recovery sweep.
    if filled_batch {
        inner.archive_jobs_notify.notify_one();
    }

    Ok(())
}

pub(super) async fn wait_for_archive_worker_signal(notify: &Notify) {
    notify.notified().await;
}

pub(super) fn archive_batch_needs_follow_up(job_count: usize) -> bool {
    job_count == ARCHIVE_JOB_BATCH_SIZE
}

pub(super) async fn process_archive_job(inner: &Inner, job: ArchiveJobRow) -> Result<()> {
    let attempt_started_at = Instant::now();
    let attempt_started_unix_ms = now_unix_ms();
    // `updated_at_ms` is the durable moment this attempt became due: initial
    // insert for attempt one, then the last retry scheduling update.
    let queue_wait_ms = elapsed_since_unix_ms(job.updated_at_ms, attempt_started_unix_ms);
    info!(
        event = "scenario_run_archive_started",
        run_id = job.run_id,
        vm = job.vm_name,
        retry_count = job.retry_count,
        queue_wait_ms,
        "started archive job"
    );

    match upload_archive_job(inner, &job).await {
        Ok(outcome) => {
            inner
                .db
                .delete_archive_job(job.run_id.clone(), job.vm_name.clone())
                .await
                .context("failed to delete completed archive job")?;
            if let Err(error) = delete_archive_spool(&job.artifacts_dir).await {
                warn!(
                    error = %error,
                    vm = job.vm_name,
                    run_id = job.run_id,
                    path = job.artifacts_dir,
                    "failed to delete archive spool after upload"
                );
            }
            match outcome {
                ArchiveUploadOutcome::Uploaded => {
                    info!(
                        vm = job.vm_name,
                        run_id = job.run_id,
                        "uploaded archived vm artifacts"
                    );
                }
                ArchiveUploadOutcome::DiscardedMissingRemote => {
                    info!(
                        vm = job.vm_name,
                        run_id = job.run_id,
                        "discarded archived vm artifacts because the remote run/vm no longer exists"
                    );
                }
            }
            let completed_at_ms = now_unix_ms();
            info!(
                event = "scenario_run_archive_timing",
                run_id = job.run_id,
                vm = job.vm_name,
                outcome = archive_upload_outcome_name(outcome),
                queue_wait_ms,
                processing_ms = elapsed_since_instant(attempt_started_at),
                total_ms = elapsed_since_unix_ms(job.created_at_ms, completed_at_ms),
                teardown_to_archive_complete_ms =
                    elapsed_since_unix_ms(job.delete_requested_at_ms, completed_at_ms,),
                "archive job completed"
            );
        }
        Err(error) => {
            let retry_count = job.retry_count.saturating_add(1);
            let next_attempt_at_ms = archive_retry_at(now_unix_ms(), retry_count);
            let message = error_chain_to_string(&error);
            inner
                .db
                .update_archive_job_retry(
                    job.run_id.clone(),
                    job.vm_name.clone(),
                    next_attempt_at_ms,
                    retry_count,
                    Some(message.clone()),
                    now_unix_ms(),
                )
                .await
                .context("failed to update archive job retry state")?;
            warn!(
                event = "scenario_run_archive_retry",
                error = %message,
                vm = job.vm_name,
                run_id = job.run_id,
                retry_count,
                next_attempt_at_ms,
                "archive job failed and will be retried"
            );
            let failed_at_ms = now_unix_ms();
            warn!(
                event = "scenario_run_archive_timing",
                run_id = job.run_id,
                vm = job.vm_name,
                outcome = "retrying",
                queue_wait_ms,
                processing_ms = elapsed_since_instant(attempt_started_at),
                total_ms = elapsed_since_unix_ms(job.created_at_ms, failed_at_ms),
                teardown_to_archive_complete_ms =
                    elapsed_since_unix_ms(job.delete_requested_at_ms, failed_at_ms,),
                "archive job attempt finished with a retry"
            );
        }
    }

    Ok(())
}

pub(super) fn elapsed_since_unix_ms(started_at_ms: i64, now_ms: i64) -> i64 {
    now_ms.saturating_sub(started_at_ms).max(0)
}

fn elapsed_since_instant(started_at: Instant) -> u64 {
    started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn archive_upload_outcome_name(outcome: ArchiveUploadOutcome) -> &'static str {
    match outcome {
        ArchiveUploadOutcome::Uploaded => "uploaded",
        ArchiveUploadOutcome::DiscardedMissingRemote => "discarded_missing_remote",
    }
}

pub(super) async fn upload_archive_job(
    inner: &Inner,
    job: &ArchiveJobRow,
) -> Result<ArchiveUploadOutcome> {
    let prepared = PreparedVmDeletion {
        run_id: job.run_id.clone(),
        vm_name: job.vm_name.clone(),
        vm_created_at_ms: job.vm_created_at_ms,
        delete_requested_at_ms: job.delete_requested_at_ms,
        deleted_at_ms: job.deleted_at_ms,
        artifacts_dir: PathBuf::from(&job.artifacts_dir),
    };
    upload_vm_run_artifacts(inner, &job.vm_name, &prepared).await
}

pub(super) async fn delete_archive_spool(artifacts_dir: &str) -> Result<()> {
    let artifacts_path = PathBuf::from(artifacts_dir);
    let target = artifacts_path.parent().unwrap_or(artifacts_path.as_path());
    match tokio::fs::remove_dir_all(target).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(anyhow::anyhow!(
            "failed to delete archive spool {}: {error}",
            target.display()
        )),
    }
}

pub(super) fn archive_retry_at(now_ms: i64, retry_count: i64) -> i64 {
    let exponent = retry_count.saturating_sub(1).clamp(0, 10) as u32;
    let backoff = ARCHIVE_RETRY_BASE_MS
        .saturating_mul(1_i64.checked_shl(exponent).unwrap_or(i64::MAX))
        .min(ARCHIVE_RETRY_MAX_MS);
    now_ms.saturating_add(backoff)
}

pub(super) async fn prepare_vm_for_delete(
    inner: &Inner,
    vm: &VmStatusResponse,
) -> Result<PreparedVmDeletion> {
    let details = vm
        .details
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("vm {} has no details", vm.name))?;
    let run_id = details
        .run_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("vm {} details missing run_id", vm.name))?;
    let delete_requested_at_ms = now_unix_ms();

    teardown_vm_runtime(inner, vm).await;

    let spool_dir = details
        .spool_dir
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let work_dir =
                resolve_work_dir(&inner.defaults).unwrap_or_else(|_| PathBuf::from("/tmp"));
            run_spool_dir(&work_dir, &run_id)
        });
    let artifacts_dir = spool_dir.join("artifacts");
    tokio::fs::create_dir_all(&artifacts_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create artifact spool at {}",
                artifacts_dir.display()
            )
        })?;

    copy_vm_log_to_spool(vm, "console.log", &artifacts_dir.join("console.log")).await?;
    copy_vm_log_to_spool(vm, "serial.log", &artifacts_dir.join("serial.log")).await?;
    copy_vm_log_to_spool(
        vm,
        CLOUD_HYPERVISOR_STDERR_LOG_NAME,
        &artifacts_dir.join(CLOUD_HYPERVISOR_STDERR_LOG_NAME),
    )
    .await?;

    if let Some(recording_disk_path) = recording_export_path_for_cleanup(details)? {
        extract_recordings_to_spool(recording_disk_path, &artifacts_dir).await?;
    }

    Ok(PreparedVmDeletion {
        run_id,
        vm_name: vm.name.clone(),
        vm_created_at_ms: vm.created_at_s.saturating_mul(1000),
        delete_requested_at_ms,
        deleted_at_ms: now_unix_ms(),
        artifacts_dir,
    })
}

pub(super) async fn teardown_vm_runtime(inner: &Inner, vm: &VmStatusResponse) {
    stop_probe_worker(inner, &vm.name).await;
    stop_terminal_worker(inner, &vm.name).await;

    let Some(details) = vm.details.as_ref() else {
        return;
    };

    stop_cloud_hypervisor(inner, details, &vm.name).await;
}

pub(super) async fn release_jailed_runtime(inner: &Inner, vm: &VmStatusResponse) -> Result<()> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(());
    };

    if let Some(generation) = details.jail_generation.as_deref() {
        jailer_identity_request(inner, generation, JailerIdentityOperation::Destroy)
            .await
            .with_context(|| format!("destroy jail generation {generation}"))?;
    } else if let Some(selector) = generationless_v6_launch_cleanup_selector(vm)? {
        // A process crash can leave SQLite in any prelaunch state after
        // jailerd has committed LaunchVmV2 but before persist_jail_launch records
        // the fresh generation (an earlier state transition may itself have
        // failed to persist). Resolve only that narrow V6 window by the
        // protocol's typed logical identity and drain it before considering
        // the shared run network. Historical generation-less rows do not
        // carry the V6 resource markers and deliberately stay local-only.
        cleanup_jailed_vm_by_selector(inner, selector)
            .await
            .context("destroy generation-less jailed launch")?;
    }

    let Some(run_id) = details.run_id.as_deref() else {
        return Ok(());
    };
    let has_other_vm = {
        let states = inner.states.read().await;
        has_other_tracked_vm_for_run(&states, &vm.name, run_id)
    };
    if has_other_vm {
        return Ok(());
    }

    let run_id = ValidatedId::parse(run_id.to_string()).context("validate persisted run ID")?;
    match request_jailerd(
        inner,
        JailerRequest::DestroyRunNetwork(DestroyRunNetworkRequest { run_id }),
    )
    .await?
    {
        JailerResponse::DestroyRunNetwork(_) => Ok(()),
        JailerResponse::Error(error) if error.code == "not_found" => Ok(()),
        JailerResponse::Error(error) => {
            anyhow::bail!("jailerd {}: {}", error.code, error.message)
        }
        response => anyhow::bail!(
            "jailerd returned unexpected response to destroy_run_network: {response:?}"
        ),
    }
}

pub(super) fn generationless_v6_launch_cleanup_selector(
    vm: &VmStatusResponse,
) -> Result<Option<VmIdentityRequest>> {
    let Some(details) = vm.details.as_ref() else {
        return Ok(None);
    };
    if details.jail_generation.is_some()
        || details.cpu_millis.is_none()
        || details.vcpu_count.is_none()
    {
        return Ok(None);
    }

    let run_id = details
        .run_id
        .as_deref()
        .map(str::trim)
        .filter(|run_id| !run_id.is_empty())
        .context("generation-less V6 launch is missing its run ID")?;
    Ok(Some(VmIdentityRequest::by_logical_id(
        ValidatedId::parse(run_id.to_string())
            .context("validate generation-less V6 launch run ID")?,
        ValidatedId::parse(vm.name.clone()).context("validate generation-less V6 launch VM ID")?,
    )))
}

pub(super) fn has_other_tracked_vm_for_run(
    states: &BTreeMap<String, VmStatusResponse>,
    vm_name: &str,
    run_id: &str,
) -> bool {
    states.iter().any(|(name, status)| {
        name != vm_name
            && status
                .details
                .as_ref()
                .and_then(|details| details.run_id.as_deref())
                == Some(run_id)
    })
}

pub(super) async fn upload_vm_run_artifacts(
    inner: &Inner,
    vm_name: &str,
    prepared: &PreparedVmDeletion,
) -> Result<ArchiveUploadOutcome> {
    let access_token = bootstrap_agent_access_token(&inner.bridge, &inner.http).await?;
    let mut artifacts = collect_local_artifacts(&prepared.artifacts_dir).await?;

    let initial_begin = begin_run_upload(inner, prepared, &artifacts, &access_token).await?;
    if initial_begin == RunUploadBeginOutcome::MissingRemote {
        warn!(
            vm = vm_name,
            run_id = prepared.run_id,
            "remote run/vm missing during artifact upload begin; skipping upload and treating vm as orphaned local state"
        );
        return Ok(ArchiveUploadOutcome::DiscardedMissingRemote);
    }
    upload_artifact_set(inner, vm_name, prepared, &artifacts, &access_token).await?;
    let mut raw_files_stage_reported = false;
    if initial_begin.archive_progress_enabled() {
        report_archive_stage(inner, prepared, ArchiveStage::RawFilesSaved, &access_token).await?;
        raw_files_stage_reported = true;
    }

    // Render and attach session media before sealing the run. Once completion
    // is acknowledged the control plane rejects every new artifact mutation,
    // which makes hard deletion race-free with respect to this archive job.
    match render_replay_artifacts(&prepared.artifacts_dir, next_artifact_ordinal(&artifacts)).await
    {
        Ok(Some((casts, timeline))) => {
            let new_start = artifacts.len();
            artifacts.extend(casts);
            let replay_begin = begin_run_upload(inner, prepared, &artifacts, &access_token).await?;
            if replay_begin == RunUploadBeginOutcome::MissingRemote {
                warn!(
                    vm = vm_name,
                    run_id = prepared.run_id,
                    "remote run/vm vanished during replay registration; treating vm as orphaned local state"
                );
                return Ok(ArchiveUploadOutcome::DiscardedMissingRemote);
            }
            upload_artifact_set(
                inner,
                vm_name,
                prepared,
                &artifacts[new_start..],
                &access_token,
            )
            .await?;
            let replay_stage =
                match submit_run_timeline(inner, prepared, &timeline, &access_token).await {
                    Ok(()) => archive_stage_after_replay(true, true),
                    Err(error) => {
                        warn!(
                            event = "scenario_run_replay_failed",
                            stage = "timeline_submission",
                            error = %error,
                            vm = vm_name,
                            run_id = prepared.run_id,
                            "failed to submit session timeline; archiving run without one"
                        );
                        archive_stage_after_replay(true, false)
                    }
                };
            // A replay re-registration may be the first successful capability
            // handshake after a web rollout. Catch up the already-complete raw
            // milestone first, then preserve the server's monotonic order.
            if replay_begin.archive_progress_enabled() {
                if !raw_files_stage_reported {
                    report_archive_stage(
                        inner,
                        prepared,
                        ArchiveStage::RawFilesSaved,
                        &access_token,
                    )
                    .await?;
                }
                report_archive_stage(inner, prepared, replay_stage, &access_token).await?;
            }
        }
        Ok(None) => {
            if raw_files_stage_reported {
                report_archive_stage(
                    inner,
                    prepared,
                    archive_stage_after_replay(false, false),
                    &access_token,
                )
                .await?;
            }
        }
        Err(error) => {
            warn!(
                event = "scenario_run_replay_failed",
                stage = "session_render",
                error = %error,
                vm = vm_name,
                run_id = prepared.run_id,
                "failed to render session media; archiving run without a replay"
            );
            if raw_files_stage_reported {
                report_archive_stage(
                    inner,
                    prepared,
                    archive_stage_after_replay(false, false),
                    &access_token,
                )
                .await?;
            }
        }
    }

    complete_run_upload(inner, prepared, &access_token).await?;

    Ok(ArchiveUploadOutcome::Uploaded)
}

/// A replay is learner-ready only when its session timeline was accepted.
/// Empty or unrenderable recording spools deliberately advance to the same
/// finalizing milestone without promising a replay that the recap cannot use.
pub(super) fn archive_stage_after_replay(
    has_rendered_replay: bool,
    timeline_submitted: bool,
) -> ArchiveStage {
    if has_rendered_replay && timeline_submitted {
        ArchiveStage::ReplayPrepared
    } else {
        ArchiveStage::ReplaySkipped
    }
}

/// Progress reporting is part of the durable archive protocol. The job is
/// retried if this request fails, so completion can never get ahead of a
/// learner-visible milestone.
async fn report_archive_stage(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    stage: ArchiveStage,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let stage_url = format!(
        "{}/agent/runs/{}/vms/{}/archive-stage",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    post_archive_stage(&inner.http, &stage_url, stage, access_token).await
}

pub(super) async fn post_archive_stage(
    http: &HttpClient,
    stage_url: &str,
    stage: ArchiveStage,
    access_token: &str,
) -> Result<()> {
    let response = http
        .post(stage_url)
        .bearer_auth(access_token)
        // A stage report is required before completion, but its small payload
        // must not spend the archive client's 120-second transfer deadline.
        .timeout(ARCHIVE_STAGE_REPORT_TIMEOUT)
        .json(&RunArchiveStageRequest { stage })
        .send()
        .await
        .with_context(|| format!("failed to report archive stage at {stage_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("archive stage report failed with status {status}: {body}");
    }
    Ok(())
}

pub(super) async fn complete_run_upload(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let complete_url = format!(
        "{}/agent/runs/{}/vms/{}/complete",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    let response = inner
        .http
        .post(&complete_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to complete run upload at {complete_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("run complete failed with status {status}: {body}");
    }
    Ok(())
}

/// Registers `artifacts` with the run upload. The endpoint merges by
/// ordinal, so calling this again with a superset only adds the new entries.
/// A successful response opts into granular stages only when it explicitly
/// acknowledges the version this agent advertised.
pub(super) async fn begin_run_upload(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    artifacts: &[LocalArtifact],
    access_token: &str,
) -> Result<RunUploadBeginOutcome> {
    let begin_request = RunUploadBeginRequest {
        run_id: prepared.run_id.clone(),
        vm_name: prepared.vm_name.clone(),
        created_at_ms: prepared.vm_created_at_ms,
        delete_requested_at_ms: prepared.delete_requested_at_ms,
        deleted_at_ms: prepared.deleted_at_ms,
        archive_progress_version: 1,
        artifacts: artifacts
            .iter()
            .map(|artifact| RunUploadArtifactDescriptor {
                ordinal: artifact.ordinal,
                kind: artifact.kind.clone(),
                filename: artifact.filename.clone(),
                content_type: artifact.content_type.clone(),
                size_bytes: artifact.size_bytes,
                sha256: artifact.sha256.clone(),
            })
            .collect(),
    };

    let begin_url = format!("{}/agent/runs/begin", inner.bridge.base_url);
    let begin_response = inner
        .http
        .post(&begin_url)
        .bearer_auth(access_token)
        .json(&begin_request)
        .send()
        .await
        .with_context(|| format!("failed to call run begin endpoint at {begin_url}"))?;
    if !begin_response.status().is_success() {
        let status = begin_response.status();
        let body = begin_response.text().await.unwrap_or_default();
        if is_run_purged_remote_response(status, &body) {
            return Ok(RunUploadBeginOutcome::MissingRemote);
        }
        anyhow::bail!("run begin failed with status {status}: {body}");
    }
    // An old web deployment may return the established payload with no
    // capability field, or even no readable JSON body. Both are a safe coarse
    // fallback: uploads and completion remain unchanged, only stage callbacks
    // are suppressed.
    let body = begin_response.text().await.unwrap_or_default();
    Ok(RunUploadBeginOutcome::Registered {
        archive_progress_enabled: archive_progress_acknowledged(&body),
    })
}

pub(super) fn archive_progress_acknowledged(begin_response_body: &str) -> bool {
    let Ok(response) = serde_json::from_str::<RunUploadBeginResponse>(begin_response_body) else {
        return false;
    };
    matches!(
        response.archive_progress_version,
        Some(serde_json::Value::Number(version)) if version.as_u64() == Some(1)
    )
}

pub(super) async fn upload_artifact_set(
    inner: &Inner,
    vm_name: &str,
    prepared: &PreparedVmDeletion,
    artifacts: &[LocalArtifact],
    access_token: &str,
) -> Result<()> {
    stream::iter(artifacts.iter().cloned().map(|artifact| {
        let prepared = prepared.clone();
        let access_token = access_token.to_string();
        let vm_name = vm_name.to_string();
        async move {
            upload_single_artifact(inner, &prepared, &artifact, &access_token)
                .await
                .with_context(|| format!("failed to upload {} for {}", artifact.filename, vm_name))
        }
    }))
    .buffer_unordered(ARTIFACT_UPLOAD_CONCURRENCY)
    .try_collect::<Vec<_>>()
    .await?;
    Ok(())
}

pub(super) fn next_artifact_ordinal(artifacts: &[LocalArtifact]) -> u32 {
    artifacts
        .iter()
        .map(|artifact| artifact.ordinal)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
}

pub(super) async fn render_replay_artifacts(
    artifacts_dir: &Path,
    first_ordinal: u32,
) -> Result<Option<(Vec<LocalArtifact>, replay_media::TimelineDocument)>> {
    let Some(rendered) = replay_media::render_session_media(artifacts_dir).await? else {
        return Ok(None);
    };
    let mut artifacts = Vec::with_capacity(rendered.cast_paths.len());
    let mut ordinal = first_ordinal;
    for path in &rendered.cast_paths {
        artifacts.push(
            describe_local_artifact(
                ordinal,
                replay_media::SESSION_CAST_KIND,
                path,
                "application/x-asciicast; charset=utf-8",
            )
            .await?,
        );
        ordinal = ordinal.saturating_add(1);
    }
    Ok(Some((artifacts, rendered.timeline)))
}

/// Hands the rendered timeline (session metadata + transcripts) to the
/// control plane, which stores it in its database — it never touches R2.
pub(super) async fn submit_run_timeline(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    timeline: &replay_media::TimelineDocument,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let timeline_url = format!(
        "{}/agent/runs/{}/vms/{}/timeline",
        inner.bridge.base_url, run_id_segment, vm_name_segment
    );
    let response = inner
        .http
        .post(&timeline_url)
        .bearer_auth(access_token)
        .json(timeline)
        .send()
        .await
        .with_context(|| format!("failed to submit run timeline at {timeline_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("timeline submission failed with status {status}: {body}");
    }
    Ok(())
}

pub(super) async fn upload_single_artifact(
    inner: &Inner,
    prepared: &PreparedVmDeletion,
    artifact: &LocalArtifact,
    access_token: &str,
) -> Result<()> {
    let run_id_segment = encode_url_path_segment(&prepared.run_id);
    let vm_name_segment = encode_url_path_segment(&prepared.vm_name);
    let begin_url = format!(
        "{}/agent/runs/{}/vms/{}/artifacts/{}/multipart-begin",
        inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal
    );
    let begin_response = inner
        .http
        .post(&begin_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to start artifact upload at {begin_url}"))?;
    if !begin_response.status().is_success() {
        let status = begin_response.status();
        let body = begin_response.text().await.unwrap_or_default();
        anyhow::bail!("artifact begin failed with status {status}: {body}");
    }
    let begin_payload = begin_response
        .json::<MultipartBeginResponse>()
        .await
        .context("failed to decode artifact begin response")?;
    if begin_payload.done {
        return Ok(());
    }

    let mut file = tokio::fs::File::open(&artifact.path)
        .await
        .with_context(|| format!("failed to open artifact {}", artifact.path.display()))?;
    let start_offset = u64::from(begin_payload.next_expected_part.saturating_sub(1))
        * ARTIFACT_UPLOAD_PART_BYTES as u64;
    if start_offset > 0 {
        use tokio::io::AsyncSeekExt as _;
        file.seek(std::io::SeekFrom::Start(start_offset))
            .await
            .with_context(|| format!("failed to seek artifact {}", artifact.path.display()))?;
    }

    let mut part_number = begin_payload.next_expected_part.max(1);
    let mut buffer = vec![0_u8; ARTIFACT_UPLOAD_PART_BYTES];
    loop {
        use tokio::io::AsyncReadExt as _;
        let read = file
            .read(&mut buffer)
            .await
            .with_context(|| format!("failed to read artifact {}", artifact.path.display()))?;
        if read == 0 {
            break;
        }

        let part_url = format!(
            "{}/agent/runs/{}/vms/{}/artifacts/{}/parts/{}",
            inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal, part_number
        );
        let response = inner
            .http
            .put(&part_url)
            .bearer_auth(access_token)
            .body(buffer[..read].to_vec())
            .send()
            .await
            .with_context(|| format!("failed to upload artifact part at {part_url}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("artifact part upload failed with status {status}: {body}");
        }
        part_number = part_number.saturating_add(1);
    }

    let complete_url = format!(
        "{}/agent/runs/{}/vms/{}/artifacts/{}/complete",
        inner.bridge.base_url, run_id_segment, vm_name_segment, artifact.ordinal
    );
    let response = inner
        .http
        .post(&complete_url)
        .bearer_auth(access_token)
        .send()
        .await
        .with_context(|| format!("failed to complete artifact upload at {complete_url}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        anyhow::bail!("artifact complete failed with status {status}: {body}");
    }

    Ok(())
}

pub(super) fn encode_url_path_segment(input: &str) -> String {
    let mut encoded = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(char::from(byte));
            }
            _ => {
                encoded.push('%');
                encoded.push(hex_upper(byte >> 4));
                encoded.push(hex_upper(byte & 0x0f));
            }
        }
    }
    encoded
}

pub(super) fn hex_upper(nibble: u8) -> char {
    match nibble {
        0..=9 => char::from(b'0' + nibble),
        10..=15 => char::from(b'A' + (nibble - 10)),
        _ => '0',
    }
}

pub(super) async fn remove_vm_staging_paths(
    vm_name: &str,
    vm_dir: &Path,
    spool_dir: &Path,
) -> Result<()> {
    let mut failures = Vec::new();
    for (kind, path) in [("vm dir", vm_dir), ("vm spool", spool_dir)] {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => {
                info!(vm = vm_name, path = %path.display(), "removed staged {kind}");
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                failures.push(format!(
                    "failed to remove {kind} {}: {error}",
                    path.display()
                ));
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        anyhow::bail!(failures.join("; "))
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    #[test]
    fn run_upload_begin_advertises_archive_progress_v1_in_camel_case() {
        let payload = RunUploadBeginRequest {
            run_id: "run".to_string(),
            vm_name: "vm".to_string(),
            created_at_ms: 1,
            delete_requested_at_ms: 2,
            deleted_at_ms: 3,
            archive_progress_version: 1,
            artifacts: Vec::new(),
        };

        let json = serde_json::to_value(payload).expect("serialize upload begin payload");
        assert_eq!(json.get("archiveProgressVersion"), Some(&json!(1)));
        assert!(json.get("archive_progress_version").is_none());
    }
}
