use super::*;

pub(super) async fn evict_cache_if_needed(
    cache: &ImageCacheConfig,
    db: &Db,
    cache_root: &Path,
) -> Result<()> {
    let Some(max_bytes) = cache.max_bytes else {
        return Ok(());
    };
    let protected = protected_cache_entries(db).await;
    let eviction_root = cache_root.to_path_buf();
    let protected_images_for_eviction = protected.image_ids.clone();
    let protected_tools_for_eviction = protected.tools_disk_shas.clone();
    let remaining = tokio::task::spawn_blocking(move || {
        evict_chunk_cache_files(
            &eviction_root,
            &protected_images_for_eviction,
            &protected_tools_for_eviction,
            max_bytes,
        )
    })
    .await
    .context("chunk cache eviction worker panicked")??;
    if remaining > max_bytes {
        warn!(
            cache_root = %cache_root.display(),
            max_bytes,
            remaining_bytes = remaining,
            protected_count = protected.image_ids.len() + protected.tools_disk_shas.len(),
            "chunk cache remains over budget because live or recent files are protected"
        );
    }
    Ok(())
}

const CHUNK_CACHE_EVICTION_GRACE: Duration = Duration::from_secs(60 * 60);

fn evict_chunk_cache_files(
    cache_root: &Path,
    protected_image_ids: &HashSet<String>,
    protected_tools_disk_shas: &HashSet<String>,
    max_bytes: u64,
) -> Result<u64> {
    let mut protected_paths = protected_tools_disk_shas
        .iter()
        .map(|sha256| cache_root.join("tools").join(format!("{sha256}.ext4")))
        .collect::<HashSet<_>>();
    let mut descriptors = Vec::new();
    collect_cache_files(&cache_root.join("launch-v3"), &mut descriptors)?;
    for (descriptor_path, _) in descriptors {
        if descriptor_path.extension().and_then(|value| value.to_str()) == Some("json") {
            let Ok(bytes) = std::fs::read(&descriptor_path) else {
                continue;
            };
            let Ok(descriptor) = serde_json::from_slice::<ChunkedLaunchDescriptorV1>(&bytes) else {
                continue;
            };
            if !protected_image_ids.contains(&descriptor.image_id) {
                continue;
            }
            protected_paths.insert(descriptor_path);
            protected_paths.insert(descriptor.chunk_manifest_path.clone());
            protected_paths.insert(descriptor.kernel_path.clone());
            protected_paths.insert(descriptor.initrd_path.clone());
            if let Ok(manifest) = serde_json::from_slice::<ImageChunkManifestV1>(
                &std::fs::read(&descriptor.chunk_manifest_path).unwrap_or_default(),
            ) {
                for chunk in manifest.chunks {
                    protected_paths.insert(
                        descriptor
                            .chunk_cache_root
                            .join(format!("{}.raw.zst", chunk.raw_sha256)),
                    );
                }
            }
        }
    }

    let mut files = Vec::new();
    collect_cache_files(cache_root, &mut files)?;
    let mut total = files.iter().fold(0_u64, |sum, (_, metadata)| {
        sum.saturating_add(file_allocated_bytes(metadata))
    });
    files.sort_by_key(|(_, metadata)| metadata.modified().unwrap_or(UNIX_EPOCH));
    for (path, metadata) in files {
        if total <= max_bytes {
            break;
        }
        if protected_paths.contains(&path)
            || file_within_grace(&metadata, CHUNK_CACHE_EVICTION_GRACE)
        {
            continue;
        }
        let bytes = file_allocated_bytes(&metadata);
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(bytes);
        }
    }
    Ok(total)
}

fn collect_cache_files(
    directory: &Path,
    files: &mut Vec<(PathBuf, std::fs::Metadata)>,
) -> Result<()> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            collect_cache_files(&entry.path(), files)?;
        } else if metadata.is_file() {
            files.push((entry.path(), metadata));
        }
    }
    Ok(())
}

fn file_within_grace(metadata: &std::fs::Metadata, grace: Duration) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_none_or(|age| age < grace)
}

#[derive(Default)]
struct ProtectedCacheEntries {
    image_ids: HashSet<String>,
    tools_disk_shas: HashSet<String>,
}

