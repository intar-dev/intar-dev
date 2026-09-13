use super::*;

use std::collections::BTreeMap;

use intar_contracts::bridge::HostDesiredStateV2;

use crate::db::CacheVerifyRow;

/// What starts one cache pass.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CacheRefreshScope {
    /// The 15-minute timer. The pass verifies retained content that is older
    /// than the ok age, oldest content first, and repairs what it finds bad.
    Scrub,
    /// A desired-state change or a launch that needs a missing descriptor.
    /// The pass only prepares the pinned entries that are not ready.
    MissingOnly,
}

#[derive(Clone, Copy)]
pub(super) struct CacheRefreshContext<'a> {
    pub registry: &'a ImageRegistryConfig,
    pub bridge: Option<&'a BridgeConfig>,
    pub cache: &'a ImageCacheConfig,
    pub db: Option<&'a Db>,
    pub cache_root: &'a Path,
    pub client: &'a reqwest::Client,
    pub vm: &'a crate::vm::VmManager,
}

/// The desired state to serve, and the pins it requires.
struct RetainedPins {
    desired: HostDesiredStateV2,
    pins: RequiredPins,
}

pub(super) async fn run_cache_refresh_cycle(
    context: CacheRefreshContext<'_>,
    scope: CacheRefreshScope,
) {
    let Some(retained) = load_retained_pins(context).await else {
        return;
    };
    if retained.pins.is_empty() {
        // No fallback to the full registry. The registry keeps the full
        // authorization inventory; the cache downloads only pinned entries.
        info!(
            registry = %redact_url_userinfo(&context.registry.url),
            "image cache has no required pins; waiting for a desired-state intent"
        );
        return;
    }

    let advertised =
        match list_registry_images(context.registry, context.bridge, context.client).await {
            Ok(images) => images,
            Err(error) => {
                error!(
                    registry = %redact_url_userinfo(&context.registry.url),
                    "failed to list image registry: {error}"
                );
                return;
            }
        };
    let retained_images = scheduler::retained_registry_images(&advertised, &retained.pins);
    if retained_images.is_empty() {
        warn!(
            pinned_images = retained.pins.images.len(),
            advertised_images = advertised.len(),
            "the registry advertises none of the pinned images"
        );
    }
    info!(
        cache_root = %context.cache_root.display(),
        pinned_images = retained.pins.images.len(),
        pinned_guest_tools = retained.pins.guest_tools.len(),
        retained_images = retained_images.len(),
        advertised_images = advertised.len(),
        ?scope,
        "running image cache pass"
    );

    // A pinned guest tools disk must exist before a VM can boot, and the
    // control plane can move the pin to a disk this host has never seen. This
    // runs in both scopes, so a fresh host reaches a bootable tools disk
    // without waiting for a scrub pass.
    warm_required_guest_tools(
        &retained.pins,
        context.registry,
        context.bridge,
        context.cache_root,
        context.client,
    )
    .await;
    prepare_missing_pinned_entries(&retained, &retained_images, context).await;

    if scope == CacheRefreshScope::Scrub
        && let Err(error) = scrub_retained_content(context, &retained).await
    {
        warn!(error = %error, "image cache scrub pass failed");
    }

    if let Some(db) = context.db
        && let Err(error) = evict_cache_if_needed(context.cache, db, context.cache_root).await
    {
        warn!(error = %error, cache_root = %context.cache_root.display(), "image cache eviction failed");
    }
}

async fn load_retained_pins(context: CacheRefreshContext<'_>) -> Option<RetainedPins> {
    let Some(db) = context.db else {
        warn!("image cache has no desired-state source; waiting for a pin set");
        return None;
    };
    let row = match db.load_desired_state().await {
        Ok(Some(row)) => row,
        Ok(None) => {
            warn!("image cache has no desired state yet; waiting for a pin set");
            return None;
        }
        Err(error) => {
            warn!(error = %error, "failed to load desired state for the image cache");
            return None;
        }
    };
    let desired = match serde_json::from_str::<HostDesiredStateV2>(&row.doc_json) {
        Ok(desired) => desired,
        Err(error) => {
            warn!(error = %error, "cached desired state is invalid JSON");
            return None;
        }
    };
    let pins = RequiredPins::from_desired_state(&desired);
    Some(RetainedPins { desired, pins })
}

