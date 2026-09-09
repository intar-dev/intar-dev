use super::*;

const PUBLICATION_POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedEncodedImageChunk {
    descriptor: intar_contracts::catalog::ImageChunkV1,
    source_path: Option<PathBuf>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct PersistedBuildOutput {
    manifest: intar_contracts::catalog::ScenarioManifestV4,
    vm_name: String,
    image_id: String,
    chunk_manifest_sha256: String,
    chunk_manifest_path: PathBuf,
    chunks: Vec<PersistedEncodedImageChunk>,
    kernel_sha256_hex: String,
    kernel_path: PathBuf,
    initrd_sha256_hex: String,
    initrd_path: PathBuf,
}

pub(super) async fn builder_worker_loop(
    cfg: config::BuilderConfig,
    report_tx: mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    mut desired_revision: watch::Receiver<u64>,
    worker_id: u16,
) {
    while *desired_revision.borrow() == 0 {
        if desired_revision.changed().await.is_err() {
            warn!(
                worker_id,
                "builder worker stopped before receiving fresh desired state"
            );
            return;
        }
    }
    info!(worker_id, "builder worker received fresh desired state");

    let mut queue_poll = interval(Duration::from_secs(1));
    queue_poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    queue_poll.tick().await;
    loop {
        loop {
            match process_next_queued_build(&cfg, &report_tx).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    warn!(worker_id, error = %error, "builder worker failed to process queued build");
                    break;
                }
            }
        }
        tokio::select! {
            changed = desired_revision.changed() => {
                if changed.is_err() {
                    warn!(worker_id, "builder desired-state notifier closed");
                    return;
                }
            }
            _ = queue_poll.tick() => {}
        }
    }
}

pub(super) async fn publication_worker_loop(
    cfg: config::BuilderConfig,
    report_tx: mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    mut desired_revision: watch::Receiver<u64>,
    worker_id: u16,
) {
    while *desired_revision.borrow() == 0 {
        if desired_revision.changed().await.is_err() {
            warn!(
                worker_id,
                "publication worker stopped before receiving fresh desired state"
            );
            return;
        }
    }
    info!(worker_id, "publication worker received fresh desired state");

    let mut poll = interval(PUBLICATION_POLL_INTERVAL);
    poll.set_missed_tick_behavior(MissedTickBehavior::Delay);
    poll.tick().await;
    loop {
        loop {
            match process_next_publication(&cfg, &report_tx).await {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    warn!(worker_id, error = %error, "publication worker failed to process output");
                    break;
                }
            }
        }
        tokio::select! {
            changed = desired_revision.changed() => {
                if changed.is_err() {
                    warn!(worker_id, "builder desired-state notifier closed");
                    return;
                }
            }
            _ = poll.tick() => {}
        }
    }
}

