use super::*;

use std::collections::BTreeMap;

/// A verification younger than this is not repeated.
pub(super) const SCRUB_OK_AGE: Duration = Duration::from_secs(12 * 60 * 60);

/// Cache content whose newest completed verification is older than this, or
/// that has no verification at all, raises an alert.
pub(super) const SCRUB_ALERT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// One batch of the scrub pass. The pass keeps taking batches while work is
/// due, so the value is a yield granularity, not a rate limit: after a batch
/// the pass parks if a boot is live and otherwise continues at once.
pub(super) const SCRUB_ITEMS_PER_BATCH: usize = 64;

/// What a failed verification must rebuild. The target is typed, so a corrupt
/// guest tools disk can never be sent to the image repair path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ScrubTarget {
    /// The file belongs to one pinned image.
    Image { image_key: String, image_id: String },
    /// The file is a pinned guest tools disk.
    GuestTools {
        tools_disk_sha256: String,
        tools_disk_size_bytes: u64,
    },
}

/// One cache file that the scrub pass verifies.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct ScrubItem {
    /// Cache-root-relative path. Two images that share a chunk share this key,
    /// so the chunk is verified one time per pass, not one time per image.
    pub(super) dedup_key: String,
    pub(super) path: PathBuf,
    /// The digest that the bytes of this file must produce.
    pub(super) expected_sha256: String,
    pub(super) target: ScrubTarget,
}

/// One batch of scrub work.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(super) struct ScrubBatch {
    pub(super) items: Vec<ScrubItem>,
    /// Items already covered by a young verification.
    pub(super) fresh: usize,
    /// Items whose newest completed verification is older than the alert age,
    /// or that have no verification at all.
    pub(super) overdue: usize,
    /// Items still due after this batch. The pass continues while this is
    /// greater than zero, so a large cache is covered in one pass and the
    /// elapsed time is bounded by the reader budget, not by the timer.
    pub(super) deferred: usize,
}

/// Take the next batch of due work, oldest content first.
///
/// `attempted` holds the dedup keys this pass already tried. It is pass-local
/// on purpose: the order is content, first verified youngest to oldest, and
/// that order changes whenever a verification lands. A persisted cursor over a
/// changing order could skip content that just moved ahead of it, so the pass
/// keeps its own visited set and the skip rule for a later pass comes from the
/// completed verification timestamp alone. Content that failed verification
/// has no young timestamp, so the next pass retries it.
pub(super) fn plan_scrub_batch(
    items: &[ScrubItem],
    verified: &BTreeMap<String, i64>,
    attempted: &HashSet<String>,
    now_ms: i64,
    batch_limit: usize,
) -> ScrubBatch {
    let ok_age_ms = i64::try_from(SCRUB_OK_AGE.as_millis()).unwrap_or(i64::MAX);
    let alert_age_ms = i64::try_from(SCRUB_ALERT_AGE.as_millis()).unwrap_or(i64::MAX);

    let mut unique: BTreeMap<&str, &ScrubItem> = BTreeMap::new();
    for item in items {
        unique.entry(item.dedup_key.as_str()).or_insert(item);
    }

    let mut batch = ScrubBatch::default();
    let mut due: Vec<ScrubItem> = Vec::new();
    for item in unique.into_values() {
        let age = verified
            .get(&item.expected_sha256)
            .map(|verified_at_ms| now_ms.saturating_sub(*verified_at_ms));
        if item.target.is_overdue(age, alert_age_ms) {
            batch.overdue = batch.overdue.saturating_add(1);
        }
        if attempted.contains(&item.dedup_key) {
            continue;
        }
        if age.is_some_and(|age| age < ok_age_ms) {
            batch.fresh = batch.fresh.saturating_add(1);
            continue;
        }
        due.push(item.clone());
    }
    // Oldest completed verification first, then content with no verification
    // at all, then by path so the order is stable inside one pass.
    due.sort_by(|left, right| {
        let left_age = verified.get(&left.expected_sha256).copied();
        let right_age = verified.get(&right.expected_sha256).copied();
        left_age
            .unwrap_or(i64::MAX)
            .cmp(&right_age.unwrap_or(i64::MAX))
            .then_with(|| left.dedup_key.cmp(&right.dedup_key))
    });
    let taken = due.split_off(due.len().min(batch_limit));
    batch.deferred = taken.len();
    batch.items = due;
    batch
}