/// Ensure every pinned guest tools disk is present and verified.
///
/// The launch path also calls this, so a boot never waits for a pass. This call
/// is what makes a fresh host ready: it downloads the compressed disk, decodes
/// it, and verifies the published digest before any VM uses it.
pub(super) async fn warm_required_guest_tools(
    pins: &RequiredPins,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) {
    for (sha256, size_bytes, _, _) in &pins.guest_tools {
        wait_for_vm_boot_idle().await;
        if let Err(error) = ensure_cached_tools_disk(
            sha256,
            *size_bytes,
            registry,
            bridge,
            cache_root,
            client,
            ToolsDiskVerification::ReuseVerified,
        )
        .await
        {
            warn!(error = %error, tools_disk_sha256 = %sha256, "failed to warm guest tools disk");
        }
    }
}

/// How long the pass waits before it retries work that jailerd requeued.
const REQUEUE_RETRY_DELAY: Duration = Duration::from_secs(5);

/// How many requeue rounds one pass makes before it leaves the rest to the
/// next pass. The pinned intent stays in the desired state, so nothing is
/// lost, and the bound keeps one pass from running forever behind boots.
const REQUEUE_ROUNDS_PER_PASS: usize = 12;

/// Prepare the pinned images that are not ready, one image at a time.
///
/// The pass holds the single image prepare job for the whole process, parks
/// between two images while a boot is live, and sends each import to jailerd's
/// background lane. A learner launch never waits for this pass.
///
/// A requeue is not a failure. Jailerd parks a background import at a block
/// boundary when a boot needs the CPU, and the pass retries the same image
/// after a short delay until the pinned entries are ready or the round budget
/// is used up.
async fn prepare_missing_pinned_entries(
    retained: &RetainedPins,
    retained_images: &[RegistryImageRecord],
    context: CacheRefreshContext<'_>,
) {
    let _ = retained;
    let _prepare = match budget::acquire_prepare_job().await {
        Ok(permit) => permit,
        Err(error) => {
            warn!(error = %error, "image prepare budget is unavailable");
            return;
        }
    };
    let mut rounds = 0usize;
    loop {
        rounds = rounds.saturating_add(1);
        let missing = scheduler::missing_registry_images(retained_images.to_vec(), |image| {
            verified_cached_image_metadata(
                context.cache_root,
                &image.image_key,
                &image.image_id,
                true,
            )
            .is_some()
        });
        if missing.is_empty() {
            return;
        }
        let mut requeued = Vec::new();
        for image in missing {
            wait_for_vm_boot_idle().await;
            let span = tracing::info_span!(
                "image_cache_prepare",
                image = %image.image_key,
                registry = %redact_url_userinfo(&context.registry.url),
            );
            match prepare_one_image(&image, context).instrument(span).await {
                Ok(()) => info!(image = %image.image_key, "image boot bundle cache ready"),
                Err(error) if is_requeued(&error) => {
                    debug!(image = %image.image_key, "jailerd requeued the background import");
                    requeued.push(image);
                }
                Err(error) => {
                    error!(error = %error, image = %image.image_key, "failed to cache image")
                }
            }
        }
        if requeued.is_empty() || rounds >= REQUEUE_ROUNDS_PER_PASS {
            if !requeued.is_empty() {
                info!(
                    requeued = requeued.len(),
                    rounds, "leaving requeued background imports for the next pass"
                );
            }
            return;
        }
        // A boot is holding the lane. Keep the pin queued for the next round.
        tokio::time::sleep(REQUEUE_RETRY_DELAY).await;
    }
}

/// Whether a prepare error is a jailerd requeue rather than a failure.
fn is_requeued(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<crate::vm::ImagePrepareRequeued>()
        .is_some()
}

async fn prepare_one_image(
    image: &RegistryImageRecord,
    context: CacheRefreshContext<'_>,
) -> Result<()> {
    let cached_image = ensure_cached_chunked_image_entry(
        image,
        context.registry,
        context.bridge,
        context.cache_root,
        context.client,
    )
    .await?;
    // The import runs in jailerd's background lane: it cannot hold the learner
    // launch lane, and it yields between its own fixed-size blocks.
    context
        .vm
        .ensure_cached_image_template_background(&cached_image)
        .await
        .context("failed to prepare the root-owned jail image template")?;
    if let Some(db) = context.db
        && let Err(error) = touch_cached_image(db, &cached_image).await
    {
        warn!(error = %error, image = %image.image_key, "failed to update image cache access metadata");
    }
    Ok(())
}

