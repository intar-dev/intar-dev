use super::*;

pub(super) async fn builder_worker_loop(
    cfg: config::BuilderConfig,
    report_tx: mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    mut desired_revision: watch::Receiver<u64>,
    cpu_gate: Arc<Semaphore>,
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

    let mut repair_scan = interval(Duration::from_secs(15 * 60));
    repair_scan.set_missed_tick_behavior(MissedTickBehavior::Delay);
    repair_scan.tick().await;
    loop {
        loop {
            match process_next_queued_build(&cfg, &report_tx, &cpu_gate).await {
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
            _ = repair_scan.tick() => {}
        }
    }
}

pub(super) async fn process_next_queued_build(
    cfg: &config::BuilderConfig,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    cpu_gate: &Arc<Semaphore>,
) -> Result<bool> {
    let Some(job) = ({
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.claim_next_queued_build(now_unix_ms())?
    }) else {
        return Ok(false);
    };
    emit_build_report(cfg, report_tx, &job.build_id).await?;

    let result = run_claimed_build_job(cfg, &job, report_tx, cpu_gate).await;
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

pub(super) async fn run_claimed_build_job(
    cfg: &config::BuilderConfig,
    job: &db::BuildJobRow,
    report_tx: &mpsc::Sender<intar_contracts::bridge::BuildReportV1>,
    cpu_gate: &Arc<Semaphore>,
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
    if bundle_root.exists() {
        fs::remove_dir_all(&bundle_root)
            .with_context(|| format!("failed to remove '{}'", bundle_root.display()))?;
    }
    unpack_bundle_archive(&bundle_archive, &bundle_root)?;
    if let Err(error) =
        verify_bundle_or_drop_cached_archive(&bundle_archive, &bundle_root, &desired_build).await
    {
        return Err(non_retryable_build_error(error));
    }
    let bundle_input = inspect_bundle_build_input(
        &bundle_root,
        &desired_build.scenario_id,
        desired_build.arch.clone(),
        &desired_build.rev,
    )?;
    let build_config = qemu_build_config_for_job(cfg, &desired_build);

    let mut outputs = Vec::new();
    let mut log_files = Vec::new();
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
            scenario_path: bundle_input.scenario_path.clone(),
            scenario: bundle_input.scenario.clone(),
            lecture: bundle_input.lecture.clone(),
            vm_name: vm.name.clone(),
            config: build_config.clone(),
            base_image: base_image.clone(),
        };
        let cpu_permit = Arc::clone(cpu_gate)
            .acquire_many_owned(4)
            .await
            .context("builder CPU gate closed")?;
        let raw_result = tokio::task::spawn_blocking(move || {
            let rendered = run_direct_build_to_raw(&request)?;
            let scan = scan_raw_image_chunks(&rendered.paths.root_disk_path)?;
            Ok::<_, anyhow::Error>((rendered, scan))
        })
        .await
        .context("direct QEMU build worker panicked")?;
        drop(cpu_permit);
        let (rendered, scan) = match raw_result {
            Ok(output) => output,
            Err(error) => {
                upload_build_logs_with_fresh_token_best_effort(
                    cfg,
                    &job.build_id,
                    &log_files,
                    "direct QEMU build failure",
                )
                .await;
                return Err(error);
            }
        };
        ensure_build_still_desired(cfg, &job.build_id)?;

        let lookup_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
            .await
            .context("failed to authenticate before image chunk lookup")?;
        let lookup_cfg = cfg.clone();
        let lookups = scan
            .chunks
            .iter()
            .map(|chunk| ImageChunkLookup {
                raw_sha256: chunk.raw_sha256.clone(),
                raw_size_bytes: chunk.raw_size_bytes,
            })
            .collect::<Vec<_>>();
        let reused = tokio::task::spawn_blocking(move || {
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
        .context("image chunk lookup worker panicked")??;
        ensure_build_still_desired(cfg, &job.build_id)?;

        let cpu_permit = Arc::clone(cpu_gate)
            .acquire_many_owned(4)
            .await
            .context("builder CPU gate closed")?;
        let output_result = tokio::task::spawn_blocking(move || {
            finish_direct_build_from_scan(rendered, &scan, &reused)
        })
        .await
        .context("image chunk compression worker panicked")?;
        drop(cpu_permit);
        let output = match output_result {
            Ok(output) => output,
            Err(error) => {
                upload_build_logs_with_fresh_token_best_effort(
                    cfg,
                    &job.build_id,
                    &log_files,
                    "image chunk compression failure",
                )
                .await;
                return Err(error);
            }
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

    {
        let db = db::BuilderDb::open(&cfg.builder.state_db)?;
        db.update_build_job_phase(
            &job.build_id,
            "publishing",
            None,
            job.attempt,
            None,
            now_unix_ms(),
        )?;
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    ensure_build_still_desired(cfg, &job.build_id)?;
    let publish_token = bridge::bootstrap_builder_access_token(&cfg.bridge)
        .await
        .context("failed to authenticate before publishing image build")?;
    let publish_cfg = cfg.clone();
    let publish_outputs = outputs.clone();
    let publish_build = desired_build.clone();
    let publish_result = tokio::task::spawn_blocking(move || {
        publish_build_outputs(
            &publish_cfg,
            &publish_token,
            &publish_outputs,
            &publish_build,
        )
    })
    .await
    .context("publish worker panicked")?;
    if let Err(error) = publish_result {
        upload_build_logs_with_fresh_token_best_effort(
            cfg,
            &job.build_id,
            &log_files,
            "publish failure",
        )
        .await;
        return Err(error);
    }

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
    }
    emit_build_report(cfg, report_tx, &job.build_id).await?;
    Ok(())
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
    if let Some(report) = report {
        report_tx
            .send(report)
            .await
            .context("failed to queue builder build report")?;
    }
    Ok(())
}

pub(super) fn publish_build_outputs(
    cfg: &config::BuilderConfig,
    access_token: &str,
    outputs: &[DirectBuildOutput],
    build: &intar_contracts::bridge::DesiredBuildV1,
) -> Result<()> {
    let manifest =
        combine_scenario_manifests(outputs.iter().map(|output| &output.artifact.manifest))?;
    let images = outputs
        .iter()
        .map(|output| {
            let vm = output
                .artifact
                .manifest
                .vms
                .first()
                .ok_or_else(|| anyhow::anyhow!("direct build manifest has no vm"))?;
            let chunks = output
                .artifact
                .chunks
                .iter()
                .map(|chunk| {
                    PublishImageChunkFile::from_optional_path(
                        &chunk.descriptor,
                        chunk.path.as_deref(),
                    )
                })
                .collect::<intar_image_upload::Result<Vec<_>>>()?;
            PublishChunkedImage::new(
                &vm.name,
                &vm.image_id,
                &vm.chunk_manifest_sha256,
                &output.artifact.chunk_manifest_path,
                chunks,
            )
            .map_err(anyhow::Error::from)
        })
        .collect::<Result<Vec<_>>>()?;
    let artifacts = publish_artifacts_from_outputs(outputs)?;
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
        "builder daemon published image build"
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

pub(super) fn publish_artifacts_from_outputs(
    outputs: &[DirectBuildOutput],
) -> Result<Vec<PublishArtifactFile>> {
    let mut artifacts = BTreeMap::new();
    for output in outputs {
        artifacts.insert(
            output.artifact.kernel_sha256_hex.clone(),
            output.rendered.base_rootfs.paths.kernel_path.clone(),
        );
        artifacts.insert(
            output.artifact.initrd_sha256_hex.clone(),
            output.rendered.base_rootfs.paths.initrd_path.clone(),
        );
    }
    artifacts
        .into_iter()
        .map(|(sha256, path)| PublishArtifactFile::new(path, sha256).map_err(anyhow::Error::from))
        .collect()
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