pub(super) async fn process_next_queued_build(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<bool> {
    let Some(job) = ({
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.claim_next_queued_build(now_unix_ms())?
    }) else {
        return Ok(false);
    };
    let result = async {
        emit_build_report(cfg, report_tx, &job.build_id).await?;

        let result = run_claimed_build_job(cfg, &job, report_tx).await;
        if let Err(error) = result {
            let error_message = format!("{error:#}");
            let now = now_unix_ms();
            {
                let db = db::BuilderDb::open(&cfg.builder.state_db)?;
                if should_retry_build_error(&error, job.attempt, cfg.jobs.max_attempts) {
                    let next_attempt_at_ms = now.saturating_add(retry_delay_ms(job.attempt));
                    db.schedule_build_job_retry(
                        &job.build_id,
                        job.attempt,
                        &error_message,
                        next_attempt_at_ms,
                        now,
                    )?;
                    warn!(
                        build_id = %job.build_id,
                        attempt = job.attempt,
                        next_attempt_at_ms,
                        "scheduled builder job retry"
                    );
                } else {
                    db.update_build_job_phase(
                        &job.build_id,
                        "failed",
                        None,
                        job.attempt,
                        Some(&error_message),
                        now,
                    )?;
                }
            }
            emit_build_report(cfg, report_tx, &job.build_id).await?;
            return Err(error);
        }

        Ok(true)
    }
    .await;

    if result.is_err() {
        // A durable output belongs to the publication worker. Only remove
        // files after an unsuccessful compute attempt.
        cleanup_reported_build_attempt_artifacts(cfg, &job.build_id).await;
    }
    result
}

pub(super) async fn run_claimed_build_job(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<()> {
    let mut log_files = Vec::new();
    let result = run_claimed_build_job_inner(cfg, job, report_tx, &mut log_files).await;
    if result.is_err() {
        upload_build_logs_with_fresh_token_best_effort(
            cfg,
            &job.build_id,
            &log_files,
            "builder job failure",
        )
        .await;
    }
    result
}

async fn run_claimed_build_job_inner(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    log_files: &mut Vec<BuildLogFile>,
) -> Result<()> {
    let desired_build = job.desired_build();
    let download_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before bundle download")?;
    let bundle_archive = download_bundle_archive(
        &cfg.bridge.base_url,
        &download_token,
        &desired_build.rev,
        &cfg.builder.cache_root,
    )
    .await?;
    let bundle_root = unpacked_bundle_root(&cfg.builder.cache_root, &desired_build.rev);
    unpack_bundle_archive(&bundle_archive, &bundle_root)?;
    let bundle_input =
        verify_bundle_or_drop_cached_archive(&bundle_archive, &bundle_root, &desired_build)
            .await
            .map_err(non_retryable_build_error)?;
    let build_config = qemu_build_config_for_job(cfg, &desired_build);

    let mut outputs = Vec::new();
    for vm in &bundle_input.scenario.vms {
        log_files.extend(direct_build_log_files(
            &build_config,
            &bundle_input.scenario.name,
            &vm.name,
        ));

        let image = bundle_input
            .scenario
            .image_by_name(&vm.image)
            .ok_or_else(|| anyhow::anyhow!("image '{}' not found in scenario", vm.image))?;
        let base_image = bundle_input
            .base_catalog
            .base_image_by_name(&image.base)
            .ok_or_else(|| anyhow::anyhow!("base image '{}' not found in bundle", image.base))?;

        if build_config.layered.use_cache {
            {
                let db = db::BuilderDb::open(&cfg.builder.state_db)?;
                db.update_build_job_phase(
                    &job.build_id,
                    "building_base",
                    Some(&vm.name),
                    job.attempt,
                    None,
                    now_unix_ms(),
                )?;
            }
            emit_build_report(cfg, report_tx, &job.build_id).await?;
            let base_for_prepare = base_image.clone();
            let build_config_for_prepare = build_config.clone();
            tokio::task::spawn_blocking(move || {
                ensure_base_rootfs(&base_for_prepare, &build_config_for_prepare)
            })
            .await
            .context("base rootfs worker panicked")??;
            ensure_build_still_desired(cfg, &job.build_id)?;
        }

        {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            db.update_build_job_phase(
                &job.build_id,
                "building",
                Some(&vm.name),
                job.attempt,
                None,
                now_unix_ms(),
            )?;
        }
        emit_build_report(cfg, report_tx, &job.build_id).await?;
        let request = DirectBuildRequest {
            scenario: bundle_input.scenario.clone(),
            lecture: bundle_input.lecture.clone(),
            vm_name: vm.name.clone(),
            config: build_config.clone(),
            base_image: base_image.clone(),
        };
        let raw_result = tokio::task::spawn_blocking(move || {
            let raw_build = run_direct_build_to_raw(&request)?;
            let scan = scan_raw_image_chunks(&raw_build.rendered.paths.root_disk_path)?;
            Ok::<_, anyhow::Error>((raw_build, scan))
        })
        .await
        .context("direct QEMU build worker panicked")?;
        let (raw_build, scan) = match raw_result {
            Ok(output) => output,
            Err(error) => return Err(error),
        };
        ensure_build_still_desired(cfg, &job.build_id)?;

        let lookups = scan
            .chunks
            .iter()
            .map(|chunk| ImageChunkLookup {
                raw_sha256: chunk.raw_sha256.clone(),
                raw_size_bytes: chunk.raw_size_bytes,
            })
            .collect::<Vec<_>>();
        let reused = reused_chunks_or_empty(
            lookup_reused_chunks(cfg, lookups).await,
            &job.build_id,
            &vm.name,
        );
        ensure_build_still_desired(cfg, &job.build_id)?;

        let output_result = tokio::task::spawn_blocking(move || {
            finish_direct_build_from_scan(raw_build, &scan, &reused)
        })
        .await
        .context("image chunk compression worker panicked")?;
        let output = match output_result {
            Ok(output) => output,
            Err(error) => return Err(error),
        };
        ensure_build_still_desired(cfg, &job.build_id)?;
        info!(
            build_id = %job.build_id,
            scenario = %output.rendered.scenario_name,
            vm = %output.rendered.vm.name,
            artifact = %output.artifact.chunk_manifest_path.display(),
            image_id = %output.artifact.image_id,
            "builder daemon built VM image"
        );
        outputs.push(output);
    }

    let completed_outputs_json = serde_json::to_string(
        &outputs
            .iter()
            .map(PersistedBuildOutput::from_direct_output)
            .collect::<Vec<_>>(),
    )
    .context("failed to serialize completed builder outputs")?;
    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.save_completed_build_outputs(&job.build_id, &completed_outputs_json, now_unix_ms())?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    wait_for_publication_claim(cfg, &job.build_id).await?;
    Ok(())
}

async fn lookup_reused_chunks(
    cfg: &config::BuilderConfig,
    lookups: Vec<ImageChunkLookup>,
) -> Result<BTreeMap<String, ReusedEncodedImageChunk>> {
    let lookup_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before image chunk lookup")?;
    let lookup_cfg = cfg.clone();
    tokio::task::spawn_blocking(move || {
        let uploader = image_uploader(&lookup_cfg, &lookup_token)?;
        let reused = uploader
            .find_existing_image_chunks(&lookups)?
            .into_iter()
            .map(|(raw_sha256, chunk)| {
                (
                    raw_sha256,
                    ReusedEncodedImageChunk {
                        raw_sha256: chunk.raw_sha256,
                        raw_size_bytes: chunk.raw_size_bytes,
                        encoded_sha256: chunk.encoded_sha256,
                        encoded_size_bytes: chunk.encoded_size_bytes,
                    },
                )
            })
            .collect::<BTreeMap<_, _>>();
        Ok::<_, anyhow::Error>(reused)
    })
    .await
    .context("image chunk lookup worker panicked")?
}

fn reused_chunks_or_empty(
    lookup: Result<BTreeMap<String, ReusedEncodedImageChunk>>,
    build_id: &str,
    vm_name: &str,
) -> BTreeMap<String, ReusedEncodedImageChunk> {
    match lookup {
        Ok(reused) => reused,
        Err(error) => {
            warn!(
                build_id,
                vm = vm_name,
                error = %error,
                "image chunk reuse lookup failed; encoding all chunks locally"
            );
            BTreeMap::new()
        }
    }
}

impl PersistedBuildOutput {
    fn from_direct_output(output: &DirectBuildOutput) -> Self {
        Self {
            manifest: output.artifact.manifest.clone(),
            vm_name: output.rendered.vm.name.clone(),
            image_id: output.artifact.image_id.clone(),
            chunk_manifest_sha256: output.artifact.chunk_manifest_sha256.clone(),
            chunk_manifest_path: output.artifact.chunk_manifest_path.clone(),
            chunks: output
                .artifact
                .chunks
                .iter()
                .map(|chunk| PersistedEncodedImageChunk {
                    descriptor: chunk.descriptor.clone(),
                    source_path: chunk.path.clone(),
                })
                .collect(),
            kernel_sha256_hex: output.artifact.kernel_sha256_hex.clone(),
            kernel_path: output.rendered.base_rootfs.paths.kernel_path.clone(),
            initrd_sha256_hex: output.artifact.initrd_sha256_hex.clone(),
            initrd_path: output.rendered.base_rootfs.paths.initrd_path.clone(),
        }
    }

    fn validate_local_files(&self) -> Result<()> {
        if self.manifest.schema_version != 4 || self.manifest.vms.len() != 1 {
            bail!("completed builder output has an invalid scenario manifest");
        }
        let vm = &self.manifest.vms[0];
        if vm.name != self.vm_name
            || vm.image_format != intar_contracts::catalog::ImageFormat::RawChunksV1
            || vm.image_id != self.image_id
            || vm.chunk_manifest_sha256 != self.chunk_manifest_sha256
            || vm.boot.kernel_sha256 != self.kernel_sha256_hex
            || vm.boot.initrd_sha256 != self.initrd_sha256_hex
        {
            bail!("completed builder output does not match its scenario manifest");
        }
        validate_output_file(&self.kernel_path, &self.kernel_sha256_hex, None, "kernel")?;
        validate_output_file(&self.initrd_path, &self.initrd_sha256_hex, None, "initrd")?;

        let chunk_manifest_bytes = std::fs::read(&self.chunk_manifest_path).with_context(|| {
            format!(
                "failed to read completed chunk manifest '{}'",
                self.chunk_manifest_path.display()
            )
        })?;
        if intar_image_build::sha256_bytes_hex(&chunk_manifest_bytes) != self.chunk_manifest_sha256
        {
            bail!("completed chunk manifest digest does not match its output metadata");
        }
        let chunk_manifest: intar_contracts::catalog::ImageChunkManifestV1 =
            serde_json::from_slice(&chunk_manifest_bytes)
                .context("completed chunk manifest is not valid JSON")?;
        chunk_manifest
            .validate()
            .context("completed chunk manifest is invalid")?;
        if chunk_manifest.image_id != self.image_id
            || chunk_manifest.chunks
                != self
                    .chunks
                    .iter()
                    .map(|chunk| chunk.descriptor.clone())
                    .collect::<Vec<_>>()
        {
            bail!("completed chunk manifest does not match its output metadata");
        }

        let mut encoded_chunks = BTreeMap::new();
        for chunk in &self.chunks {
            if let Some(path) = &chunk.source_path {
                let expected = (
                    chunk.descriptor.encoded_sha256.clone(),
                    chunk.descriptor.encoded_size_bytes,
                );
                if let Some(previous) = encoded_chunks.insert(path.clone(), expected.clone())
                    && previous != expected
                {
                    bail!("completed builder chunk path has conflicting metadata");
                }
            }
        }
        for (path, (sha256, size_bytes)) in encoded_chunks {
            validate_output_file(&path, &sha256, Some(size_bytes), "encoded image chunk")?;
        }
        Ok(())
    }
}

fn validate_output_file(
    path: &Path,
    expected_sha256: &str,
    expected_size_bytes: Option<u64>,
    kind: &str,
) -> Result<()> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("failed to stat {kind} '{}'", path.display()))?;
    if !metadata.is_file() {
        bail!(
            "completed {kind} '{}' is not a regular file",
            path.display()
        );
    }
    if let Some(expected_size_bytes) = expected_size_bytes
        && metadata.len() != expected_size_bytes
    {
        bail!(
            "completed {kind} '{}' has size {}, expected {expected_size_bytes}",
            path.display(),
            metadata.len()
        );
    }
    let actual_sha256 = intar_image_build::sha256_file_hex(path)
        .with_context(|| format!("failed to hash completed {kind} '{}'", path.display()))?;
    if actual_sha256 != expected_sha256 {
        bail!(
            "completed {kind} '{}' has an unexpected digest",
            path.display()
        );
    }
    Ok(())
}