async fn protected_cache_entries(db: &Db) -> ProtectedCacheEntries {
    let mut protected = ProtectedCacheEntries::default();
    match db.load_local_vm_image_shas().await {
        Ok(shas) => {
            protected.image_ids.extend(shas);
        }
        Err(error) => {
            warn!(error = %error, "failed to load local vm image refs for cache protection");
        }
    }
    match db.load_local_vm_guest_tools_jsons().await {
        Ok(pins) => protect_local_vm_guest_tools(&mut protected, pins),
        Err(error) => {
            warn!(error = %error, "failed to load local vm guest-tools refs for cache protection");
        }
    }

    let desired_row = match db.load_desired_state().await {
        Ok(Some(row)) => row,
        Ok(None) => return protected,
        Err(error) => {
            warn!(error = %error, "failed to load desired state for cache protection");
            return protected;
        }
    };
    let desired = match serde_json::from_str::<intar_contracts::bridge::HostDesiredStateV2>(
        &desired_row.doc_json,
    ) {
        Ok(desired) => desired,
        Err(error) => {
            warn!(error = %error, "failed to parse desired state for cache protection");
            return protected;
        }
    };

    protect_desired_cache_entries(&mut protected, &desired);
    protected
}

fn protect_desired_cache_entries(
    protected: &mut ProtectedCacheEntries,
    desired: &intar_contracts::bridge::HostDesiredStateV2,
) {
    for image in &desired.cached_images {
        protected.image_ids.insert(image.image_id.clone());
    }
    for tools in &desired.cached_guest_tools {
        protect_tools_disk_sha256(protected, &tools.tools_disk_sha256);
    }
    for vm in &desired.vms {
        if vm.desired_phase == intar_contracts::bridge::DesiredVmPhase::Running {
            protected.image_ids.insert(vm.image_id.clone());
            protect_tools_disk_sha256(protected, &vm.guest_tools.tools_disk_sha256);
        }
    }
}

fn protect_local_vm_guest_tools(
    protected: &mut ProtectedCacheEntries,
    guest_tools_jsons: Vec<String>,
) {
    for guest_tools_json in guest_tools_jsons {
        match serde_json::from_str::<intar_contracts::bridge::DesiredGuestToolsV1>(
            &guest_tools_json,
        ) {
            Ok(pin) => protect_tools_disk_sha256(protected, &pin.tools_disk_sha256),
            Err(error) => {
                warn!(error = %error, "failed to parse local vm guest-tools pin for cache protection")
            }
        }
    }
}

fn protect_tools_disk_sha256(protected: &mut ProtectedCacheEntries, sha256: &str) {
    if let Some(sha256) = normalize_sha256(sha256) {
        protected.tools_disk_shas.insert(sha256);
    }
}

pub(super) fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

/// Bytes a cache file actually occupies on disk. Raw images are written
/// sparsely, so their logical length vastly overstates disk usage; budgeting
/// on it would evict far below the operator's real `max_bytes`.
pub(super) fn file_allocated_bytes(metadata: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        metadata.blocks().saturating_mul(512)
    }
    #[cfg(not(unix))]
    {
        metadata.len()
    }
}

pub(super) async fn ensure_cached_artifact(
    sha256: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    let expected_sha256 = normalize_sha256(sha256)
        .ok_or_else(|| anyhow::anyhow!("invalid artifact sha256 {sha256:?}"))?;
    let artifact_dir = cache_root.join("artifacts");
    tokio::fs::create_dir_all(&artifact_dir)
        .await
        .with_context(|| {
            format!(
                "failed to create artifact cache dir {}",
                artifact_dir.display()
            )
        })?;
    let artifact_path = artifact_dir.join(&expected_sha256);
    let artifact_lock = cache_entry_lock(cache_root, format!("artifact:{expected_sha256}")).await;
    let _artifact_guard = artifact_lock.lock().await;

    if tokio::fs::metadata(&artifact_path).await.is_ok() {
        match sha256_file(&artifact_path).await {
            Ok(have) if have == expected_sha256 => {
                info!(path = %artifact_path.display(), "artifact cache hit");
                return Ok(artifact_path);
            }
            Ok(have) => {
                warn!(
                    path = %artifact_path.display(),
                    expected_sha256 = %expected_sha256,
                    actual_sha256 = %have,
                    "cached artifact sha256 mismatch; refreshing"
                );
            }
            Err(error) => {
                warn!(path = %artifact_path.display(), "failed to hash cached artifact: {error}");
            }
        }
    }

    let (tmp_path, mut tmp_file) = create_tmp_file(&artifact_dir, &expected_sha256).await?;
    let artifact_url = format!("/agent/registry/artifacts/{expected_sha256}");
    let download = download_to_file(client, registry, bridge, &artifact_url, &mut tmp_file).await;
    drop(tmp_file);

    let download = match download {
        Ok(download) => download,
        Err(error) => {
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(error).with_context(|| format!("failed to download artifact {sha256}"));
        }
    };

    if download.sha256 != expected_sha256 {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        anyhow::bail!(
            "downloaded artifact sha256 mismatch: expected {}, got {}",
            expected_sha256,
            download.sha256
        );
    }

    if tokio::fs::metadata(&artifact_path).await.is_ok() {
        let _ = tokio::fs::remove_file(&artifact_path).await;
    }
    tokio::fs::rename(&tmp_path, &artifact_path)
        .await
        .with_context(|| {
            format!(
                "failed to move cached artifact into place at {}",
                artifact_path.display()
            )
        })?;
    Ok(artifact_path)
}

