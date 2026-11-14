use super::*;

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
    pub bridge: &'a BridgeConfig,
    pub cache: &'a ImageCacheConfig,
    pub db: &'a Db,
    pub cache_root: &'a Path,
    pub vm: &'a crate::vm::VmManager,
}

impl CacheRefreshContext<'_> {
    fn store(&self) -> BlobStore {
        BlobStore::new(self.cache_root)
    }
}

pub(super) async fn run_cache_refresh_cycle(
    context: CacheRefreshContext<'_>,
    scope: CacheRefreshScope,
) {
    let Some(desired) = crate::bridge::load_cached_desired_state(context.bridge, context.db).await
    else {
        info!("image cache has no desired state; waiting for one");
        return;
    };
    let pins = RequiredPins::from_desired_state(&desired);
    if pins.is_empty() {
        info!("image cache has no required pins; waiting for a desired-state intent");
    } else {
        info!(
            cache_root = %context.cache_root.display(),
            pinned_images = pins.images.len(),
            pinned_kino = pins.kino.len(),
            ?scope,
            "running image cache pass"
        );
        // A VM cannot boot without its Kino. This runs in both scopes, so a
        // fresh host reaches a bootable Kino without waiting for a scrub.
        warm_required_kino(&pins, context).await;
        prepare_missing_pinned_entries(&pins, context).await;
        if scope == CacheRefreshScope::Scrub
            && let Err(error) = scrub_retained_content(context, &pins).await
        {
            warn!(error = %error, "image cache scrub pass failed");
        }
    }
    if let Err(error) = evict_cache_if_needed(context.cache, context.db, context.cache_root).await {
        warn!(error = %error, cache_root = %context.cache_root.display(), "image cache eviction failed");
    }
}

