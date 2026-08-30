use super::*;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CacheRefreshScope {
    FullRepair,
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

pub(super) async fn run_cache_refresh_cycle(
    context: CacheRefreshContext<'_>,
    scope: CacheRefreshScope,
) {
    let advertised_images =
        match list_registry_images(context.registry, context.bridge, context.client).await {
            Ok(images) => images,
            Err(e) => {
                error!(
                    registry = %redact_url_userinfo(&context.registry.url),
                    "failed to list image registry: {e}"
                );
                return;
            }
        };

    let advertised_count = advertised_images.len();
    let (images, already_ready) = select_images_for_refresh(advertised_images, scope, |image| {
        verified_cached_image_metadata(context.cache_root, &image.image_key, &image.image_id, true)
            .is_some()
    });
    if advertised_count == 0 {
        warn!(
            registry = %redact_url_userinfo(&context.registry.url),
            "image registry did not advertise any raw_chunks_v1 images"
        );
        // The guest-tools disk is independent of scenario images and must be
        // warmable before the flag-day catalog switch. Continue through the
        // empty image phase so desired guest-tool pins are still processed.
    } else {
        info!(
            cache_root = %context.cache_root.display(),
            advertised_count,
            image_count = images.len(),
            already_ready,
            ?scope,
            registry = %redact_url_userinfo(&context.registry.url),
            "refreshing image cache from registry"
        );
    }

    run_selected_image_refreshes(images, context).await;
}

async fn run_selected_image_refreshes(
    images: Vec<RegistryImageRecord>,
    context: CacheRefreshContext<'_>,
) {
    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_IMAGE_WARMS));
    let mut handles = Vec::with_capacity(images.len());
    for image in images {
        let client = context.client.clone();
        let cache_root = context.cache_root.to_path_buf();
        let registry = context.registry.clone();
        let bridge = context.bridge.cloned();
        let db = context.db.cloned();
        let sem = Arc::clone(&sem);
        let vm = context.vm.clone();
        handles.push(tokio::spawn(async move {
            let span = tracing::info_span!(
                "image_cache",
                image = %image.image_key,
                registry = %redact_url_userinfo(&registry.url),
            );
            async move {
                let _permit = match sem.acquire_owned().await {
                    Ok(permit) => permit,
                    Err(_) => return,
                };

                match ensure_cached_chunked_image_entry(
                    &image,
                    &registry,
                    bridge.as_ref(),
                    &cache_root,
                    &client,
                )
                .await
                {
                    Ok(cached_image) => {
                        let template_prepared = match vm
                            .ensure_cached_image_template(&cached_image)
                            .await
                        {
                            Ok(_) => true,
                            Err(error) => {
                                error!(
                                    error = %error,
                                    image = %image.image_key,
                                    "failed to prepare root-owned jail image template"
                                );
                                return;
                            }
                        };
                        if let Some(db) = db.as_ref()
                            && let Err(error) = touch_cached_image(db, &cached_image).await
                        {
                            warn!(error = %error, image = %image.image_key, "failed to update image cache access metadata");
                        }
                        info!(
                        path = %cached_image.chunk_manifest_path.display(),
                            template_prepared,
                            "image boot bundle cache ready"
                        );
                    }
                    Err(e) => error!("failed to cache image: {e}"),
                }
            }
            .instrument(span)
            .await;
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    if let Some(db) = context.db
        && let Ok(Some(row)) = db.load_desired_state().await
        && let Ok(desired) =
            serde_json::from_str::<intar_contracts::bridge::HostDesiredStateV2>(&row.doc_json)
    {
        let mut pins = desired.cached_guest_tools;
        pins.extend(
            desired
                .vms
                .into_iter()
                .filter(|vm| vm.desired_phase == intar_contracts::bridge::DesiredVmPhase::Running)
                .map(|vm| vm.guest_tools),
        );
        pins.sort_by(|left, right| left.tools_disk_sha256.cmp(&right.tools_disk_sha256));
        pins.dedup_by(|left, right| left.tools_disk_sha256 == right.tools_disk_sha256);
        for pin in pins {
            if let Err(error) = ensure_cached_tools_disk(
                &pin.tools_disk_sha256,
                pin.tools_disk_size_bytes,
                context.registry,
                context.bridge,
                context.cache_root,
                context.client,
            )
            .await
            {
                warn!(error = %error, tools_disk_sha256 = %pin.tools_disk_sha256, "failed to warm guest tools disk");
            }
        }
    }

    info!("image cache refresh finished");
    if let Some(db) = context.db
        && let Err(error) = evict_cache_if_needed(context.cache, db, context.cache_root).await
    {
        warn!(error = %error, cache_root = %context.cache_root.display(), "image cache eviction failed");
    }
}

fn select_images_for_refresh<F>(
    images: Vec<RegistryImageRecord>,
    scope: CacheRefreshScope,
    mut is_ready: F,
) -> (Vec<RegistryImageRecord>, usize)
where
    F: FnMut(&RegistryImageRecord) -> bool,
{
    if scope == CacheRefreshScope::FullRepair {
        return (images, 0);
    }
    let mut already_ready = 0;
    let selected = images
        .into_iter()
        .filter(|image| {
            if is_ready(image) {
                already_ready += 1;
                false
            } else {
                true
            }
        })
        .collect();
    (selected, already_ready)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(image_key: &str, image_id: &str) -> RegistryImageRecord {
        RegistryImageRecord {
            image_key: image_key.to_owned(),
            image_filename: format!("{image_key}.chunks.json"),
            image_sha256: image_id.to_owned(),
            image_id: image_id.to_owned(),
            image_virtual_size_bytes: 4 * 1024 * 1024,
            chunk_manifest_sha256: "c".repeat(64),
            guest_bootstrap_abi: 1,
            boot: RegistryImageBoot {
                kernel_sha256: "d".repeat(64),
                initrd_sha256: "e".repeat(64),
                cmdline: "root=/dev/vda rw".to_owned(),
            },
            download_url: "/manifest".to_owned(),
            manifest_download_url: "/manifest".to_owned(),
            chunk_download_base_url: "/chunks".to_owned(),
        }
    }

    #[test]
    fn event_refresh_selects_only_images_without_ready_templates() {
        let ready_id = "a".repeat(64);
        let missing_id = "b".repeat(64);
        let (selected, already_ready) = select_images_for_refresh(
            vec![image("ready", &ready_id), image("missing", &missing_id)],
            CacheRefreshScope::MissingOnly,
            |candidate| candidate.image_id == ready_id,
        );

        assert_eq!(already_ready, 1);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].image_id, missing_id);
    }

    #[test]
    fn repair_refresh_revalidates_every_advertised_image() {
        let images = vec![image("one", &"a".repeat(64)), image("two", &"b".repeat(64))];
        let (selected, already_ready) =
            select_images_for_refresh(images, CacheRefreshScope::FullRepair, |_| true);

        assert_eq!(already_ready, 0);
        assert_eq!(selected.len(), 2);
    }
}