#[cfg(test)]
mod tests {
    use std::fs::{File, FileTimes};

    use intar_contracts::{
        bridge::{
            DesiredGuestToolsV1, DesiredVmPhase, DesiredVmV2, HostDesiredStateV2, VmResourcesV2,
        },
        catalog::{ImageArchitecture, ImageKey, Mib},
    };

    use super::*;

    #[test]
    fn eviction_keeps_old_tools_for_cached_and_running_desired_state() -> Result<()> {
        let cached_sha256 = "a".repeat(64);
        let running_sha256 = "b".repeat(64);
        let absent_sha256 = "c".repeat(64);
        let desired = HostDesiredStateV2 {
            schema_version: 4,
            host_id: "host-1".to_owned(),
            version: 1,
            generated_at_unix_ms: 0,
            cached_images: Vec::new(),
            cached_guest_tools: vec![guest_tools(&cached_sha256)],
            vms: vec![
                desired_vm(DesiredVmPhase::Running, &running_sha256),
                desired_vm(DesiredVmPhase::Absent, &absent_sha256),
            ],
            builds: Vec::new(),
        };
        let mut protected = ProtectedCacheEntries::default();
        protect_desired_cache_entries(&mut protected, &desired);

        let cache = tempfile::tempdir()?;
        let tools = cache.path().join("tools");
        std::fs::create_dir_all(&tools)?;
        let cached_path = tools.join(format!("{cached_sha256}.ext4"));
        let running_path = tools.join(format!("{running_sha256}.ext4"));
        let absent_path = tools.join(format!("{absent_sha256}.ext4"));
        for path in [&cached_path, &running_path, &absent_path] {
            write_old_file(path)?;
        }

        let remaining = evict_chunk_cache_files(
            cache.path(),
            &protected.image_ids,
            &protected.tools_disk_shas,
            1,
        )?;

        assert!(cached_path.exists());
        assert!(running_path.exists());
        assert!(!absent_path.exists());
        assert!(remaining > 1);
        Ok(())
    }

    #[test]
    fn eviction_keeps_old_tools_for_local_vm_pin() -> Result<()> {
        let sha256 = "d".repeat(64);
        let mut protected = ProtectedCacheEntries::default();
        protect_local_vm_guest_tools(
            &mut protected,
            vec![serde_json::to_string(&guest_tools(&sha256))?],
        );

        let cache = tempfile::tempdir()?;
        let path = cache.path().join("tools").join(format!("{sha256}.ext4"));
        std::fs::create_dir_all(path.parent().expect("tools parent"))?;
        write_old_file(&path)?;

        let remaining = evict_chunk_cache_files(
            cache.path(),
            &protected.image_ids,
            &protected.tools_disk_shas,
            1,
        )?;

        assert!(path.exists());
        assert!(remaining > 1);
        Ok(())
    }

    fn guest_tools(tools_disk_sha256: &str) -> DesiredGuestToolsV1 {
        DesiredGuestToolsV1 {
            tools_disk_sha256: tools_disk_sha256.to_owned(),
            tools_disk_size_bytes: 64 * 1024 * 1024,
            kino_sha256: "d".repeat(64),
            bootstrap_abi: 1,
        }
    }

    fn desired_vm(phase: DesiredVmPhase, tools_disk_sha256: &str) -> DesiredVmV2 {
        DesiredVmV2 {
            run_id: "run-1".to_owned(),
            vm_name: "vm-1".to_owned(),
            desired_phase: phase,
            image_key: ImageKey {
                scenario: "scenario".to_owned(),
                vm: "vm".to_owned(),
                arch: ImageArchitecture::X86_64,
            },
            image_id: "e".repeat(64),
            guest_tools: guest_tools(tools_disk_sha256),
            resources: VmResourcesV2 {
                cpu_millis: 1,
                vcpu_count: 1,
                memory_mib: Mib(1),
                disk_mib: Mib(1),
            },
            ssh_authorized_keys_openssh: vec!["ssh-ed25519 test".to_owned()],
            lease_expires_at_unix_ms: 0,
        }
    }

    fn write_old_file(path: &Path) -> Result<()> {
        std::fs::write(path, [0_u8; 4096])?;
        let old = SystemTime::now()
            .checked_sub(CHUNK_CACHE_EVICTION_GRACE + Duration::from_secs(1))
            .expect("system clock supports old fixture");
        File::open(path)?.set_times(FileTimes::new().set_modified(old))?;
        Ok(())
    }
}