async fn wait_for_publication_claim(cfg: &config::BuilderConfig, build_id: &str) -> Result<()> {
    loop {
        let row = {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            db.load_build_job(build_id)?
        };
        match row {
            Some(row)
                if row.phase != "building"
                    || row.completed_outputs_json.is_none()
                    || row.publish_state != "waiting" =>
            {
                return Ok(());
            }
            Some(_) => tokio::time::sleep(PUBLICATION_POLL_INTERVAL).await,
            None => {
                cleanup_reported_build_attempt_artifacts(cfg, build_id).await;
                return Ok(());
            }
        }
    }
}

async fn process_next_publication(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<bool> {
    let Some(job) = ({
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.claim_next_publication_build(now_unix_ms())?
    }) else {
        return Ok(false);
    };
    emit_build_report(cfg, report_tx, &job.build_id).await?;

    let outputs = match completed_outputs_from_job(&job) {
        Ok(outputs) => outputs,
        Err(error) => {
            requeue_damaged_completed_output(cfg, &job, report_tx, &error).await?;
            return Ok(true);
        }
    };
    let validation_outputs = outputs.clone();
    let validation = tokio::task::spawn_blocking(move || {
        validation_outputs
            .iter()
            .try_for_each(PersistedBuildOutput::validate_local_files)
    })
    .await
    .context("completed output validator panicked")?;
    if let Err(error) = validation {
        requeue_damaged_completed_output(cfg, &job, report_tx, &error).await?;
        return Ok(true);
    }
    let result = publish_claimed_build_outputs(cfg, &job, &outputs, report_tx).await;
    if let Err(error) = result {
        let error_message = format!("{error:#}");
        let now = now_unix_ms();
        let terminal = {
            let db = db::BuilderDb::open(&cfg.builder.state_db)?;
            if should_retry_build_error(&error, job.publish_attempt, cfg.jobs.max_attempts) {
                let next_attempt_at_ms = now.saturating_add(retry_delay_ms(job.publish_attempt));
                db.schedule_publication_retry(
                    &job.build_id,
                    &error_message,
                    next_attempt_at_ms,
                    now,
                )?;
                warn!(
                    build_id = %job.build_id,
                    publish_attempt = job.publish_attempt,
                    next_attempt_at_ms,
                    "scheduled builder publication retry"
                );
                false
            } else {
                db.update_build_job_phase(
                    &job.build_id,
                    "failed",
                    None,
                    job.attempt,
                    Some(&error_message),
                    now,
                )?;
                db.clear_completed_build_outputs(&job.build_id)?;
                true
            }
        };
        if terminal {
            cleanup_reported_build_attempt_artifacts(cfg, &job.build_id).await;
        }
        emit_build_report(cfg, report_tx, &job.build_id).await?;
        return Ok(true);
    }

    Ok(true)
}

async fn publish_claimed_build_outputs(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    outputs: &[PersistedBuildOutput],
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
) -> Result<()> {
    ensure_build_still_desired(cfg, &job.build_id)?;

    let publish_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before publishing image build")?;
    let publish_cfg = cfg.clone();
    let publish_outputs = outputs.to_vec();
    let publish_build = job.desired_build();
    tokio::task::spawn_blocking(move || {
        publish_persisted_build_outputs(
            &publish_cfg,
            &publish_token,
            &publish_outputs,
            &publish_build,
        )
    })
    .await
    .context("publish worker panicked")??;

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "uploading_logs",
            None,
            job.attempt,
            None,
            now_unix_ms(),
        )?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    let log_files = persisted_build_log_files(cfg, job, outputs);
    let success_warning = match bridge::bootstrap_builder_access_token(&cfg.bridge).await {
        Ok(log_token) => {
            if let Err(error) = upload_build_log(cfg, &log_token, &job.build_id, &log_files).await {
                warn!(
                    build_id = %job.build_id,
                    error = %error,
                    "image build published but build log upload failed"
                );
                Some(log_upload_warning(&error))
            } else {
                None
            }
        }
        Err(error) => {
            warn!(
                build_id = %job.build_id,
                error = %error,
                "image build published but build log authentication failed"
            );
            Some(log_upload_warning(&error))
        }
    };

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "succeeded",
            None,
            job.attempt,
            success_warning.as_deref(),
            now_unix_ms(),
        )?;
        db.clear_completed_build_outputs(&job.build_id)?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    cleanup_reported_build_attempt_artifacts(cfg, &job.build_id).await;
    Ok(())
}