async fn warm_required_kino(pins: &RequiredPins, context: CacheRefreshContext<'_>) {
    let store = context.store();
    for kino in &pins.kino {
        wait_for_vm_boot_idle().await;
        if let Err(error) = context.vm.oci_registry().pull_kino(kino, &store).await {
            warn!(error = %error, kino = kino.as_str(), "failed to warm a pinned Kino");
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
/// background lane. A launch whose image is not ready wakes this pass and
/// waits for it outside its boot window, so the pass can proceed.
///
/// A requeue is not a failure. Jailerd parks a background import at a block
/// boundary when a boot needs the CPU, and the pass retries the same image
/// after a short delay until the pinned entries are ready or the round budget
/// is used up.
async fn prepare_missing_pinned_entries(pins: &RequiredPins, context: CacheRefreshContext<'_>) {
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
        let missing = pins
            .images
            .iter()
            .filter(|image| {
                ready::needs_prepare(context.cache_root, image, context.vm.wake_config())
            })
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return;
        }
        let mut requeued = Vec::new();
        for image in missing {
            wait_for_vm_boot_idle().await;
            let span = tracing::info_span!("image_cache_prepare", image = image.as_str());
            match prepare_one_image(image, context).instrument(span).await {
                Ok(()) => info!(image = image.as_str(), "image template ready"),
                Err(error) if is_requeued(&error) => {
                    debug!(
                        image = image.as_str(),
                        "jailerd requeued the background import"
                    );
                    requeued.push(image);
                }
                Err(error) => {
                    error!(error = %format!("{error:#}"), image = image.as_str(), "failed to cache image");
                    record_image_failure(image, &error);
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

/// Pull one pinned image into the blob store, refuse a config this agent's
/// Kino contract cannot boot, and have jailerd build its template in the
/// background lane.
///
/// When this host wants the image's suspended guest, its layers are pulled
/// too and jailerd prepares it. If that fails the image is prepared without
/// it, so cold boots still work, and why is kept.
async fn prepare_one_image(image: &OciDigest, context: CacheRefreshContext<'_>) -> Result<()> {
    let store = context.store();
    let registry = context.vm.oci_registry();
    let pulled = registry.pull_machine(image, &store).await?;
    check_machine_config(&pulled.config)?;
    let warm = ready::wants_wake(context.vm.wake_config(), &pulled.config).then_some(async {
        registry.pull_wake_layers(&pulled, &store).await?;
        context
            .vm
            .ensure_cached_image_template_background(&pulled, true)
            .await
            .map(drop)
    });
    let cold = async {
        context
            .vm
            .ensure_cached_image_template_background(&pulled, false)
            .await
            .map(drop)
            .context("failed to prepare the root-owned jail image template")
    };
    prepare_warm_or_cold(image, warm, cold).await
}

/// Prepare an image with its suspended guest when `warm` is given. Any
/// failure of that but a requeue is kept and the image is prepared cold.
pub(super) async fn prepare_warm_or_cold(
    image: &OciDigest,
    warm: Option<impl Future<Output = Result<()>>>,
    cold: impl Future<Output = Result<()>>,
) -> Result<()> {
    if let Some(warm) = warm {
        match warm.await {
            Ok(()) => return Ok(()),
            Err(error) if is_requeued(&error) => return Err(error),
            Err(error) => {
                warn!(
                    error = %format!("{error:#}"),
                    image = image.as_str(),
                    "the image's suspended guest could not be prepared; preparing it for cold boots"
                );
                ready::record_wake_prepare_failure(image, &error);
            }
        }
    }
    cold.await
}

/// Verify retained cache content with the bounded background hash reader.
///
/// The pass takes batches of due work until none is left, so a large cache is
/// covered in one pass and the elapsed time is bounded by the reader budget.
/// It parks between two items while a boot is live, and only a completed stable
/// read writes a verification record.
async fn scrub_retained_content(
    context: CacheRefreshContext<'_>,
    pins: &RequiredPins,
) -> Result<()> {
    let db = context.db;
    let items = scrub_items(&context.store(), pins);
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

/// Re-pull the owner of a blob that failed verification. The bad blob goes
/// first: the store keeps a file of the right size, so a corrupt one would
/// otherwise be kept.
async fn repair_scrub_item(
    context: CacheRefreshContext<'_>,
    item: &scheduler::ScrubItem,
) -> Result<()> {
    match tokio::fs::remove_file(&item.path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("remove a corrupt blob"),
    }
    let _prepare = budget::acquire_prepare_job().await?;
    let store = context.store();
    match &item.target {
        scheduler::ScrubTarget::Kino(kino) => {
            context.vm.oci_registry().pull_kino(kino, &store).await?;
        }
        scheduler::ScrubTarget::Image(image) => prepare_one_image(image, context).await?,
    }
    Ok(())
}

async fn verified_content_map(db: &Db) -> Result<BTreeMap<String, i64>> {
    let mut map = BTreeMap::new();
    for row in db.load_verified_content().await? {
        map.insert(row.content_sha256, row.verified_at_ms);
    }
    Ok(map)
}

/// Every blob that backs a pin: the manifest and everything it names. A
/// blob's expected SHA-256 is its name.
fn scrub_items(store: &BlobStore, pins: &RequiredPins) -> Vec<scheduler::ScrubItem> {
    let owners = pins
        .images
        .iter()
        .map(|image| (image, scheduler::ScrubTarget::Image(image.clone())))
        .chain(
            pins.kino
                .iter()
                .map(|kino| (kino, scheduler::ScrubTarget::Kino(kino.clone()))),
        );
    let mut items = Vec::new();
    for (manifest, target) in owners {
        if !store.path(manifest).is_file() {
            // Not pulled yet: the prepare path owns it.
            continue;
        }
        for blob in
            std::iter::once(manifest.clone()).chain(ready::manifest_references(store, manifest))
        {
            items.push(scheduler::ScrubItem {
                dedup_key: blob.hex().to_owned(),
                path: store.path(&blob),
                expected_sha256: blob.hex().to_owned(),
                target: target.clone(),
            });
        }
    }
    items
}