/// Verify retained cache content with the bounded background hash reader.
///
/// The pass takes batches of due work until none is left, so a large cache is
/// covered in one pass and the elapsed time is bounded by the reader budget.
/// It parks between two items while a boot is live, and only a completed stable
/// read writes a verification record.
async fn scrub_retained_content(
    context: CacheRefreshContext<'_>,
    retained: &RetainedPins,
) -> Result<()> {
    let db = context
        .db
        .context("scrub pass requires the agent database")?;
    let items = scrub_items(context.cache_root, retained).await;
    if items.is_empty() {
        return Ok(());
    }
    let mut attempted: HashSet<String> = HashSet::new();
    loop {
        let verified = verified_content_map(db).await?;
        let now_ms = now_unix_ms();
        let batch = scheduler::plan_scrub_batch(
            &items,
            &verified,
            &attempted,
            now_ms,
            scheduler::SCRUB_ITEMS_PER_BATCH,
        );
        if batch.items.is_empty() {
            break;
        }
        if batch.overdue > 0 {
            warn!(
                overdue = batch.overdue,
                fresh = batch.fresh,
                "cached image content is older than the verification alert age"
            );
        }
        info!(
            batch = batch.items.len(),
            fresh = batch.fresh,
            deferred = batch.deferred,
            "image cache scrub batch"
        );
        for item in &batch.items {
            // Park between two items, so a boot is never held up by the pass.
            wait_for_vm_boot_idle().await;
            attempted.insert(item.dedup_key.clone());
            match verify_scrub_item(db, item).await {
                Ok(true) => {}
                Ok(false) => {
                    // The bytes do not match their identity, the file is gone,
                    // or a writer changed it during the read. Repair the owner
                    // of the file and leave the record alone: a failed or
                    // interrupted read never marks content verified.
                    warn!(path = %item.path.display(), "cached content failed verification; repairing");
                    if let Err(error) = repair_scrub_item(context, item).await {
                        warn!(path = %item.path.display(), error = %error, "repair failed");
                    }
                }
                Err(error) => {
                    warn!(path = %item.path.display(), error = %error, "scrub read failed")
                }
            }
        }
    }
    Ok(())
}

/// Verify one cache file and write its completed verification on success.
async fn verify_scrub_item(db: &Db, item: &scheduler::ScrubItem) -> Result<bool> {
    let hashed = hash_file_bounded(&item.path).await?;
    if hashed.digest_hex() != item.expected_sha256 {
        return Ok(false);
    }
    if !hashed.stable() {
        // A writer changed the file during the read. This read covers no
        // stable identity, so it cannot mark the content verified.
        return Ok(false);
    }
    db.upsert_verified_content(CacheVerifyRow {
        content_sha256: item.expected_sha256.clone(),
        verified_at_ms: now_unix_ms(),
        bytes_read: i64::try_from(hashed.bytes_read).unwrap_or(i64::MAX),
    })
    .await?;
    Ok(true)
}

/// Rebuild the owner of a failed cache file.
async fn repair_scrub_item(
    context: CacheRefreshContext<'_>,
    item: &scheduler::ScrubItem,
) -> Result<()> {
    match &item.target {
        // A tools disk has its own repair path. It downloads the compressed
        // disk, decodes it, and verifies the digest, and it never runs through
        // the image path.
        scheduler::ScrubTarget::GuestTools {
            tools_disk_sha256,
            tools_disk_size_bytes,
        } => {
            let _prepare = budget::acquire_prepare_job().await?;
            repair_cached_tools_disk(
                tools_disk_sha256,
                *tools_disk_size_bytes,
                &item.expected_sha256,
                context.registry,
                context.bridge,
                context.cache_root,
                context.client,
            )
            .await?;
            Ok(())
        }
        scheduler::ScrubTarget::Image {
            image_key,
            image_id,
        } => {
            let advertised =
                list_registry_images(context.registry, context.bridge, context.client).await?;
            anyhow::ensure!(
                normalize_sha256(image_id).as_deref() == Some(item.expected_sha256.as_str()),
                "image repair digest mismatch"
            );
            let Some(record) = advertised
                .into_iter()
                .find(|record| record.image_key == *image_key && record.image_id == *image_id)
            else {
                return Ok(());
            };
            let _prepare = budget::acquire_prepare_job().await?;
            // `ensure_cached_chunked_image_entry` re-verifies every cached
            // object against its digest and downloads only what is missing or
            // corrupt, so the bad chunk is replaced and the good ones are kept.
            let cached = ensure_cached_chunked_image_entry(
                &record,
                context.registry,
                context.bridge,
                context.cache_root,
                context.client,
            )
            .await?;
            context
                .vm
                .ensure_cached_image_template_background(&cached)
                .await?;
            Ok(())
        }
    }
}

async fn verified_content_map(db: &Db) -> Result<BTreeMap<String, i64>> {
    let mut map = BTreeMap::new();
    for row in db.load_verified_content().await? {
        map.insert(row.content_sha256, row.verified_at_ms);
    }
    Ok(map)
}

