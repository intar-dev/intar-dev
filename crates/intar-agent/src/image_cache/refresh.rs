use super::*;

pub(super) async fn run_cache_refresh_cycle(
    registry: &ImageRegistryConfig,
    bridge: Option<&BridgeConfig>,
    cache: &ImageCacheConfig,
    db: Option<&Db>,
    cache_root: &Path,
    client: &reqwest::Client,
    vm: &crate::vm::VmManager,
) {
    let images = match list_registry_images(registry, bridge, client).await {
        Ok(images) => images,
        Err(e) => {
            error!(
                registry = %redact_url_userinfo(&registry.url),
                "failed to list image registry: {e}"
            );
            return;
        }
    };

    if images.is_empty() {
        warn!(
            registry = %redact_url_userinfo(&registry.url),
            "image registry did not advertise any raw_zstd images"
        );
        return;
    }

    info!(
        cache_root = %cache_root.display(),
        image_count = images.len(),
        registry = %redact_url_userinfo(&registry.url),
        "refreshing image cache from registry"
    );

    let sem = Arc::new(Semaphore::new(MAX_CONCURRENT_IMAGE_WARMS));
    let mut handles = Vec::with_capacity(images.len());
    for image in images {
        let client = client.clone();
        let cache_root = cache_root.to_path_buf();
        let registry = registry.clone();
        let bridge = bridge.cloned();
        let db = db.cloned();
        let sem = Arc::clone(&sem);
        let vm = vm.clone();
        handles.push(tokio::spawn(async move {
            let span = tracing::info_span!(
                "image_cache",
                image = %image.image_key,
                registry = %redact_url_userinfo(&registry.url),
            );
            let _guard = span.enter();

            let _permit = match sem.acquire_owned().await {
                Ok(permit) => permit,
                Err(_) => return,
            };

            match ensure_cached_image_entry(
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
                        path = %cached_image.raw_path.display(),
                        template_prepared,
                        "image boot bundle cache ready"
                    );
                }
                Err(e) => error!("failed to cache image: {e}"),
            }
        }));
    }

    for handle in handles {
        let _ = handle.await;
    }

    info!("image cache refresh finished");
    if let Some(db) = db
        && let Err(error) = evict_cache_if_needed(cache, db, cache_root).await
    {
        warn!(error = %error, cache_root = %cache_root.display(), "image cache eviction failed");
    }
}
