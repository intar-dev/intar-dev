use super::*;

use futures_util::StreamExt as _;

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
    let _running = wait::PassRunning::start();
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

/// Prepare the pinned images that are not ready, one image at a time, the
/// ones a launch waits on first.
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
        let mut missing = pins
            .images
            .iter()
            .filter(|image| !ready::is_image_ready(context.cache_root, image))
            .collect::<Vec<_>>();
        if missing.is_empty() {
            return;
        }
        let mut requeued = Vec::new();
        // An image a launch waits on goes next, even when the launch began
        // after this round did; a transfer under way is never cut short.
        while !missing.is_empty() {
            let image = missing.remove(wait::next_pending(&missing, wait::is_awaited));
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

/// How often jailerd confirms the template of every ready pinned image. A
/// confirmation marks the template used, so store GC, which takes only
/// templates idle longer than its grace, keeps every pinned one. It is fixed,
/// whatever the refresh interval, and well below the least grace jailerd
/// accepts.
pub(super) const TEMPLATE_CONFIRM_INTERVAL: Duration = Duration::from_secs(5 * 60);
const _: () = assert!(
    TEMPLATE_CONFIRM_INTERVAL.as_secs() * 3 <= intar_jailer_protocol::MIN_STORE_GC_GRACE_SECONDS
);

/// How many confirmations are in flight at once.
const TEMPLATE_CONFIRMS_IN_FLIGHT: usize = 4;

/// The longest one confirmation may take, its wait for boots to settle
/// included. Jailerd answers from the template's metadata and never builds.
const TEMPLATE_CONFIRM_TIMEOUT: Duration = Duration::from_secs(20);

/// The longest a sweep runs; what it did not reach, the next one does.
pub(super) const TEMPLATE_CONFIRM_SWEEP_BUDGET: Duration = Duration::from_secs(2 * 60);
const _: () =
    assert!(TEMPLATE_CONFIRM_SWEEP_BUDGET.as_secs() * 2 <= TEMPLATE_CONFIRM_INTERVAL.as_secs());

/// Have jailerd confirm the template of every pinned image that is ready.
///
/// This runs on its own cadence beside the cache pass, so a long import never
/// holds it back, and it never builds: jailerd answers from the template's
/// metadata, and a template it does not hold withdraws the image's readiness
/// and wakes the cache pass, which prepares it with its own permit, pacing,
/// and requeues. True when jailerd answered, or there was nothing to confirm.
pub(super) async fn confirm_ready_templates(context: CacheRefreshContext<'_>) -> bool {
    let Some(desired) = crate::bridge::load_cached_desired_state(context.bridge, context.db).await
    else {
        return false;
    };
    let ready = RequiredPins::from_desired_state(&desired)
        .images
        .into_iter()
        .filter(|image| ready::is_image_ready(context.cache_root, image))
        .collect::<Vec<_>>();
    let still_pinned = |image: &OciDigest| {
        let image = image.clone();
        async move {
            crate::bridge::load_cached_desired_state(context.bridge, context.db)
                .await
                .is_some_and(|desired| {
                    RequiredPins::from_desired_state(&desired)
                        .images
                        .contains(&image)
                })
        }
    };
    let confirm = |image: &OciDigest| {
        let image = image.clone();
        async move {
            // A confirmation never holds up a boot.
            wait_for_vm_boot_idle().await;
            let ready = ready::require_ready_image(context.cache_root, &image).await?;
            context.vm.confirm_image_template(&ready).await
        }
    };
    confirm_sweep(
        context.cache_root,
        &ready,
        still_pinned,
        confirm,
        crate::image_cache::wake_cache_refresh,
    )
    .await
}

/// One sweep over `images`, bounded by [`TEMPLATE_CONFIRM_SWEEP_BUDGET`]. An
/// image no longer pinned is skipped. `confirm` is `Ok(true)` when jailerd
/// holds the template and `Ok(false)` when it does not: the image's
/// readiness is withdrawn and `wake` wakes the cache pass. An error, jailerd
/// unreachable included, keeps readiness. True when jailerd answered once,
/// or there was nothing to confirm.
async fn confirm_sweep<P, PF, C, CF>(
    cache_root: &Path,
    images: &[OciDigest],
    still_pinned: P,
    confirm: C,
    wake: impl Fn(),
) -> bool
where
    P: Fn(&OciDigest) -> PF,
    PF: std::future::Future<Output = bool>,
    C: Fn(&OciDigest) -> CF,
    CF: std::future::Future<Output = Result<bool>>,
{
    let answered = std::sync::atomic::AtomicBool::new(images.is_empty());
    let sweep = futures_util::stream::iter(images).for_each_concurrent(
        TEMPLATE_CONFIRMS_IN_FLIGHT,
        |image| {
            let (answered, still_pinned, confirm, wake) = (&answered, &still_pinned, &confirm, &wake);
            async move {
                if !still_pinned(image).await {
                    return;
                }
                match tokio::time::timeout(TEMPLATE_CONFIRM_TIMEOUT, confirm(image)).await {
                    Ok(Ok(true)) => answered.store(true, std::sync::atomic::Ordering::Relaxed),
                    Ok(Ok(false)) => {
                        answered.store(true, std::sync::atomic::Ordering::Relaxed);
                        info!(image = image.as_str(), "jailerd no longer holds the image's template; preparing it again");
                        if let Err(error) = ready::withdraw_ready_image(cache_root, image) {
                            warn!(error = %error, image = image.as_str(), "failed to withdraw the image's readiness");
                        }
                        wake();
                    }
                    Ok(Err(error)) => {
                        warn!(error = %format!("{error:#}"), image = image.as_str(), "the image's template was not confirmed");
                    }
                    Err(_) => {
                        warn!(image = image.as_str(), "the image's template confirmation timed out");
                    }
                }
            }
        },
    );
    if tokio::time::timeout(TEMPLATE_CONFIRM_SWEEP_BUDGET, sweep)
        .await
        .is_err()
    {
        warn!("template confirmation sweep ran out of time; the next one continues");
    }
    answered.load(std::sync::atomic::Ordering::Relaxed)
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
async fn prepare_one_image(image: &OciDigest, context: CacheRefreshContext<'_>) -> Result<()> {
    let pulled = context
        .vm
        .oci_registry()
        .pull_machine(image, &context.store())
        .await?;
    check_machine_config(&pulled.config)?;
    context
        .vm
        .ensure_cached_image_template_background(&pulled)
        .await
        .map(drop)
        .context("failed to prepare the root-owned jail image template")
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

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::super::pins::tests::digest;
    use super::*;

    struct Sweep {
        _root: tempfile::TempDir,
        cache_root: PathBuf,
        wakes: Cell<usize>,
        confirmed: Cell<usize>,
    }

    impl Sweep {
        fn with_ready(images: &[&OciDigest]) -> Result<Self> {
            let root = tempfile::tempdir()?;
            let cache_root = root.path().to_owned();
            std::fs::create_dir_all(cache_root.join("launch"))?;
            for image in images {
                std::fs::write(Self::descriptor(&cache_root, image), b"{}")?;
            }
            Ok(Self {
                _root: root,
                cache_root,
                wakes: Cell::new(0),
                confirmed: Cell::new(0),
            })
        }

        fn descriptor(cache_root: &Path, image: &OciDigest) -> PathBuf {
            cache_root
                .join("launch")
                .join(format!("{}.ready.json", image.hex()))
        }

        fn ready(&self, image: &OciDigest) -> bool {
            Self::descriptor(&self.cache_root, image).exists()
        }

        async fn run(
            &self,
            images: &[OciDigest],
            pinned: impl Fn(&OciDigest) -> bool,
            answer: impl Fn(&OciDigest) -> Option<Result<bool>>,
        ) -> bool {
            confirm_sweep(
                &self.cache_root,
                images,
                |image| std::future::ready(pinned(image)),
                |image| {
                    self.confirmed.set(self.confirmed.get() + 1);
                    let answer = answer(image);
                    async move {
                        match answer {
                            Some(answer) => answer,
                            None => std::future::pending().await,
                        }
                    }
                },
                || self.wakes.set(self.wakes.get() + 1),
            )
            .await
        }
    }

    #[tokio::test]
    async fn a_held_template_stays_ready_and_a_gone_one_is_withdrawn() -> Result<()> {
        let (held, gone) = (digest('a'), digest('b'));
        let sweep = Sweep::with_ready(&[&held, &gone])?;
        let answered = sweep
            .run(
                &[held.clone(), gone.clone()],
                |_| true,
                |image| Some(Ok(*image == held)),
            )
            .await;
        assert!(answered);
        assert!(sweep.ready(&held));
        assert!(!sweep.ready(&gone), "the cache pass prepares it again");
        assert_eq!(sweep.wakes.get(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn an_image_unpinned_mid_sweep_is_not_confirmed() -> Result<()> {
        let image = digest('a');
        let sweep = Sweep::with_ready(&[&image])?;
        sweep
            .run(std::slice::from_ref(&image), |_| false, |_| Some(Ok(false)))
            .await;
        assert_eq!(sweep.confirmed.get(), 0);
        assert!(sweep.ready(&image));
        assert_eq!(sweep.wakes.get(), 0);
        Ok(())
    }

    #[tokio::test]
    async fn an_unreachable_jailerd_keeps_readiness() -> Result<()> {
        let image = digest('a');
        let sweep = Sweep::with_ready(&[&image])?;
        let answered = sweep
            .run(
                std::slice::from_ref(&image),
                |_| true,
                |_| Some(Err(anyhow::anyhow!("connect to intar-jailerd: refused"))),
            )
            .await;
        assert!(!answered, "the first sweep is retried soon");
        assert!(sweep.ready(&image));
        assert_eq!(sweep.wakes.get(), 0);
        Ok(())
    }

    #[tokio::test(start_paused = true)]
    async fn a_sweep_is_bounded_whatever_jailerd_does() -> Result<()> {
        let images = "0123456789abcdef".chars().map(digest).collect::<Vec<_>>();
        let sweep = Sweep::with_ready(&images.iter().collect::<Vec<_>>())?;
        let started = tokio::time::Instant::now();
        let answered = sweep.run(&images, |_| true, |_| None).await;
        assert!(!answered);
        assert!(started.elapsed() <= TEMPLATE_CONFIRM_SWEEP_BUDGET);
        assert!(images.iter().all(|image| sweep.ready(image)));
        Ok(())
    }
}