/// Rebuild a guest tools disk that failed verification.
///
/// The digest of the item and the digest of the pin must agree before any
/// download starts, so a bad pin can never overwrite a good disk. The rebuild
/// reads the whole decoded disk and verifies the published digest, which is why
/// this path uses `Full` and not the launch path's reuse hint.
pub(super) async fn repair_cached_tools_disk(
    tools_disk_sha256: &str,
    tools_disk_size_bytes: u64,
    expected_sha256: &str,
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache_root: &Path,
    client: &reqwest::Client,
) -> Result<PathBuf> {
    anyhow::ensure!(
        normalize_sha256(tools_disk_sha256).as_deref() == Some(expected_sha256),
        "tools disk repair digest mismatch"
    );
    ensure_cached_tools_disk(
        tools_disk_sha256,
        tools_disk_size_bytes,
        registry,
        bridge,
        cache_root,
        client,
        ToolsDiskVerification::Full,
    )
    .await
}

/// Every cache file that backs a retained pin.
async fn scrub_items(cache_root: &Path, retained: &RetainedPins) -> Vec<scheduler::ScrubItem> {
    let mut items = Vec::new();
    // The pins are the source, not the desired cache list: a running VM can pin
    // an image that the desired cache does not list.
    for pinned in retained.pins.image_pins() {
        match scrub_items_for_image(cache_root, &pinned.image_key, &pinned.image_id).await {
            Ok(mut found) => items.append(&mut found),
            Err(error) => {
                warn!(error = %error, image = %pinned.image_key, "failed to enumerate scrub items");
            }
        }
    }
    for (sha256, size_bytes, _, _) in &retained.pins.guest_tools {
        if let Some(item) = tools_scrub_item(cache_root, sha256, *size_bytes) {
            items.push(item);
        }
    }
    let _ = &retained.desired;
    items
}

/// The cache files that back one pinned image: its chunk manifest, every
/// compressed chunk, and its boot artifacts.
async fn scrub_items_for_image(
    cache_root: &Path,
    image_key: &str,
    image_id: &str,
) -> Result<Vec<scheduler::ScrubItem>> {
    let ready = match require_ready_image_launch(cache_root, image_key, Some(image_id)).await {
        Ok(ready) => ready,
        Err(_) => return Ok(Vec::new()),
    };
    let image = ready.image;
    let target = scheduler::ScrubTarget::Image {
        image_key: image.image_key.clone(),
        image_id: image.image_id.clone(),
    };
    let mut items = vec![scheduler::ScrubItem {
        dedup_key: relative_cache_key(cache_root, &image.chunk_manifest_path),
        path: image.chunk_manifest_path.clone(),
        expected_sha256: image.chunk_manifest_sha256.clone(),
        target: target.clone(),
    }];
    let manifest_bytes = tokio::fs::read(&image.chunk_manifest_path).await?;
    let manifest: ImageChunkManifestV1 = serde_json::from_slice(&manifest_bytes)
        .context("decode cached image chunk manifest for scrub")?;
    manifest.validate()?;
    for chunk in &manifest.chunks {
        let path = image
            .chunk_cache_root
            .join(format!("{}.raw.zst", chunk.raw_sha256));
        items.push(scheduler::ScrubItem {
            dedup_key: relative_cache_key(cache_root, &path),
            path,
            expected_sha256: chunk.encoded_sha256.clone(),
            target: target.clone(),
        });
    }
    for (path, sha256) in [
        (&image.kernel_path, &image.kernel_sha256),
        (&image.initrd_path, &image.initrd_sha256),
    ] {
        items.push(scheduler::ScrubItem {
            dedup_key: relative_cache_key(cache_root, path),
            path: path.clone(),
            expected_sha256: sha256.clone(),
            target: target.clone(),
        });
    }
    Ok(items)
}

pub(super) fn tools_scrub_item(
    cache_root: &Path,
    tools_disk_sha256: &str,
    tools_disk_size_bytes: u64,
) -> Option<scheduler::ScrubItem> {
    if tools_disk_size_bytes != 64 * 1024 * 1024 {
        return None;
    }
    let sha256 = normalize_sha256(tools_disk_sha256)?;
    let path = cache_root.join("tools").join(format!("{sha256}.ext4"));
    Some(scheduler::ScrubItem {
        dedup_key: relative_cache_key(cache_root, &path),
        path,
        expected_sha256: sha256.clone(),
        target: scheduler::ScrubTarget::GuestTools {
            tools_disk_sha256: sha256,
            tools_disk_size_bytes,
        },
    })
}

fn relative_cache_key(cache_root: &Path, path: &Path) -> String {
    path.strip_prefix(cache_root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}
