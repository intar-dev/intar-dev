use super::*;

#[test]
fn select_evictions_keeps_under_budget_cache() {
    let entries = vec![
        CacheEntry {
            sha: "a".repeat(64),
            bytes: 100,
            last_accessed_at_ms: 10,
        },
        CacheEntry {
            sha: "b".repeat(64),
            bytes: 200,
            last_accessed_at_ms: 20,
        },
    ];

    assert!(select_evictions(&entries, &HashSet::new(), 300).is_empty());
}

#[test]
fn select_evictions_skips_protected_entries() {
    let protected_sha = "a".repeat(64);
    let entries = vec![
        CacheEntry {
            sha: protected_sha.clone(),
            bytes: 300,
            last_accessed_at_ms: 10,
        },
        CacheEntry {
            sha: "b".repeat(64),
            bytes: 200,
            last_accessed_at_ms: 20,
        },
        CacheEntry {
            sha: "c".repeat(64),
            bytes: 200,
            last_accessed_at_ms: 30,
        },
    ];
    let protected = HashSet::from([protected_sha.clone()]);

    assert_eq!(
        select_evictions(&entries, &protected, 300),
        vec!["b".repeat(64), "c".repeat(64)]
    );
}

#[test]
fn select_evictions_uses_oldest_access_then_sha() {
    let entries = vec![
        CacheEntry {
            sha: "c".repeat(64),
            bytes: 100,
            last_accessed_at_ms: 10,
        },
        CacheEntry {
            sha: "a".repeat(64),
            bytes: 100,
            last_accessed_at_ms: 10,
        },
        CacheEntry {
            sha: "b".repeat(64),
            bytes: 100,
            last_accessed_at_ms: 20,
        },
    ];

    assert_eq!(
        select_evictions(&entries, &HashSet::new(), 100),
        vec!["a".repeat(64), "c".repeat(64)]
    );
}

#[tokio::test]
async fn evict_unreferenced_artifacts_respects_refcounts_and_grace() -> Result<()> {
    let cache_root = tempfile::tempdir()?;
    let artifact_dir = cache_root.path().join("artifacts");
    std::fs::create_dir_all(&artifact_dir)?;

    let retained_sha = "a".repeat(64);
    let unreferenced_sha = "b".repeat(64);
    let fresh_sha = "c".repeat(64);
    let old_mtime = SystemTime::now() - ARTIFACT_EVICTION_GRACE - Duration::from_secs(60);
    for (sha, mtime) in [
        (&retained_sha, Some(old_mtime)),
        (&unreferenced_sha, Some(old_mtime)),
        // Fresh unreferenced artifact: an in-flight VM create may have
        // just downloaded it before recording its access row.
        (&fresh_sha, None),
    ] {
        let path = artifact_dir.join(sha);
        std::fs::write(&path, b"artifact")?;
        if let Some(mtime) = mtime {
            std::fs::File::options()
                .write(true)
                .open(&path)?
                .set_modified(mtime)?;
        }
    }

    let retained = HashSet::from([retained_sha.clone()]);
    evict_unreferenced_artifacts(cache_root.path(), &retained).await?;

    assert!(
        artifact_dir.join(&retained_sha).exists(),
        "artifact referenced by a retained raw entry must never be evicted"
    );
    assert!(
        !artifact_dir.join(&unreferenced_sha).exists(),
        "old artifact with no retained raw reference must be evicted"
    );
    assert!(
        artifact_dir.join(&fresh_sha).exists(),
        "artifact inside the eviction grace window must be kept"
    );
    Ok(())
}