async fn requeue_damaged_completed_output(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    error: &anyhow::Error,
) -> Result<()> {
    let error_message = format!("completed output is unusable and will be rebuilt: {error:#}");
    let now = now_unix_ms();
    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        // The VM already completed. A damaged retained output is a cache miss,
        // not another failed provisioning attempt.
        db.schedule_build_job_retry(&job.build_id, 0, &error_message, now, now)?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    cleanup_reported_build_attempt_artifacts(cfg, &job.build_id).await;
    Ok(())
}

fn completed_outputs_from_job(job: &db::BuildJobRow) -> Result<Vec<PersistedBuildOutput>> {
    let json = job
        .completed_outputs_json
        .as_deref()
        .context("publication job has no completed output metadata")?;
    let outputs = serde_json::from_str::<Vec<PersistedBuildOutput>>(json)
        .context("completed output metadata is invalid")?;
    if outputs.is_empty() {
        bail!("completed output metadata contains no VM images");
    }
    Ok(outputs)
}

fn persisted_build_log_files(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    outputs: &[PersistedBuildOutput],
) -> Vec<BuildLogFile> {
    let build_config = qemu_build_config_for_job(cfg, &job.desired_build());
    outputs
        .iter()
        .flat_map(|output| direct_build_log_files(&build_config, &job.scenario_id, &output.vm_name))
        .collect()
}