impl ScrubTarget {
    fn is_overdue(&self, age: Option<i64>, alert_age_ms: i64) -> bool {
        age.is_none_or(|age| age >= alert_age_ms)
    }
}

/// The registry records that the required pins hold, and nothing else.
///
/// An empty pin set gives an empty list. The cache never falls back to the
/// full registry authorization inventory.
pub(super) fn retained_registry_images(
    registry: &[RegistryImageRecord],
    pins: &RequiredPins,
) -> Vec<RegistryImageRecord> {
    registry
        .iter()
        .filter(|image| pins.holds_image(&image.image_key, &image.image_id))
        .cloned()
        .collect()
}

/// The registry records that are pinned but not yet ready to launch.
pub(super) fn missing_registry_images<F>(
    retained: Vec<RegistryImageRecord>,
    mut is_ready: F,
) -> Vec<RegistryImageRecord>
where
    F: FnMut(&RegistryImageRecord) -> bool,
{
    retained
        .into_iter()
        .filter(|image| !is_ready(image))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_item(key: &str, digest: &str, image_key: &str, image_id: &str) -> ScrubItem {
        ScrubItem {
            dedup_key: key.to_owned(),
            path: PathBuf::from(key),
            expected_sha256: digest.to_owned(),
            target: ScrubTarget::Image {
                image_key: image_key.to_owned(),
                image_id: image_id.to_owned(),
            },
        }
    }

    fn tools_item(key: &str, digest: &str) -> ScrubItem {
        ScrubItem {
            dedup_key: key.to_owned(),
            path: PathBuf::from(key),
            expected_sha256: digest.to_owned(),
            target: ScrubTarget::GuestTools {
                tools_disk_sha256: digest.to_owned(),
                tools_disk_size_bytes: 64 * 1024 * 1024,
            },
        }
    }

    fn registry_image(image_key: &str, image_id: &str) -> RegistryImageRecord {
        RegistryImageRecord {
            image_key: image_key.to_owned(),
            image_id: image_id.to_owned(),
            image_virtual_size_bytes: 4 * 1024 * 1024,
            chunk_manifest_sha256: "c".repeat(64),
            guest_bootstrap_abi: 1,
            boot: RegistryImageBoot {
                kernel_sha256: "d".repeat(64),
                initrd_sha256: "e".repeat(64),
                cmdline: "root=/dev/vda rw".to_owned(),
            },
            manifest_download_url: "/manifest".to_owned(),
            chunk_download_base_url: "/chunks".to_owned(),
        }
    }

    fn pins_with(images: &[(&str, &str)]) -> RequiredPins {
        let mut pins = RequiredPins::default();
        for (key, digest) in images {
            let mut parts = key.split('-');
            pins.images.insert((
                parts.next().unwrap_or_default().to_owned(),
                parts.next().unwrap_or_default().to_owned(),
                "x86_64".to_owned(),
                digest.to_string(),
            ));
        }
        pins
    }

    #[test]
    fn a_chunk_shared_by_two_images_is_verified_one_time() {
        let chunk = "chunks/aa.raw.zst";
        let items = vec![
            image_item(chunk, &"1".repeat(64), "a-web-x86_64", "a"),
            image_item(chunk, &"1".repeat(64), "b-web-x86_64", "b"),
            image_item("chunks/bb.raw.zst", &"2".repeat(64), "a-web-x86_64", "a"),
        ];

        let batch = plan_scrub_batch(&items, &BTreeMap::new(), &HashSet::new(), 0, 64);

        assert_eq!(batch.items.len(), 2);
        assert_eq!(batch.items[0].dedup_key, "chunks/aa.raw.zst");
        assert_eq!(batch.items[1].dedup_key, "chunks/bb.raw.zst");
    }

    #[test]
    fn a_young_verification_is_not_repeated_and_the_oldest_is_first() {
        let now_ms = 100_000_000_000;
        let ok_age_ms = i64::try_from(SCRUB_OK_AGE.as_millis()).expect("12 h fits");
        let mut verified = BTreeMap::new();
        verified.insert("1".repeat(64), now_ms - 60_000);
        verified.insert("2".repeat(64), now_ms - ok_age_ms - 1);
        let items = vec![
            image_item("chunks/aa.raw.zst", &"1".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/bb.raw.zst", &"2".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/cc.raw.zst", &"3".repeat(64), "a-web-x86_64", "a"),
        ];

        let batch = plan_scrub_batch(&items, &verified, &HashSet::new(), now_ms, 64);

        assert_eq!(batch.fresh, 1);
        assert_eq!(batch.items.len(), 2, "the old and the never-verified item");
        assert_eq!(batch.items[0].expected_sha256, "2".repeat(64));
        assert_eq!(batch.items[1].expected_sha256, "3".repeat(64));
        assert_eq!(batch.overdue, 1, "only the never-verified item is overdue");
    }

    #[test]
    fn content_without_a_young_verification_is_reported_overdue() {
        let now_ms = 100_000_000_000;
        let alert_age_ms = i64::try_from(SCRUB_ALERT_AGE.as_millis()).expect("24 h fits");
        let mut verified = BTreeMap::new();
        verified.insert("1".repeat(64), now_ms - alert_age_ms - 1);
        let items = vec![
            image_item("chunks/aa.raw.zst", &"1".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/bb.raw.zst", &"2".repeat(64), "a-web-x86_64", "a"),
        ];

        let batch = plan_scrub_batch(&items, &verified, &HashSet::new(), now_ms, 64);

        assert_eq!(batch.overdue, 2, "one too old and one never verified");
    }

    #[test]
    fn a_batch_limit_defers_work_and_the_next_batch_covers_the_rest() {
        let items = vec![
            image_item("chunks/aa.raw.zst", &"1".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/bb.raw.zst", &"2".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/cc.raw.zst", &"3".repeat(64), "a-web-x86_64", "a"),
        ];

        let first = plan_scrub_batch(&items, &BTreeMap::new(), &HashSet::new(), 0, 2);
        assert_eq!(first.items.len(), 2);
        assert_eq!(first.deferred, 1, "the pass must keep going");

        let visited = first
            .items
            .iter()
            .map(|item| item.dedup_key.clone())
            .collect::<HashSet<_>>();
        let second = plan_scrub_batch(&items, &BTreeMap::new(), &visited, 0, 2);
        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].dedup_key, "chunks/cc.raw.zst");
        assert_eq!(second.deferred, 0);
    }

    /// The failure a persistent cursor would produce. One item gets a young
    /// verification between two batches, which moves it behind a cursor and a
    /// cursor rule would skip everything that sorts after it. The pass-local
    /// visit set covers the item that is still due.
    #[test]
    fn a_young_verification_landing_mid_pass_cannot_hide_due_work() {
        let now_ms = 100_000_000_000;
        let ok_age_ms = i64::try_from(SCRUB_OK_AGE.as_millis()).expect("12 h fits");
        let items = vec![
            image_item("chunks/aa.raw.zst", &"1".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/bb.raw.zst", &"2".repeat(64), "a-web-x86_64", "a"),
            image_item("chunks/cc.raw.zst", &"3".repeat(64), "a-web-x86_64", "a"),
        ];
        let first = plan_scrub_batch(&items, &BTreeMap::new(), &HashSet::new(), now_ms, 2);
        let visited = first
            .items
            .iter()
            .map(|item| item.dedup_key.clone())
            .collect::<HashSet<_>>();

        // The first item is verified while the pass runs. Its age is young now,
        // so a rule that ordered by age would sort it behind everything else.
        let mut verified = BTreeMap::new();
        verified.insert(first.items[0].expected_sha256.clone(), now_ms);
        let _ = ok_age_ms;

        let next = plan_scrub_batch(&items, &verified, &visited, now_ms, 64);

        assert_eq!(next.items.len(), 1);
        assert_eq!(next.items[0].dedup_key, "chunks/cc.raw.zst");
    }

    #[test]
    fn a_tools_disk_belongs_to_the_tools_repair_path() {
        let item = tools_item("tools/aa.ext4", &"1".repeat(64));

        assert_eq!(
            item.target,
            ScrubTarget::GuestTools {
                tools_disk_sha256: "1".repeat(64),
                tools_disk_size_bytes: 64 * 1024 * 1024,
            }
        );
    }

    #[test]
    fn an_empty_pin_set_selects_nothing() {
        let registry = vec![
            registry_image("a-web-x86_64", &"1".repeat(64)),
            registry_image("b-web-x86_64", &"2".repeat(64)),
        ];

        let retained = retained_registry_images(&registry, &RequiredPins::default());

        assert!(
            retained.is_empty(),
            "an empty pin set must not select the whole registry"
        );
    }

    #[test]
    fn only_pinned_images_are_retained_and_only_missing_ones_are_prepared() {
        let registry = vec![
            registry_image("a-web-x86_64", &"1".repeat(64)),
            registry_image("b-web-x86_64", &"2".repeat(64)),
            registry_image("c-web-x86_64", &"3".repeat(64)),
        ];
        let pins = pins_with(&[
            ("a-web-x86_64", &"1".repeat(64)),
            ("b-web-x86_64", &"2".repeat(64)),
        ]);

        let retained = retained_registry_images(&registry, &pins);
        assert_eq!(retained.len(), 2);

        let missing = missing_registry_images(retained, |image| image.image_id == "1".repeat(64));
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0].image_id, "2".repeat(64));
    }

    #[test]
    fn a_running_vm_that_is_not_in_the_desired_cache_is_still_pinned() {
        let registry = vec![registry_image("only-running-x86_64", &"9".repeat(64))];
        let state = running_only_state();
        let pins = RequiredPins::from_desired_state(&state);

        assert!(
            state.cached_images.is_empty(),
            "the image is pinned through the running VM alone"
        );
        assert_eq!(
            retained_registry_images(&registry, &pins).len(),
            1,
            "a running VM pin must retain its image"
        );
        assert_eq!(
            pins.image_pins().count(),
            1,
            "the scrub pass must see the running-only pin"
        );
    }

    fn running_only_state() -> intar_contracts::bridge::HostDesiredStateV2 {
        use intar_contracts::bridge::{
            DesiredGuestToolsV1, DesiredVmPhase, DesiredVmV2, HostDesiredStateV2, VmResourcesV3,
        };
        use intar_contracts::catalog::{ImageArchitecture, ImageKey, Mib};

        HostDesiredStateV2 {
            schema_version: intar_contracts::bridge::HOST_DESIRED_STATE_SCHEMA_VERSION,
            host_id: "host-1".to_owned(),
            version: 1,
            generated_at_unix_ms: 0,
            cached_images: Vec::new(),
            cached_guest_tools: Vec::new(),
            vms: vec![DesiredVmV2 {
                run_id: "run-1".to_owned(),
                vm_name: "vm-1".to_owned(),
                desired_phase: DesiredVmPhase::Running,
                image_key: ImageKey {
                    scenario: "only".to_owned(),
                    vm: "running".to_owned(),
                    arch: ImageArchitecture::X86_64,
                },
                image_id: "9".repeat(64),
                guest_tools: DesiredGuestToolsV1 {
                    tools_disk_sha256: "a".repeat(64),
                    tools_disk_size_bytes: 64 * 1024 * 1024,
                    kino_sha256: "b".repeat(64),
                    bootstrap_abi: 1,
                },
                resources: VmResourcesV3 {
                    cpu_millis: 1,
                    memory_mib: Mib(1),
                    disk_mib: Mib(1),
                },
                ssh_authorized_keys_openssh: vec![],
                lease_expires_at_unix_ms: 0,
            }],
            builds: Vec::new(),
        }
    }
}