pub(super) async fn emit_build_report(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    build_id: &str,
) -> Result<()> {
    let report = {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.load_build_job(build_id)?
            .map(|row| bridge::build_report_from_job(&cfg.bridge.host_id, row))
    };
    if let Some(report) = report
        && report_tx.send(report).await.is_err()
    {
        warn!(
            build_id,
            "builder report queue closed; persisted state will replay after restart"
        );
    }
    Ok(())
}

pub(super) fn publish_build_outputs(
    cfg: &config::BuilderConfig,
    access_token: &str,
    outputs: &[DirectBuildOutput],
    build: &intar_contracts::bridge::DesiredBuildV1,
) -> Result<()> {
    let persisted = outputs
        .iter()
        .map(PersistedBuildOutput::from_direct_output)
        .collect::<Vec<_>>();
    publish_persisted_build_outputs(cfg, access_token, &persisted, build)
}

fn publish_persisted_build_outputs(
    cfg: &config::BuilderConfig,
    access_token: &str,
    outputs: &[PersistedBuildOutput],
    build: &intar_contracts::bridge::DesiredBuildV1,
) -> Result<()> {
    let manifest = combine_scenario_manifests(outputs.iter().map(|output| &output.manifest))?;
    let images = outputs
        .iter()
        .map(|output| {
            let chunks = output
                .chunks
                .iter()
                .map(|chunk| {
                    PublishImageChunkFile::from_optional_path(
                        &chunk.descriptor,
                        chunk.source_path.as_deref(),
                    )
                })
                .collect::<intar_image_upload::Result<Vec<_>>>()?;
            PublishChunkedImage::new(
                &output.vm_name,
                &output.image_id,
                &output.chunk_manifest_sha256,
                &output.chunk_manifest_path,
                chunks,
            )
            .map_err(anyhow::Error::from)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut artifact_paths = BTreeMap::new();
    for output in outputs {
        artifact_paths.insert(output.kernel_sha256_hex.clone(), output.kernel_path.clone());
        artifact_paths.insert(output.initrd_sha256_hex.clone(), output.initrd_path.clone());
    }
    let artifacts = artifact_paths
        .into_iter()
        .map(|(sha256, path)| PublishArtifactFile::new(path, sha256).map_err(anyhow::Error::from))
        .collect::<Result<Vec<_>>>()?;
    let uploader = image_uploader(cfg, access_token)?;
    let identity = PublishBuildIdentity::new(
        &build.build_id,
        &build.rev,
        &build.content_hash,
        build.arch.clone(),
    )
    .map_err(anyhow::Error::from)?;
    let receipt = uploader
        .publish_build_manifest_with_artifacts(&manifest, &images, &artifacts, &identity)
        .map_err(classify_publish_error)?;
    info!(
        scenario = %receipt.scenario_id,
        images = receipt.images.len(),
        artifacts = receipt.artifacts.len(),
        "builder daemon published persisted image build"
    );
    Ok(())
}

pub(super) fn image_uploader(
    cfg: &config::BuilderConfig,
    access_token: &str,
) -> Result<ImageUploader> {
    let publish_url = format!(
        "{}/registry/v1/publish",
        cfg.bridge.base_url.trim_end_matches('/')
    );
    ImageUploader::new(ImageUploadConfig::new(publish_url, access_token))
        .map_err(anyhow::Error::from)
}

pub(super) fn classify_publish_error(error: ImageUploadError) -> anyhow::Error {
    if matches!(
        error,
        ImageUploadError::HttpStatus {
            status: reqwest::StatusCode::CONFLICT | reqwest::StatusCode::GONE,
            ..
        }
    ) {
        return non_retryable_build_error(anyhow::Error::from(error));
    }
    anyhow::Error::from(error)
}

pub(super) fn ensure_build_still_desired(
    cfg: &config::BuilderConfig,
    build_id: &str,
) -> Result<()> {
    let db = db::BuilderDb::open(&cfg.builder.state_db)?;
    if db.load_build_job(build_id)?.is_some() {
        return Ok(());
    }
    Err(non_retryable_build_error(anyhow::anyhow!(
        "build '{build_id}' was removed from desired state"
    )))
}

pub(super) async fn upload_build_log(
    cfg: &config::BuilderConfig,
    access_token: &str,
    build_id: &str,
    log_files: &[BuildLogFile],
) -> Result<()> {
    let mut log = String::new();
    for log_file in log_files {
        append_build_log_file(&mut log, &log_file.title, &log_file.path).await;
    }
    if log.is_empty() {
        log.push_str("builder completed without build log output\n");
    }

    let url = format!(
        "{}/agent/builds/{}/log",
        cfg.bridge.base_url.trim_end_matches('/'),
        build_id
    );
    let response = reqwest::Client::new()
        .put(&url)
        .bearer_auth(access_token.trim())
        .header("content-type", "text/plain; charset=utf-8")
        .body(log)
        .send()
        .await
        .with_context(|| format!("failed to upload build log to {url}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        bail!("build log upload failed with HTTP {status}: {body}");
    }
    Ok(())
}

pub(super) async fn upload_build_logs_best_effort(
    cfg: &config::BuilderConfig,
    access_token: &str,
    build_id: &str,
    log_files: &[BuildLogFile],
    reason: &str,
) {
    if log_files.is_empty() {
        return;
    }
    if let Err(error) = upload_build_log(cfg, access_token, build_id, log_files).await {
        warn!(
            build_id,
            reason,
            error = %error,
            "failed to upload build logs after builder job error"
        );
    }
}

pub(super) async fn upload_build_logs_with_fresh_token_best_effort(
    cfg: &config::BuilderConfig,
    build_id: &str,
    log_files: &[BuildLogFile],
    reason: &str,
) {
    if log_files.is_empty() {
        return;
    }
    match bridge::bootstrap_builder_access_token(&cfg.bridge).await {
        Ok(access_token) => {
            upload_build_logs_best_effort(cfg, &access_token, build_id, log_files, reason).await;
        }
        Err(error) => {
            warn!(
                build_id,
                reason,
                error = %error,
                "failed to authenticate before uploading builder job logs"
            );
        }
    }
}

pub(super) fn direct_build_log_files(
    config: &intar_image_build::QemuBuildConfig,
    scenario_name: &str,
    vm_name: &str,
) -> Vec<BuildLogFile> {
    let work_root = config
        .work_root
        .join("qemu")
        .join(scenario_name)
        .join(vm_name);
    vec![
        BuildLogFile {
            title: format!("{scenario_name}:{vm_name} build log"),
            path: work_root.join("build.log"),
        },
        BuildLogFile {
            title: format!("{scenario_name}:{vm_name} serial log"),
            path: work_root.join("serial.log"),
        },
    ]
}

pub(super) async fn append_build_log_file(log: &mut String, title: &str, path: &Path) {
    log.push_str(&format!("== {title} ==\n"));
    match tokio::fs::read_to_string(path).await {
        Ok(content) => log.push_str(&content),
        Err(error) => {
            log.push_str(&format!(
                "failed to read build log '{}': {error}\n",
                path.display()
            ));
        }
    }
    log.push('\n');
}

pub(super) fn retry_delay_ms(attempt: u32) -> i64 {
    if attempt <= 1 {
        FIRST_RETRY_DELAY_MS
    } else {
        LATER_RETRY_DELAY_MS
    }
}

pub(super) fn log_upload_warning(error: &anyhow::Error) -> String {
    format!("image published, but build log upload failed: {error:#}")
}

pub(super) async fn upload_run_once_logs_after_failure(
    cfg: &config::BuilderConfig,
    build_id: &str,
    log_files: &[BuildLogFile],
) {
    match optional_builder_access_token(cfg).await {
        Ok(Some(access_token)) => {
            upload_build_logs_best_effort(
                cfg,
                &access_token,
                build_id,
                log_files,
                "run-once build failure",
            )
            .await;
        }
        Ok(None) => {}
        Err(error) => {
            warn!(
                build_id,
                error = %error,
                "failed to authenticate for run-once failure log upload"
            );
        }
    }
}

pub(super) async fn optional_builder_access_token(
    cfg: &config::BuilderConfig,
) -> Result<Option<String>> {
    if !cfg.bridge.enabled {
        return Ok(None);
    }

    let has_bridge_credentials = !cfg.bridge.base_url.trim().is_empty()
        || !cfg.bridge.host_id.trim().is_empty()
        || !cfg.bridge.bootstrap_token.trim().is_empty();
    if !has_bridge_credentials {
        return Ok(None);
    }

    validate_bridge_config(cfg)?;
    bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .map(Some)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::collections::BTreeMap;
    use std::path::Path;

    use intar_contracts::catalog::{
        GUEST_BOOTSTRAP_ABI_V1, IMAGE_CHUNK_ENCODING, IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION,
        IMAGE_CHUNK_SIZE_BYTES, ImageArchitecture, ImageChunkManifestV1, ImageChunkV1, ImageFormat,
        ImageKey, Mib, ScenarioDifficulty, ScenarioManifestV4, ScenarioVmBootManifestV4,
        ScenarioVmManifestV4,
    };

    use super::{PersistedBuildOutput, PersistedEncodedImageChunk, reused_chunks_or_empty};

    #[test]
    fn reuse_lookup_failure_encodes_every_chunk_locally() {
        assert!(
            reused_chunks_or_empty(
                Err(anyhow::anyhow!("temporary registry failure")),
                "build-1",
                "web",
            )
            .is_empty()
        );

        let mut expected = BTreeMap::new();
        expected.insert(
            "a".repeat(64),
            intar_image_build::ReusedEncodedImageChunk {
                raw_sha256: "a".repeat(64),
                raw_size_bytes: 1,
                encoded_sha256: "b".repeat(64),
                encoded_size_bytes: 1,
            },
        );
        assert_eq!(
            reused_chunks_or_empty(Ok(expected.clone()), "build-1", "web"),
            expected
        );
    }

    #[test]
    fn rejects_changed_boot_chunk_and_chunk_manifest_files() {
        let temp = tempfile::tempdir().unwrap();
        let output = persisted_output_fixture(temp.path());
        output.validate_local_files().unwrap();

        std::fs::write(&output.kernel_path, b"changed kernel").unwrap();
        assert!(format!("{:#}", output.validate_local_files().unwrap_err()).contains("kernel"));

        let output = persisted_output_fixture(temp.path());
        std::fs::write(&output.initrd_path, b"changed initrd").unwrap();
        assert!(format!("{:#}", output.validate_local_files().unwrap_err()).contains("initrd"));

        let output = persisted_output_fixture(temp.path());
        let chunk_path = output.chunks[0].source_path.as_ref().unwrap();
        std::fs::write(chunk_path, b"changed chunk").unwrap();
        assert!(format!("{:#}", output.validate_local_files().unwrap_err()).contains("chunk"));

        let output = persisted_output_fixture(temp.path());
        std::fs::write(&output.chunk_manifest_path, b"{}").unwrap();
        assert!(format!("{:#}", output.validate_local_files().unwrap_err()).contains("manifest"));
    }

    fn persisted_output_fixture(root: &Path) -> PersistedBuildOutput {
        let kernel_path = root.join("web.kernel");
        let initrd_path = root.join("web.initrd");
        let chunk_path = root.join("web-0.raw.zst");
        let chunk_manifest_path = root.join("web.chunks.json");
        std::fs::write(&kernel_path, b"kernel").unwrap();
        std::fs::write(&initrd_path, b"initrd").unwrap();
        std::fs::write(&chunk_path, b"chunk").unwrap();

        let descriptor = ImageChunkV1 {
            index: 0,
            raw_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
            raw_sha256: "a".repeat(64),
            encoded_size_bytes: 5,
            encoded_sha256: intar_image_build::sha256_file_hex(&chunk_path).unwrap(),
        };
        let mut chunk_manifest = ImageChunkManifestV1 {
            schema_version: IMAGE_CHUNK_MANIFEST_SCHEMA_VERSION,
            image_id: String::new(),
            virtual_size_bytes: u64::from(IMAGE_CHUNK_SIZE_BYTES),
            chunk_size_bytes: IMAGE_CHUNK_SIZE_BYTES,
            encoding: IMAGE_CHUNK_ENCODING.to_string(),
            chunks: vec![descriptor.clone()],
        };
        chunk_manifest.image_id = chunk_manifest.compute_image_id().unwrap();
        let chunk_manifest_bytes = serde_json::to_vec(&chunk_manifest).unwrap();
        std::fs::write(&chunk_manifest_path, &chunk_manifest_bytes).unwrap();

        let kernel_sha256_hex = intar_image_build::sha256_file_hex(&kernel_path).unwrap();
        let initrd_sha256_hex = intar_image_build::sha256_file_hex(&initrd_path).unwrap();
        let chunk_manifest_sha256 = intar_image_build::sha256_bytes_hex(&chunk_manifest_bytes);
        let vm_name = "web".to_string();
        PersistedBuildOutput {
            manifest: ScenarioManifestV4 {
                schema_version: 4,
                scenario_id: "broken-nginx".to_string(),
                name: "broken-nginx".to_string(),
                title: "Broken Nginx".to_string(),
                category: "web".to_string(),
                description: "Fix nginx".to_string(),
                difficulty: ScenarioDifficulty::Easy,
                estimated_minutes: 15,
                tags: vec!["nginx".to_string()],
                briefing_markdown: "Restore nginx".to_string(),
                solution_markdown: "Start nginx".to_string(),
                hints: Vec::new(),
                vms: vec![ScenarioVmManifestV4 {
                    name: vm_name.clone(),
                    image_key: ImageKey {
                        scenario: "broken-nginx".to_string(),
                        vm: vm_name.clone(),
                        arch: ImageArchitecture::X86_64,
                    },
                    image_id: chunk_manifest.image_id.clone(),
                    image_format: ImageFormat::RawChunksV1,
                    image_virtual_size_bytes: u64::from(IMAGE_CHUNK_SIZE_BYTES),
                    chunk_manifest_sha256: chunk_manifest_sha256.clone(),
                    guest_bootstrap_abi: GUEST_BOOTSTRAP_ABI_V1,
                    boot: ScenarioVmBootManifestV4 {
                        kernel_sha256: kernel_sha256_hex.clone(),
                        initrd_sha256: initrd_sha256_hex.clone(),
                        cmdline: "console=ttyS0".to_string(),
                    },
                    cpu_millis: 1_000,
                    vcpu_count: 1,
                    memory_mib: Mib(512),
                    disk_mib: Mib(2048),
                    probes: Vec::new(),
                }],
            },
            vm_name,
            image_id: chunk_manifest.image_id,
            chunk_manifest_sha256,
            chunk_manifest_path,
            chunks: vec![PersistedEncodedImageChunk {
                descriptor,
                source_path: Some(chunk_path),
            }],
            kernel_sha256_hex,
            kernel_path,
            initrd_sha256_hex,
            initrd_path,
        }
    }
}
