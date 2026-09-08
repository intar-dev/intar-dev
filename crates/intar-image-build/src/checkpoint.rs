//! Immutable, local QEMU checkpoint storage.
//!
//! The cache has no knowledge of QEMU state. Callers provide the frozen disk,
//! migration stream, and build seed after they have made the guest consistent.
//! This module only stores those bytes atomically and keeps them private to the
//! builder account.

use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, bail, ensure};
use fs2::FileExt;
use intar_image_scenario::{hash_field, hex_digest, sha256_bytes_hex as sha256_bytes};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

// Checkpoint cache v3 uses BLAKE3 for private payload integrity and a mutable
// per-scope role index. Public image artifacts, metadata completion markers,
// and cache-identity keys remain SHA-256. Older entries are rebuilt.
const CACHE_FORMAT: &str = "intar-checkpoint-cache-v3";
const SCOPE_INDEX_FORMAT: &str = "intar-checkpoint-scope-v1";
const ENTRY_FILE_QCOW2: &str = "checkpoint.qcow2";
const ENTRY_FILE_MEMORY: &str = "memory.state";
const ENTRY_FILE_SEED: &str = "seed.img";
const ENTRY_FILE_METADATA: &str = "metadata.json";
const ENTRY_FILE_COMPLETE: &str = "complete.json";
const GLOBAL_LOCK_FILE: &str = ".gc.lock";
const ENTRIES_DIR: &str = "entries";
const SCOPES_DIR: &str = "scopes";
const LOCKS_DIR: &str = "locks";
const LRU_DIR: &str = "lru";
const RESERVATIONS_DIR: &str = "reservations";
const STAGING_DIR: &str = ".staging";

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
thread_local! {
    static FAIL_SCOPE_INDEX_WRITE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Local checkpoint cache settings.
///
/// `root` must name builder-owned local storage. The cache creates all files
/// under it with owner-only permissions.
#[derive(Clone, Debug)]
pub struct CheckpointCacheConfig {
    pub root: PathBuf,
    pub use_cache: bool,
    pub budget_bytes: u64,
    pub minimum_free_bytes: u64,
}

/// The scenario VM that owns a checkpoint namespace.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CheckpointScope {
    pub scenario_id: String,
    pub vm_name: String,
}

/// Inputs that define a reusable completed provisioning prefix.
///
/// This intentionally has no full bundle hash or bytes from later stages.
/// `parent_prefix` must identify all completed earlier stages, and
/// `stage_bytes` must be the exact bytes executed for this stage.
#[derive(Clone)]
pub struct CheckpointIdentity {
    pub scenario_id: String,
    pub vm_name: String,
    pub parent_prefix: String,
    pub stage_bytes: Vec<u8>,
    pub base_sha256: String,
    pub kernel_sha256: String,
    pub initrd_sha256: String,
    pub disk_geometry_bytes: u64,
    pub qemu_version: String,
    pub qemu_cpu: String,
    pub qemu_devices: Vec<String>,
    pub provisioning_abi: String,
}

impl std::fmt::Debug for CheckpointIdentity {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CheckpointIdentity")
            .field("scenario_id", &self.scenario_id)
            .field("vm_name", &self.vm_name)
            .field("cache_key", &self.cache_key().ok())
            .finish_non_exhaustive()
    }
}

impl CheckpointIdentity {
    #[must_use]
    pub fn scope(&self) -> CheckpointScope {
        CheckpointScope {
            scenario_id: self.scenario_id.clone(),
            vm_name: self.vm_name.clone(),
        }
    }

    /// Return the stable SHA-256 key for this checkpoint prefix.
    ///
    /// # Errors
    /// Returns an error when an identifier required for cache isolation is
    /// empty.
    pub fn cache_key(&self) -> Result<String> {
        require_non_empty("scenario_id", &self.scenario_id)?;
        require_non_empty("vm_name", &self.vm_name)?;
        require_non_empty("parent_prefix", &self.parent_prefix)?;
        require_non_empty("base_sha256", &self.base_sha256)?;
        require_non_empty("kernel_sha256", &self.kernel_sha256)?;
        require_non_empty("initrd_sha256", &self.initrd_sha256)?;
        require_non_empty("qemu_version", &self.qemu_version)?;
        require_non_empty("qemu_cpu", &self.qemu_cpu)?;
        require_non_empty("provisioning_abi", &self.provisioning_abi)?;

        let mut hasher = Sha256::new();
        hash_field(&mut hasher, "format", CACHE_FORMAT.as_bytes());
        hash_field(&mut hasher, "scenario_id", self.scenario_id.as_bytes());
        hash_field(&mut hasher, "vm_name", self.vm_name.as_bytes());
        hash_field(&mut hasher, "parent_prefix", self.parent_prefix.as_bytes());
        hash_field(&mut hasher, "stage_bytes", &self.stage_bytes);
        hash_field(&mut hasher, "base_sha256", self.base_sha256.as_bytes());
        hash_field(&mut hasher, "kernel_sha256", self.kernel_sha256.as_bytes());
        hash_field(&mut hasher, "initrd_sha256", self.initrd_sha256.as_bytes());
        hash_field(
            &mut hasher,
            "disk_geometry_bytes",
            &self.disk_geometry_bytes.to_le_bytes(),
        );
        hash_field(&mut hasher, "qemu_version", self.qemu_version.as_bytes());
        hash_field(&mut hasher, "qemu_cpu", self.qemu_cpu.as_bytes());
        hash_field(
            &mut hasher,
            "qemu_device_count",
            &usize_to_u64(self.qemu_devices.len()),
        );
        for device in &self.qemu_devices {
            hash_field(&mut hasher, "qemu_device", device.as_bytes());
        }
        hash_field(
            &mut hasher,
            "provisioning_abi",
            self.provisioning_abi.as_bytes(),
        );
        Ok(hex_digest(hasher.finalize()))
    }
}

/// The two retained checkpoint roles for one scenario VM.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointSlot {
    ExpensivePrefix,
    BeforeLastStep,
}

/// A verified immutable entry in the local checkpoint cache.
///
/// `metadata` is opaque builder-private resume data. It can include a build
/// credential and must never be sent to logs, bundles, or image publication.
#[derive(Clone)]
pub struct CheckpointEntry {
    pub key: String,
    pub stage_index: usize,
    pub qcow2_path: PathBuf,
    pub memory_state_path: PathBuf,
    pub seed_disk_path: PathBuf,
    pub metadata: Value,
    pub stored_bytes: u64,
}

/// A cache lease. Keep this value alive while QEMU reads the checkpoint.
///
/// A restored entry holds a shared lock. A newly published entry transfers the
/// writer's exclusive lock directly into this value. Both forms prevent cache
/// eviction until the lease is dropped.
pub struct CheckpointLease {
    pub entry: CheckpointEntry,
    _entry_lock: File,
}

impl Drop for CheckpointLease {
    fn drop(&mut self) {
        // `flock` release on close is normally sufficient. Explicit unlock
        // makes a just-dropped lease immediately observable to another cache
        // operation on macOS as well as Linux.
        let _ = FileExt::unlock(&self._entry_lock);
    }
}

pub(crate) enum CheckpointPublish {
    Stored(CheckpointLease),
    Skipped,
    RetentionUncertain,
}

/// A pre-reserved checkpoint publication.
///
/// The reservation protects worst-case physical working space until the
/// checkpoint finishes. It does not count as completed cache occupancy.
/// Dropping it releases the reservation.
pub struct CheckpointWriter {
    config: CheckpointCacheConfig,
    scope: CheckpointScope,
    key: String,
    parent_prefix: String,
    slot: CheckpointSlot,
    reservation_path: PathBuf,
    // `publish_moving` transfers this lock into the returned lease. This
    // avoids a second cache lookup and leaves no eviction window before QEMU
    // starts to restore the checkpoint.
    _entry_lock: Option<File>,
}

impl CheckpointWriter {
    /// Check the snapshot source filesystem as well as the cache filesystem.
    /// Outstanding reservations count here even if another worker uses a
    /// different mount; that deliberately errs toward skipping cache writes.
    /// Each filesystem checks the same physical reservation once, so a
    /// same-filesystem move is not charged as both a source and a copy.
    pub fn has_work_space(&self, work_root: &Path) -> Result<bool> {
        let required = read_reservations(&self.config.root)?
            .iter()
            .fold(self.config.minimum_free_bytes, |total, reservation| {
                total.saturating_add(reservation.value.bytes)
            });
        Ok(fs2::available_space(work_root)? >= required)
    }

    /// Atomically save a frozen QEMU checkpoint and return its cache lease.
    ///
    /// On a same-filesystem cache, this moves the frozen `qcow2_path` and
    /// `memory_state_path` into private staging. It always copies
    /// `seed_disk_path`, because that file remains part of the active build
    /// runtime. On a different filesystem, the frozen files are copied. No
    /// hard links are made.
    ///
    /// On [`CheckpointPublish::Stored`], the cache owns the frozen disk and
    /// memory files. The caller must use the returned lease and must not use
    /// those source paths. On [`CheckpointPublish::Skipped`] or `Err`, moved
    /// files are returned to their original paths so the caller can continue
    /// from its local snapshot. [`CheckpointPublish::RetentionUncertain`]
    /// preserves the cache payloads but requires the caller to cold rebuild.
    ///
    /// # Errors
    /// Returns an error when a source file is invalid or cache publication
    /// cannot complete.
    pub(crate) fn publish_moving(
        mut self,
        qcow2_path: &Path,
        memory_state_path: &Path,
        seed_disk_path: &Path,
        stage_index: usize,
        metadata: Value,
    ) -> Result<CheckpointPublish> {
        let result = self.publish_moving_inner(
            qcow2_path,
            memory_state_path,
            seed_disk_path,
            stage_index,
            metadata,
        );
        self.remove_reservation();
        match result {
            Ok(PublishOutcome::Stored(entry) | PublishOutcome::Existing(entry)) => {
                let entry_lock = self
                    ._entry_lock
                    .take()
                    .context("checkpoint writer lost its entry lock")?;
                Ok(CheckpointPublish::Stored(CheckpointLease {
                    entry,
                    _entry_lock: entry_lock,
                }))
            }
            Ok(PublishOutcome::Skipped) => {
                self.release_entry_lock()?;
                Ok(CheckpointPublish::Skipped)
            }
            Ok(PublishOutcome::RetentionUncertain) => {
                self.release_entry_lock()?;
                Ok(CheckpointPublish::RetentionUncertain)
            }
            Err(error) => match self.release_entry_lock() {
                Ok(()) => Err(error),
                Err(release_error) => Err(error.context(format!(
                    "also failed to release the checkpoint publication lock: {release_error:#}"
                ))),
            },
        }
    }

    fn publish_moving_inner(
        &mut self,
        qcow2_path: &Path,
        memory_state_path: &Path,
        seed_disk_path: &Path,
        stage_index: usize,
        metadata: Value,
    ) -> Result<PublishOutcome> {
        let staging = staging_entry_path(&self.config.root, &self.key)?;
        create_private_dir(&staging)?;
        if let Err(error) = sync_directory(&staging_root(&self.config.root)) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
        let mut moved_sources = MovedSources::default();
        let staged = (|| -> Result<(PayloadDigest, PayloadDigest, PayloadDigest)> {
            let (qcow2, moved_qcow2) =
                move_or_copy_payload(qcow2_path, &staging.join(ENTRY_FILE_QCOW2))?;
            moved_sources.push(moved_qcow2);
            let (memory_state, moved_memory) =
                move_or_copy_payload(memory_state_path, &staging.join(ENTRY_FILE_MEMORY))?;
            moved_sources.push(moved_memory);
            let seed_disk = copy_payload(seed_disk_path, &staging.join(ENTRY_FILE_SEED))?;
            Ok((qcow2, memory_state, seed_disk))
        })();
        let (qcow2, memory_state, seed_disk) = match staged {
            Ok(payloads) => payloads,
            Err(error) => return fail_publication(&mut moved_sources, &staging, None, error),
        };

        let logical_bytes = match checked_add(qcow2.logical_bytes, memory_state.logical_bytes)
            .and_then(|bytes| checked_add(bytes, seed_disk.logical_bytes))
        {
            Ok(bytes) => bytes,
            Err(error) => return fail_publication(&mut moved_sources, &staging, None, error),
        };
        let manifest = StoredCheckpointManifest {
            format: CACHE_FORMAT.to_string(),
            key: self.key.clone(),
            scope: self.scope.clone(),
            slot: self.slot,
            stage_index,
            metadata,
            qcow2,
            memory_state,
            seed_disk,
            logical_bytes,
        };
        let manifest_bytes = match serde_json::to_vec(&manifest)
            .context("failed to serialize checkpoint metadata")
        {
            Ok(bytes) => bytes,
            Err(error) => return fail_publication(&mut moved_sources, &staging, None, error),
        };
        if let Err(error) =
            atomic_write_private(&staging.join(ENTRY_FILE_METADATA), &manifest_bytes)
        {
            return fail_publication(&mut moved_sources, &staging, None, error);
        }
        let completion_bytes = match serde_json::to_vec(&StoredCheckpointCompletion {
            format: CACHE_FORMAT.to_string(),
            key: self.key.clone(),
            metadata_sha256: sha256_bytes(&manifest_bytes),
        })
        .context("failed to serialize checkpoint completion marker")
        {
            Ok(bytes) => bytes,
            Err(error) => return fail_publication(&mut moved_sources, &staging, None, error),
        };
        if let Err(error) =
            atomic_write_private(&staging.join(ENTRY_FILE_COMPLETE), &completion_bytes)
        {
            return fail_publication(&mut moved_sources, &staging, None, error);
        }
        if let Err(error) = sync_directory(&staging) {
            return fail_publication(&mut moved_sources, &staging, None, error);
        }
        let stored_bytes = match directory_stored_bytes(&staging) {
            Ok(bytes) => bytes,
            Err(error) => return fail_publication(&mut moved_sources, &staging, None, error),
        };

        let entry_path = entry_path(&self.config.root, &self.key);
        let mut entry_published = false;
        let publish_result = (|| -> Result<PublishOutcome> {
            let global_lock = open_global_lock(&self.config.root)?;
            global_lock
                .lock_exclusive()
                .context("failed to lock checkpoint cache for publication")?;
            prune_stale_reservations(&self.config.root, Some(&self.key))?;

            if entry_path.exists() {
                if let Some(entry) = load_entry(&self.config.root, &self.key, &self.scope) {
                    return Ok(PublishOutcome::Existing(entry));
                }
                fs::remove_dir_all(&entry_path).with_context(|| {
                    format!(
                        "failed to remove damaged checkpoint '{}'",
                        entry_path.display()
                    )
                })?;
                sync_directory(&entries_root(&self.config.root))?;
            }

            if stored_bytes > self.config.budget_bytes {
                return Ok(PublishOutcome::Skipped);
            }

            let reservations = read_reservations(&self.config.root)?;
            let Some(scope_commit) = prepare_scope_commit(
                &self.config.root,
                &self.scope,
                self.slot,
                &self.key,
                &self.parent_prefix,
                &reservations,
            )?
            else {
                return Ok(PublishOutcome::Skipped);
            };
            if !make_final_space(
                &self.config,
                &self.key,
                &self.reservation_path,
                stored_bytes,
                &scope_commit.protected_keys,
            )? {
                return Ok(PublishOutcome::Skipped);
            }

            fs::rename(&staging, &entry_path).with_context(|| {
                format!("failed to publish checkpoint '{}'", entry_path.display())
            })?;
            moved_sources.relocate(&entry_path);
            entry_published = true;
            sync_directory(&entries_root(&self.config.root))?;
            // This is the durable retention switch. Until this write
            // succeeds, the old index still names every old payload.
            if write_scope_index(&self.config.root, &scope_commit.index).is_err() {
                return Ok(PublishOutcome::RetentionUncertain);
            }
            // Old payloads are removed only after the new entry and role
            // index are durable. Their locks were acquired during planning.
            if remove_retiring_entries(&self.config.root, &scope_commit.retiring_entries).is_err() {
                return Ok(PublishOutcome::RetentionUncertain);
            }
            let entry = entry_from_manifest(&self.config.root, manifest, stored_bytes);
            // LRU data is separate from the immutable entry. A failed LRU
            // update must not turn a successfully fsynced checkpoint into a
            // failed build cache publication.
            let _ = touch_lru(&self.config.root, &self.key);
            Ok(PublishOutcome::Stored(entry))
        })();

        match publish_result {
            Ok(PublishOutcome::Stored(entry)) => {
                moved_sources.commit();
                Ok(PublishOutcome::Stored(entry))
            }
            Ok(PublishOutcome::Existing(entry)) => {
                discard_publication(&mut moved_sources, &staging, None)?;
                Ok(PublishOutcome::Existing(entry))
            }
            Ok(PublishOutcome::Skipped) => {
                discard_publication(&mut moved_sources, &staging, None)?;
                Ok(PublishOutcome::Skipped)
            }
            Ok(PublishOutcome::RetentionUncertain) => {
                // Preserve both payload directories. The next build must not
                // use a role whose durable index is uncertain.
                moved_sources.commit();
                Ok(PublishOutcome::RetentionUncertain)
            }
            Err(error) => fail_publication(
                &mut moved_sources,
                &staging,
                entry_published.then_some(&entry_path),
                error,
            ),
        }
    }

    fn remove_reservation(&self) {
        let _ = fs::remove_file(&self.reservation_path);
    }

    fn release_entry_lock(&mut self) -> Result<()> {
        let Some(entry_lock) = self._entry_lock.take() else {
            return Ok(());
        };
        FileExt::unlock(&entry_lock).context("failed to release checkpoint publication lock")
    }
}

impl Drop for CheckpointWriter {
    fn drop(&mut self) {
        self.remove_reservation();
        let _ = self.release_entry_lock();
    }
}

/// Persistent local cache for frozen QEMU build states.
#[derive(Clone)]
pub struct CheckpointCache {
    config: CheckpointCacheConfig,
}

impl CheckpointCache {
    /// Open a checkpoint cache and prepare its private local directories.
    ///
    /// # Errors
    /// Returns an error when the configured cache root cannot be prepared.
    pub fn new(config: CheckpointCacheConfig) -> Result<Self> {
        if config.use_cache {
            ensure!(
                config.budget_bytes > 0,
                "checkpoint cache budget_bytes must be greater than zero"
            );
            prepare_cache_root(&config.root)?;
        }
        Ok(Self { config })
    }

    /// Return a verified shared lease for a matching checkpoint, if present.
    ///
    /// A malformed manifest, wrong digest, missing payload, or unsafe file
    /// mode is a cache miss. It never prevents a cold build.
    pub fn restore(&self, identity: &CheckpointIdentity) -> Result<Option<CheckpointLease>> {
        if !self.config.use_cache {
            return Ok(None);
        }
        let key = identity.cache_key()?;
        let scope = identity.scope();

        let global_lock = open_global_lock(&self.config.root)?;
        global_lock
            .lock_shared()
            .context("failed to lock checkpoint cache for restore")?;
        if !load_scope_index(&self.config.root, &scope)
            .is_some_and(|index| index.retained_keys().contains(&key))
        {
            return Ok(None);
        }
        let entry_lock = open_entry_lock(&self.config.root, &key)?;
        match FileExt::try_lock_shared(&entry_lock) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) => {
                return Err(error).context("failed to lease checkpoint entry");
            }
        }
        drop(global_lock);
        let entry = load_entry(&self.config.root, &key, &scope);
        if entry.is_some() {
            // The shared entry lock prevents GC from deleting this entry while
            // its separate LRU sidecar is updated.
            let _ = touch_lru(&self.config.root, &key);
        }
        Ok(entry.map(|entry| CheckpointLease {
            entry,
            _entry_lock: entry_lock,
        }))
    }

    /// Reserve local space before QEMU creates a checkpoint.
    ///
    /// A `None` result means the cache is disabled, an equal entry already
    /// exists, an active lease blocks eviction, or the capacity floor cannot
    /// be respected. The caller must continue with the non-cached build.
    pub fn reserve(
        &self,
        identity: &CheckpointIdentity,
        slot: CheckpointSlot,
        expected_bytes: u64,
    ) -> Result<Option<CheckpointWriter>> {
        if !self.config.use_cache || expected_bytes == 0 {
            return Ok(None);
        }
        let key = identity.cache_key()?;
        let scope = identity.scope();
        let global_lock = open_global_lock(&self.config.root)?;
        global_lock
            .lock_exclusive()
            .context("failed to lock checkpoint cache reservation")?;
        prune_stale_reservations(&self.config.root, None)?;
        prune_unreferenced_entries(&self.config.root)?;
        let entry_lock = open_entry_lock(&self.config.root, &key)?;
        match FileExt::try_lock_exclusive(&entry_lock) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Ok(None);
            }
            Err(error) => {
                return Err(error).context("failed to lock checkpoint entry for publication");
            }
        }

        let existing_path = entry_path(&self.config.root, &key);
        if existing_path.exists() {
            if load_entry(&self.config.root, &key, &scope).is_some() {
                return Ok(None);
            }
            fs::remove_dir_all(&existing_path).with_context(|| {
                format!(
                    "failed to remove damaged checkpoint '{}'",
                    existing_path.display()
                )
            })?;
            sync_directory(&entries_root(&self.config.root))?;
        }

        let reservations = read_reservations(&self.config.root)?;
        if !can_reserve_scope_slot(&self.config.root, &scope, slot, &key, &reservations)? {
            return Ok(None);
        }
        if !make_reservation_space(&self.config, &key, None, expected_bytes)? {
            return Ok(None);
        }

        let reservation_path = reservation_path(&self.config.root, &key)?;
        write_reservation(
            &reservation_path,
            &Reservation {
                key: key.clone(),
                scope: scope.clone(),
                slot,
                bytes: expected_bytes,
            },
        )?;
        Ok(Some(CheckpointWriter {
            config: self.config.clone(),
            scope,
            key,
            parent_prefix: identity.parent_prefix.clone(),
            slot,
            reservation_path,
            _entry_lock: Some(entry_lock),
        }))
    }

    /// Remove a damaged or failed-to-restore cache entry.
    ///
    /// Drop any [`CheckpointLease`] first. Invalidation takes the entry's
    /// exclusive lock so it never deletes a checkpoint while QEMU reads it.
    pub fn invalidate(&self, identity: &CheckpointIdentity) -> Result<()> {
        if !self.config.use_cache {
            return Ok(());
        }
        let key = identity.cache_key()?;
        let global_lock = open_global_lock(&self.config.root)?;
        global_lock
            .lock_exclusive()
            .context("failed to lock checkpoint cache for invalidation")?;
        let entry_lock = open_entry_lock(&self.config.root, &key)?;
        match FileExt::try_lock_exclusive(&entry_lock) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(()),
            Err(error) => {
                return Err(error).context("failed to lock checkpoint entry for invalidation");
            }
        }
        let path = entry_path(&self.config.root, &key);
        if path.exists() {
            fs::remove_dir_all(&path)
                .with_context(|| format!("failed to remove checkpoint '{}'", path.display()))?;
            sync_directory(&entries_root(&self.config.root))?;
        }
        let lru = lru_path(&self.config.root, &key);
        if lru.exists() {
            fs::remove_file(&lru)
                .with_context(|| format!("failed to remove checkpoint LRU '{}'", lru.display()))?;
            sync_directory(&lru_root(&self.config.root))?;
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct StoredCheckpointManifest {
    format: String,
    key: String,
    scope: CheckpointScope,
    slot: CheckpointSlot,
    stage_index: usize,
    metadata: Value,
    qcow2: PayloadDigest,
    memory_state: PayloadDigest,
    seed_disk: PayloadDigest,
    logical_bytes: u64,
}

#[derive(Deserialize, Serialize)]
struct StoredCheckpointCompletion {
    format: String,
    key: String,
    metadata_sha256: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct PayloadDigest {
    logical_bytes: u64,
    digest: String,
}

#[derive(Deserialize, Serialize)]
struct Reservation {
    key: String,
    scope: CheckpointScope,
    slot: CheckpointSlot,
    /// Physical capacity held for a checkpoint that has not finished
    /// publication. Completed entries, not this value, use the cache budget.
    bytes: u64,
}

struct ReservationRecord {
    path: PathBuf,
    value: Reservation,
}

struct EntryRecord {
    key: String,
    path: PathBuf,
    stored_bytes: u64,
    lru: u128,
}

#[derive(Clone, Deserialize, Serialize)]
struct ScopeIndex {
    format: String,
    scope: CheckpointScope,
    before_last_step: Option<String>,
    expensive_prefix: Option<String>,
}

impl ScopeIndex {
    fn empty(scope: CheckpointScope) -> Self {
        Self {
            format: SCOPE_INDEX_FORMAT.to_string(),
            scope,
            before_last_step: None,
            expensive_prefix: None,
        }
    }

    fn role(&self, slot: CheckpointSlot) -> Option<&str> {
        match slot {
            CheckpointSlot::BeforeLastStep => self.before_last_step.as_deref(),
            CheckpointSlot::ExpensivePrefix => self.expensive_prefix.as_deref(),
        }
    }

    fn assign(&mut self, slot: CheckpointSlot, key: String) {
        match slot {
            CheckpointSlot::BeforeLastStep => self.before_last_step = Some(key),
            CheckpointSlot::ExpensivePrefix => self.expensive_prefix = Some(key),
        }
    }

    fn retained_keys(&self) -> HashSet<String> {
        [
            self.before_last_step.as_ref(),
            self.expensive_prefix.as_ref(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect()
    }
}

struct ScopeCommit {
    index: ScopeIndex,
    retiring_entries: Vec<RetiringEntry>,
    protected_keys: HashSet<String>,
    _retiring_locks: Vec<File>,
}

struct RetiringEntry {
    key: String,
    path: PathBuf,
}

enum PublishOutcome {
    Stored(CheckpointEntry),
    Existing(CheckpointEntry),
    Skipped,
    RetentionUncertain,
}

struct MovedPayload {
    source: PathBuf,
    current: PathBuf,
    moved: bool,
}

#[derive(Default)]
struct MovedSources {
    payloads: Vec<MovedPayload>,
    committed: bool,
}

impl MovedSources {
    fn push(&mut self, payload: MovedPayload) {
        self.payloads.push(payload);
    }

    fn relocate(&mut self, directory: &Path) {
        for payload in &mut self.payloads {
            let Some(name) = payload.current.file_name() else {
                continue;
            };
            payload.current = directory.join(name);
        }
    }

    fn rollback(&mut self) -> Result<()> {
        for payload in self.payloads.iter_mut().rev() {
            rollback_moved_payload(payload)?;
        }
        Ok(())
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for MovedSources {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.rollback();
        }
    }
}

fn require_non_empty(name: &str, value: &str) -> Result<()> {
    ensure!(!value.trim().is_empty(), "checkpoint {name} is required");
    Ok(())
}

fn usize_to_u64(value: usize) -> [u8; 8] {
    u64::try_from(value).unwrap_or(u64::MAX).to_le_bytes()
}

fn prepare_cache_root(root: &Path) -> Result<()> {
    create_private_dir(root)?;
    for path in [
        entries_root(root),
        scopes_root(root),
        locks_root(root),
        lru_root(root),
        reservations_root(root),
        staging_root(root),
    ] {
        create_private_dir(&path)?;
    }
    let global_lock = open_private_file(&root.join(GLOBAL_LOCK_FILE))?;
    global_lock
        .sync_all()
        .context("failed to sync checkpoint cache lock")?;
    global_lock
        .lock_exclusive()
        .context("failed to lock checkpoint cache cleanup")?;
    prune_stale_staging(root)?;
    prune_stale_reservations(root, None)?;
    prune_unreferenced_entries(root)?;
    sync_directory(root)
}

fn entries_root(root: &Path) -> PathBuf {
    root.join(ENTRIES_DIR)
}

fn scopes_root(root: &Path) -> PathBuf {
    root.join(SCOPES_DIR)
}

fn scope_index_key(scope: &CheckpointScope) -> String {
    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "format", SCOPE_INDEX_FORMAT.as_bytes());
    hash_field(&mut hasher, "scenario_id", scope.scenario_id.as_bytes());
    hash_field(&mut hasher, "vm_name", scope.vm_name.as_bytes());
    hex_digest(hasher.finalize())
}

fn scope_index_path(root: &Path, scope: &CheckpointScope) -> PathBuf {
    scopes_root(root).join(format!("{}.json", scope_index_key(scope)))
}

fn load_scope_index(root: &Path, scope: &CheckpointScope) -> Option<ScopeIndex> {
    let path = scope_index_path(root, scope);
    if !is_private_regular_file(&path) {
        return None;
    }
    let index = serde_json::from_slice::<ScopeIndex>(&fs::read(path).ok()?).ok()?;
    if index.format != SCOPE_INDEX_FORMAT
        || index.scope != *scope
        || [
            index.before_last_step.as_deref(),
            index.expensive_prefix.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|key| !is_cache_key(key))
    {
        return None;
    }
    Some(index)
}

fn current_scope_index(root: &Path, scope: &CheckpointScope) -> ScopeIndex {
    let mut index =
        load_scope_index(root, scope).unwrap_or_else(|| ScopeIndex::empty(scope.clone()));
    if index
        .before_last_step
        .as_ref()
        .is_some_and(|key| !entry_path(root, key).is_dir())
    {
        index.before_last_step = None;
    }
    if index
        .expensive_prefix
        .as_ref()
        .is_some_and(|key| !entry_path(root, key).is_dir())
    {
        index.expensive_prefix = None;
    }
    index
}

fn write_scope_index(root: &Path, index: &ScopeIndex) -> Result<()> {
    #[cfg(test)]
    if FAIL_SCOPE_INDEX_WRITE.with(|fail| fail.replace(false)) {
        bail!("injected checkpoint scope index write failure");
    }
    let bytes = serde_json::to_vec(index).context("failed to serialize checkpoint scope index")?;
    atomic_write_private(&scope_index_path(root, &index.scope), &bytes)
}

#[cfg(test)]
fn fail_next_scope_index_write() {
    FAIL_SCOPE_INDEX_WRITE.with(|fail| fail.set(true));
}

fn locks_root(root: &Path) -> PathBuf {
    root.join(LOCKS_DIR)
}

fn lru_root(root: &Path) -> PathBuf {
    root.join(LRU_DIR)
}

fn reservations_root(root: &Path) -> PathBuf {
    root.join(RESERVATIONS_DIR)
}

fn staging_root(root: &Path) -> PathBuf {
    root.join(STAGING_DIR)
}

fn entry_path(root: &Path, key: &str) -> PathBuf {
    entries_root(root).join(key)
}

fn entry_lock_path(root: &Path, key: &str) -> PathBuf {
    locks_root(root).join(format!("{key}.lock"))
}

fn lru_path(root: &Path, key: &str) -> PathBuf {
    lru_root(root).join(key)
}

fn reservation_path(root: &Path, key: &str) -> Result<PathBuf> {
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let name = format!("{key}-{}-{suffix}.json", std::process::id());
    Ok(reservations_root(root).join(name))
}

fn staging_entry_path(root: &Path, key: &str) -> Result<PathBuf> {
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    Ok(staging_root(root).join(format!(".{key}-{}-{suffix}", std::process::id())))
}

fn open_global_lock(root: &Path) -> Result<File> {
    open_private_file(&root.join(GLOBAL_LOCK_FILE))
}

fn open_entry_lock(root: &Path, key: &str) -> Result<File> {
    open_private_file(&entry_lock_path(root, key))
}

fn create_private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)
        .with_context(|| format!("failed to create checkpoint directory '{}'", path.display()))?;
    set_private_directory_permissions(path)?;
    Ok(())
}

fn open_private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(path)
        .with_context(|| format!("failed to open checkpoint file '{}'", path.display()))?;
    set_private_file_permissions(path)?;
    Ok(file)
}

fn set_private_directory_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| {
            format!(
                "failed to restrict checkpoint directory '{}'",
                path.display()
            )
        })?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .with_context(|| format!("failed to restrict checkpoint file '{}'", path.display()))?;
    }
    Ok(())
}

fn is_private(path: &Path) -> bool {
    #[cfg(unix)]
    {
        fs::symlink_metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o077 == 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.exists()
    }
}

fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)
        .with_context(|| format!("failed to open checkpoint directory '{}'", path.display()))?
        .sync_all()
        .with_context(|| format!("failed to sync checkpoint directory '{}'", path.display()))
}

fn atomic_write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .context("checkpoint file has no parent directory")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .context("checkpoint file has no UTF-8 file name")?;
    let suffix = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(".{file_name}.tmp-{}-{suffix}", std::process::id()));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temporary).with_context(|| {
            format!(
                "failed to create checkpoint temporary '{}'",
                temporary.display()
            )
        })?;
        file.write_all(bytes).with_context(|| {
            format!(
                "failed to write checkpoint temporary '{}'",
                temporary.display()
            )
        })?;
        file.sync_all().with_context(|| {
            format!(
                "failed to sync checkpoint temporary '{}'",
                temporary.display()
            )
        })?;
        drop(file);
        fs::rename(&temporary, path)
            .with_context(|| format!("failed to publish checkpoint file '{}'", path.display()))?;
        sync_directory(parent)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn move_or_copy_payload(
    source: &Path,
    destination: &Path,
) -> Result<(PayloadDigest, MovedPayload)> {
    let source_metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat checkpoint source '{}'", source.display()))?;
    ensure!(
        source_metadata.file_type().is_file() && source_metadata.len() > 0,
        "checkpoint source '{}' is not a non-empty regular file",
        source.display()
    );
    match fs::rename(source, destination) {
        Ok(()) => {
            let mut payload = MovedPayload {
                source: source.to_path_buf(),
                current: destination.to_path_buf(),
                moved: true,
            };
            let digest = moved_payload_digest(&source_metadata, destination);
            match digest {
                Ok(digest) => Ok((digest, payload)),
                Err(error) => match rollback_moved_payload(&mut payload) {
                    Ok(()) => Err(error),
                    Err(rollback_error) => Err(error.context(format!(
                        "also failed to return checkpoint payload to its source: {rollback_error:#}"
                    ))),
                },
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
            let digest = copy_payload(source, destination)?;
            Ok((
                digest,
                MovedPayload {
                    source: source.to_path_buf(),
                    current: destination.to_path_buf(),
                    moved: false,
                },
            ))
        }
        Err(error) => Err(error).with_context(|| {
            format!(
                "failed to move checkpoint payload '{}' to '{}'",
                source.display(),
                destination.display()
            )
        }),
    }
}

fn moved_payload_digest(
    source_metadata: &fs::Metadata,
    destination: &Path,
) -> Result<PayloadDigest> {
    set_private_file_permissions(destination)?;
    let destination_file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(destination)
        .with_context(|| {
            format!(
                "failed to reopen moved checkpoint payload '{}'",
                destination.display()
            )
        })?;
    destination_file.sync_all().with_context(|| {
        format!(
            "failed to sync moved checkpoint payload '{}'",
            destination.display()
        )
    })?;
    let moved_metadata = fs::symlink_metadata(destination).with_context(|| {
        format!(
            "failed to stat moved checkpoint payload '{}'",
            destination.display()
        )
    })?;
    ensure!(
        moved_metadata.file_type().is_file() && moved_metadata.len() == source_metadata.len(),
        "checkpoint payload '{}' changed while it was moved",
        destination.display()
    );
    Ok(PayloadDigest {
        logical_bytes: moved_metadata.len(),
        digest: payload_digest(destination)?,
    })
}

fn rollback_moved_payload(payload: &mut MovedPayload) -> Result<()> {
    if !payload.moved {
        return Ok(());
    }
    ensure!(
        !payload.source.exists(),
        "cannot restore checkpoint source '{}': path already exists",
        payload.source.display()
    );
    fs::rename(&payload.current, &payload.source).with_context(|| {
        format!(
            "failed to return checkpoint payload '{}' to '{}'",
            payload.current.display(),
            payload.source.display()
        )
    })?;
    let parent = payload
        .source
        .parent()
        .context("checkpoint source has no parent directory")?;
    sync_directory(parent)?;
    payload.moved = false;
    Ok(())
}

fn discard_publication(
    moved_sources: &mut MovedSources,
    staging: &Path,
    published_entry: Option<&Path>,
) -> Result<()> {
    moved_sources.rollback()?;
    let path = published_entry.unwrap_or(staging);
    if path.exists() {
        fs::remove_dir_all(path).with_context(|| {
            format!("failed to discard checkpoint staging '{}'", path.display())
        })?;
        let parent = path
            .parent()
            .context("checkpoint staging path has no parent directory")?;
        sync_directory(parent)?;
    }
    Ok(())
}

fn fail_publication<T>(
    moved_sources: &mut MovedSources,
    staging: &Path,
    published_entry: Option<&Path>,
    error: anyhow::Error,
) -> Result<T> {
    match discard_publication(moved_sources, staging, published_entry) {
        Ok(()) => Err(error),
        Err(rollback_error) => Err(error.context(format!(
            "also failed to restore the local checkpoint snapshot: {rollback_error:#}"
        ))),
    }
}

fn copy_payload(source: &Path, destination: &Path) -> Result<PayloadDigest> {
    let source_metadata = fs::symlink_metadata(source)
        .with_context(|| format!("failed to stat checkpoint source '{}'", source.display()))?;
    ensure!(
        source_metadata.file_type().is_file() && source_metadata.len() > 0,
        "checkpoint source '{}' is not a non-empty regular file",
        source.display()
    );
    let result = (|| -> Result<PayloadDigest> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let destination_file = options.open(destination).with_context(|| {
            format!(
                "failed to create checkpoint payload '{}'",
                destination.display()
            )
        })?;
        drop(destination_file);
        fs::copy(source, destination).with_context(|| {
            format!(
                "failed to copy checkpoint payload '{}' to '{}'",
                source.display(),
                destination.display()
            )
        })?;
        set_private_file_permissions(destination)?;
        let destination_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(destination)
            .with_context(|| {
                format!(
                    "failed to reopen checkpoint payload '{}'",
                    destination.display()
                )
            })?;
        destination_file.sync_all().with_context(|| {
            format!(
                "failed to sync checkpoint payload '{}'",
                destination.display()
            )
        })?;
        let copied_metadata = fs::symlink_metadata(destination).with_context(|| {
            format!(
                "failed to stat copied checkpoint payload '{}'",
                destination.display()
            )
        })?;
        ensure!(
            copied_metadata.file_type().is_file() && copied_metadata.len() == source_metadata.len(),
            "checkpoint payload '{}' changed while it was copied",
            source.display()
        );
        Ok(PayloadDigest {
            logical_bytes: copied_metadata.len(),
            digest: payload_digest(destination)?,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(destination);
    }
    result
}

fn payload_digest(path: &Path) -> Result<String> {
    let mut file = File::open(path)
        .with_context(|| format!("failed to open checkpoint payload '{}'", path.display()))?;
    let mut hasher = blake3::Hasher::new();
    hasher
        .update_reader(&mut file)
        .with_context(|| format!("failed to read checkpoint payload '{}'", path.display()))?;
    Ok(hasher.finalize().to_hex().to_string())
}

fn directory_stored_bytes(path: &Path) -> Result<u64> {
    let mut total = 0_u64;
    for entry in fs::read_dir(path)
        .with_context(|| format!("failed to read checkpoint directory '{}'", path.display()))?
    {
        let entry = entry
            .with_context(|| format!("failed to read checkpoint directory '{}'", path.display()))?;
        let file_type = entry.file_type().with_context(|| {
            format!(
                "failed to stat checkpoint path '{}'",
                entry.path().display()
            )
        })?;
        if file_type.is_file() {
            total = checked_add(
                total,
                stored_bytes_for_metadata(&entry.metadata().with_context(|| {
                    format!(
                        "failed to stat checkpoint file '{}'",
                        entry.path().display()
                    )
                })?),
            )?;
        } else if file_type.is_dir() {
            total = checked_add(total, directory_stored_bytes(&entry.path())?)?;
        } else {
            bail!(
                "checkpoint path '{}' is not regular",
                entry.path().display()
            );
        }
    }
    Ok(total)
}

fn stored_bytes_for_metadata(metadata: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        let allocated = metadata.blocks().saturating_mul(512);
        if allocated == 0 {
            metadata.len()
        } else {
            allocated
        }
    }
    #[cfg(not(unix))]
    {
        metadata.len()
    }
}

fn checked_add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .context("checkpoint cache byte count overflow")
}

fn load_entry(root: &Path, key: &str, scope: &CheckpointScope) -> Option<CheckpointEntry> {
    let path = entry_path(root, key);
    if !is_private_directory(&path) {
        return None;
    }
    let metadata_path = path.join(ENTRY_FILE_METADATA);
    let completion_path = path.join(ENTRY_FILE_COMPLETE);
    if !is_private_regular_file(&metadata_path) || !is_private_regular_file(&completion_path) {
        return None;
    }
    let manifest_bytes = fs::read(&metadata_path).ok()?;
    let completion =
        serde_json::from_slice::<StoredCheckpointCompletion>(&fs::read(&completion_path).ok()?)
            .ok()?;
    if completion.format != CACHE_FORMAT
        || completion.key != key
        || completion.metadata_sha256 != sha256_bytes(&manifest_bytes)
    {
        return None;
    }
    let manifest = serde_json::from_slice::<StoredCheckpointManifest>(&manifest_bytes).ok()?;
    if manifest.format != CACHE_FORMAT || manifest.key != key || manifest.scope != *scope {
        return None;
    }
    let logical_bytes = manifest
        .qcow2
        .logical_bytes
        .checked_add(manifest.memory_state.logical_bytes)?
        .checked_add(manifest.seed_disk.logical_bytes)?;
    if logical_bytes != manifest.logical_bytes
        || !validate_payload(&path.join(ENTRY_FILE_QCOW2), &manifest.qcow2)
        || !validate_payload(&path.join(ENTRY_FILE_MEMORY), &manifest.memory_state)
        || !validate_payload(&path.join(ENTRY_FILE_SEED), &manifest.seed_disk)
    {
        return None;
    }
    let stored_bytes = directory_stored_bytes(&path).ok()?;
    Some(entry_from_manifest(root, manifest, stored_bytes))
}

fn validate_payload(path: &Path, expected: &PayloadDigest) -> bool {
    if expected.logical_bytes == 0
        || expected.digest.len() != 64
        || !expected.digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !is_private(path)
    {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() || metadata.len() != expected.logical_bytes {
        return false;
    }
    payload_digest(path)
        .map(|digest| digest.eq_ignore_ascii_case(&expected.digest))
        .unwrap_or(false)
}

fn is_private_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_dir() && is_private_metadata(&metadata))
        .unwrap_or(false)
}

fn is_private_regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file() && is_private_metadata(&metadata))
        .unwrap_or(false)
}

fn is_private_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        metadata.permissions().mode() & 0o077 == 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

fn entry_from_manifest(
    root: &Path,
    manifest: StoredCheckpointManifest,
    stored_bytes: u64,
) -> CheckpointEntry {
    let path = entry_path(root, &manifest.key);
    CheckpointEntry {
        key: manifest.key,
        stage_index: manifest.stage_index,
        qcow2_path: path.join(ENTRY_FILE_QCOW2),
        memory_state_path: path.join(ENTRY_FILE_MEMORY),
        seed_disk_path: path.join(ENTRY_FILE_SEED),
        metadata: manifest.metadata,
        stored_bytes,
    }
}

fn write_reservation(path: &Path, reservation: &Reservation) -> Result<()> {
    let bytes =
        serde_json::to_vec(reservation).context("failed to serialize checkpoint reservation")?;
    atomic_write_private(path, &bytes)
}

fn read_reservations(root: &Path) -> Result<Vec<ReservationRecord>> {
    let mut reservations = Vec::new();
    for entry in fs::read_dir(reservations_root(root)).with_context(|| {
        format!(
            "failed to read checkpoint reservations '{}'",
            reservations_root(root).display()
        )
    })? {
        let entry = entry.context("failed to read checkpoint reservation")?;
        if !entry
            .file_type()
            .context("failed to stat checkpoint reservation")?
            .is_file()
        {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Reservation>(&bytes) else {
            continue;
        };
        if !is_cache_key(&value.key) {
            continue;
        }
        reservations.push(ReservationRecord {
            path: entry.path(),
            value,
        });
    }
    Ok(reservations)
}

fn prune_stale_reservations(root: &Path, protected_key: Option<&str>) -> Result<()> {
    for record in read_reservations(root)? {
        if protected_key == Some(record.value.key.as_str()) {
            continue;
        }
        let lock = open_entry_lock(root, &record.value.key)?;
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => {
                let _ = fs::remove_file(&record.path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to inspect checkpoint reservation '{}'",
                        record.path.display()
                    )
                });
            }
        }
    }
    Ok(())
}

fn prune_stale_staging(root: &Path) -> Result<()> {
    let staging = staging_root(root);
    let mut changed = false;
    for entry in fs::read_dir(&staging)
        .with_context(|| format!("failed to read checkpoint staging '{}'", staging.display()))?
    {
        let entry = entry.context("failed to read checkpoint staging entry")?;
        if !entry
            .file_type()
            .context("failed to stat checkpoint staging entry")?
            .is_dir()
        {
            continue;
        }
        let file_name = entry.file_name();
        let Some(key) = staging_key(&file_name) else {
            continue;
        };
        let lock = open_entry_lock(root, key)?;
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => {
                fs::remove_dir_all(entry.path()).with_context(|| {
                    format!(
                        "failed to remove stale checkpoint staging '{}'",
                        entry.path().display()
                    )
                })?;
                changed = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => {
                return Err(error).with_context(|| {
                    format!(
                        "failed to inspect checkpoint staging '{}'",
                        entry.path().display()
                    )
                });
            }
        }
    }
    if changed {
        sync_directory(&staging)?;
    }
    Ok(())
}

fn staging_key(name: &std::ffi::OsStr) -> Option<&str> {
    let name = name.to_str()?;
    let remainder = name.strip_prefix('.')?;
    let key = remainder.get(..64)?;
    (is_cache_key(key) && remainder.as_bytes().get(64) == Some(&b'-')).then_some(key)
}

fn is_cache_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn can_reserve_scope_slot(
    root: &Path,
    scope: &CheckpointScope,
    requested_slot: CheckpointSlot,
    excluded_key: &str,
    reservations: &[ReservationRecord],
) -> Result<bool> {
    let active = reservations
        .iter()
        .filter(|reservation| {
            reservation.value.key != excluded_key && reservation.value.scope == *scope
        })
        .collect::<Vec<_>>();
    if active
        .iter()
        .any(|reservation| reservation.value.slot == requested_slot)
    {
        return Ok(false);
    }

    let index = current_scope_index(root, scope);
    // A completed entry in the requested role is a replacement target. Keep
    // it readable through capture, then switch the role only at publication.
    if index
        .role(requested_slot)
        .is_some_and(|key| key != excluded_key)
    {
        return Ok(true);
    }
    Ok(index.retained_keys().len().saturating_add(active.len()) < 2)
}

fn prepare_scope_commit(
    root: &Path,
    scope: &CheckpointScope,
    requested_slot: CheckpointSlot,
    new_key: &str,
    parent_prefix: &str,
    reservations: &[ReservationRecord],
) -> Result<Option<ScopeCommit>> {
    let active = reservations
        .iter()
        .filter(|reservation| reservation.value.key != new_key && reservation.value.scope == *scope)
        .collect::<Vec<_>>();
    if active
        .iter()
        .any(|reservation| reservation.value.slot == requested_slot)
    {
        return Ok(None);
    }

    let current = current_scope_index(root, scope);
    let mut next = current.clone();
    if requested_slot == CheckpointSlot::ExpensivePrefix
        && is_cache_key(parent_prefix)
        && parent_prefix != new_key
        && load_entry(root, parent_prefix, scope).is_some()
    {
        // An appended final step turns its immediate parent from the final
        // expensive prefix into the before-last boundary without touching its
        // immutable payload metadata.
        next.assign(CheckpointSlot::BeforeLastStep, parent_prefix.to_string());
    }
    next.assign(requested_slot, new_key.to_string());

    let current_keys = current.retained_keys();
    let next_keys = next.retained_keys();
    if next_keys.len().saturating_add(active.len()) > 2 {
        return Ok(None);
    }
    let retiring_keys = current_keys
        .difference(&next_keys)
        .cloned()
        .collect::<Vec<_>>();
    let mut retiring_entries = Vec::new();
    let mut retiring_locks = Vec::new();
    for key in retiring_keys {
        let path = entry_path(root, &key);
        if !path.is_dir() {
            continue;
        }
        let lock = open_entry_lock(root, &key)?;
        match FileExt::try_lock_exclusive(&lock) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(None),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to lock checkpoint entry '{key}' for role replacement")
                });
            }
        }
        retiring_entries.push(RetiringEntry {
            key: key.clone(),
            path,
        });
        retiring_locks.push(lock);
    }
    Ok(Some(ScopeCommit {
        index: next,
        retiring_entries,
        protected_keys: current_keys.union(&next_keys).cloned().collect(),
        _retiring_locks: retiring_locks,
    }))
}

fn make_reservation_space(
    config: &CheckpointCacheConfig,
    excluded_key: &str,
    excluded_reservation: Option<&Path>,
    required_bytes: u64,
) -> Result<bool> {
    let protected = HashSet::new();
    loop {
        let entries_bytes = entries_stored_bytes(&config.root)?;
        let reservations_bytes = reservation_bytes(&config.root, excluded_reservation)?;
        // A reservation is a promise of future physical space. It must not
        // evict completed cache entries merely because its worst case is
        // larger than the eventual compressed checkpoint.
        let within_budget = entries_bytes <= config.budget_bytes;
        let free_needed = config
            .minimum_free_bytes
            .saturating_add(reservations_bytes)
            .saturating_add(required_bytes);
        let within_free_floor = fs2::available_space(&config.root)
            .map(|free| free >= free_needed)
            .unwrap_or(false);
        if within_budget && within_free_floor {
            return Ok(true);
        }
        if !evict_one_lru(&config.root, excluded_key, &protected)? {
            return Ok(false);
        }
    }
}

fn make_final_space(
    config: &CheckpointCacheConfig,
    excluded_key: &str,
    excluded_reservation: &Path,
    staging_bytes: u64,
    protected_keys: &HashSet<String>,
) -> Result<bool> {
    // An entry larger than the whole cache can never publish. Do not evict
    // useful entries for a checkpoint that will be skipped.
    if staging_bytes > config.budget_bytes {
        return Ok(false);
    }
    loop {
        let entries_bytes = entries_stored_bytes(&config.root)?;
        let reservations_bytes = reservation_bytes(&config.root, Some(excluded_reservation))?;
        // Retiring entries remain on disk until the new entry and its role
        // index are durable, so admission includes their physical bytes.
        let within_budget = entries_bytes
            .checked_add(staging_bytes)
            .is_some_and(|value| value <= config.budget_bytes);
        // The current staging directory already consumes physical space. The
        // other reservations still need their worst-case headroom.
        let within_free_floor = fs2::available_space(&config.root)
            .map(|free| free >= config.minimum_free_bytes.saturating_add(reservations_bytes))
            .unwrap_or(false);
        if within_budget && within_free_floor {
            return Ok(true);
        }
        if !evict_one_lru(&config.root, excluded_key, protected_keys)? {
            return Ok(false);
        }
    }
}

fn entries_stored_bytes(root: &Path) -> Result<u64> {
    // Count malformed entries too. They still consume local disk and must
    // never let the cache claim it is below its committed-byte budget.
    let mut total = 0_u64;
    for entry in entry_records(root)? {
        total = total.saturating_add(entry.stored_bytes);
    }
    Ok(total)
}

fn reservation_bytes(root: &Path, excluded: Option<&Path>) -> Result<u64> {
    read_reservations(root)?
        .into_iter()
        .try_fold(0_u64, |total, record| {
            if excluded.is_some_and(|path| record.path == path) {
                Ok(total)
            } else {
                Ok(total.saturating_add(record.value.bytes))
            }
        })
}

fn entry_records(root: &Path) -> Result<Vec<EntryRecord>> {
    let mut records = Vec::new();
    for entry in fs::read_dir(entries_root(root)).with_context(|| {
        format!(
            "failed to read checkpoint entries '{}'",
            entries_root(root).display()
        )
    })? {
        let entry = entry.context("failed to read checkpoint entry")?;
        let file_type = entry
            .file_type()
            .context("failed to stat checkpoint entry")?;
        if !file_type.is_dir() {
            continue;
        }
        let Some(key) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            continue;
        };
        if !is_cache_key(&key) {
            continue;
        }
        let stored_bytes = directory_stored_bytes(&entry.path()).unwrap_or(u64::MAX);
        records.push(EntryRecord {
            key: key.clone(),
            path: entry.path(),
            stored_bytes,
            lru: read_lru(root, &key),
        });
    }
    Ok(records)
}

fn referenced_entry_keys(root: &Path) -> Result<HashSet<String>> {
    let mut keys = HashSet::new();
    for entry in fs::read_dir(scopes_root(root)).with_context(|| {
        format!(
            "failed to read checkpoint scope indexes '{}'",
            scopes_root(root).display()
        )
    })? {
        let entry = entry.context("failed to read checkpoint scope index")?;
        if !entry
            .file_type()
            .context("failed to stat checkpoint scope index")?
            .is_file()
            || !is_private_regular_file(&entry.path())
        {
            continue;
        }
        let bytes = fs::read(entry.path()).context("failed to read checkpoint scope index")?;
        let index = serde_json::from_slice::<ScopeIndex>(&bytes)
            .context("invalid checkpoint scope index")?;
        if index.format != SCOPE_INDEX_FORMAT
            || [
                index.before_last_step.as_deref(),
                index.expensive_prefix.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|key| !is_cache_key(key))
        {
            bail!("invalid checkpoint scope index");
        }
        keys.extend(index.retained_keys());
    }
    Ok(keys)
}

fn prune_unreferenced_entries(root: &Path) -> Result<()> {
    let referenced = referenced_entry_keys(root)?;
    for record in entry_records(root)? {
        if referenced.contains(&record.key) {
            continue;
        }
        let _ = remove_entry_if_unleased(root, &record)?;
    }
    Ok(())
}

fn read_lru(root: &Path, key: &str) -> u128 {
    fs::read_to_string(lru_path(root, key))
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0)
}

fn touch_lru(root: &Path, key: &str) -> Result<()> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    atomic_write_private(&lru_path(root, key), timestamp.to_string().as_bytes())
}

fn evict_one_lru(
    root: &Path,
    excluded_key: &str,
    protected_keys: &HashSet<String>,
) -> Result<bool> {
    let referenced = referenced_entry_keys(root)?;
    let mut candidates = entry_records(root)?
        .into_iter()
        .filter(|entry| entry.key != excluded_key && !protected_keys.contains(&entry.key))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        referenced
            .contains(&left.key)
            .cmp(&referenced.contains(&right.key))
            .then_with(|| left.lru.cmp(&right.lru))
            .then_with(|| left.key.cmp(&right.key))
    });
    for candidate in candidates {
        if remove_entry_if_unleased(root, &candidate)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn remove_entry_if_unleased(root: &Path, record: &EntryRecord) -> Result<bool> {
    let entry_lock = open_entry_lock(root, &record.key)?;
    match FileExt::try_lock_exclusive(&entry_lock) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to lock checkpoint entry '{}' for eviction",
                    record.key
                )
            });
        }
    }
    if record.path.exists() {
        fs::remove_dir_all(&record.path)
            .with_context(|| format!("failed to evict checkpoint '{}'", record.path.display()))?;
        sync_directory(&entries_root(root))?;
    }
    let lru = lru_path(root, &record.key);
    if lru.exists() {
        fs::remove_file(&lru)
            .with_context(|| format!("failed to remove checkpoint LRU '{}'", lru.display()))?;
        sync_directory(&lru_root(root))?;
    }
    Ok(true)
}

fn remove_retiring_entries(root: &Path, entries: &[RetiringEntry]) -> Result<()> {
    let mut entries_changed = false;
    let mut lru_changed = false;
    for entry in entries {
        if entry.path.exists() {
            fs::remove_dir_all(&entry.path).with_context(|| {
                format!("failed to retire checkpoint '{}'", entry.path.display())
            })?;
            entries_changed = true;
        }
        let lru = lru_path(root, &entry.key);
        if lru.exists() {
            fs::remove_file(&lru)
                .with_context(|| format!("failed to remove checkpoint LRU '{}'", lru.display()))?;
            lru_changed = true;
        }
    }
    if entries_changed {
        sync_directory(&entries_root(root))?;
    }
    if lru_changed {
        sync_directory(&lru_root(root))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Path, PathBuf};

    use serde_json::json;
    use sha2::{Digest as _, Sha256};

    use super::{
        CheckpointCache, CheckpointCacheConfig, CheckpointIdentity, CheckpointLease,
        CheckpointPublish, CheckpointSlot, ENTRY_FILE_COMPLETE, ENTRY_FILE_MEMORY,
        ENTRY_FILE_METADATA, ENTRY_FILE_QCOW2, ENTRY_FILE_SEED, MovedSources, ScopeIndex,
        create_private_dir, current_scope_index, entries_stored_bytes, entry_path,
        fail_next_scope_index_write, fail_publication, hash_field, hex_digest,
        move_or_copy_payload, payload_digest, referenced_entry_keys, scope_index_path,
        sha256_bytes,
    };

    fn identity(stage: &[u8]) -> CheckpointIdentity {
        CheckpointIdentity {
            scenario_id: "broken-nginx".to_string(),
            vm_name: "main".to_string(),
            parent_prefix: "base-prefix".to_string(),
            stage_bytes: stage.to_vec(),
            base_sha256: "b".repeat(64),
            kernel_sha256: "c".repeat(64),
            initrd_sha256: "d".repeat(64),
            disk_geometry_bytes: 2 * 1024 * 1024 * 1024,
            qemu_version: "QEMU 10.0".to_string(),
            qemu_cpu: "host".to_string(),
            qemu_devices: vec!["virtio-blk-pci".to_string(), "virtio-net-pci".to_string()],
            provisioning_abi: "intar-build-v1".to_string(),
        }
    }

    fn cache(root: &Path, budget_bytes: u64) -> CheckpointCache {
        CheckpointCache::new(CheckpointCacheConfig {
            root: root.to_path_buf(),
            use_cache: true,
            budget_bytes,
            minimum_free_bytes: 0,
        })
        .unwrap()
    }

    fn stored(publication: CheckpointPublish) -> CheckpointLease {
        match publication {
            CheckpointPublish::Stored(lease) => lease,
            CheckpointPublish::Skipped => panic!("checkpoint publication was skipped"),
            CheckpointPublish::RetentionUncertain => {
                panic!("checkpoint publication has an uncertain role index")
            }
        }
    }

    fn payloads(root: &Path, label: &str, bytes: usize) -> (PathBuf, PathBuf, PathBuf) {
        let qcow2 = root.join(format!("{label}.qcow2"));
        let memory = root.join(format!("{label}.memory"));
        let seed = root.join(format!("{label}.seed"));
        fs::write(&qcow2, vec![b'q'; bytes]).unwrap();
        fs::write(&memory, vec![b'm'; bytes]).unwrap();
        fs::write(&seed, vec![b's'; bytes]).unwrap();
        (qcow2, memory, seed)
    }

    fn publish(
        cache: &CheckpointCache,
        identity: &CheckpointIdentity,
        slot: CheckpointSlot,
        root: &Path,
        label: &str,
    ) {
        let (qcow2, memory, seed) = payloads(root, label, 32 * 1024);
        let expected = 3 * 64 * 1024;
        let writer = cache.reserve(identity, slot, expected).unwrap().unwrap();
        let lease = stored(
            writer
                .publish_moving(
                    &qcow2,
                    &memory,
                    &seed,
                    2,
                    json!({"bootstrap_private_key": "private-builder-key"}),
                )
                .unwrap(),
        );
        assert_eq!(lease.entry.stage_index, 2);
        assert_eq!(
            lease.entry.metadata["bootstrap_private_key"],
            "private-builder-key"
        );
    }

    #[test]
    fn key_uses_only_completed_prefix_inputs() {
        let earlier = identity(b"step-0 exact bytes");
        let key_before_a_later_step_edit = earlier.cache_key().unwrap();
        let key_after_a_later_step_edit = earlier.cache_key().unwrap();
        assert_eq!(key_before_a_later_step_edit, key_after_a_later_step_edit);

        let changed_stage = identity(b"step-0 changed bytes");
        assert_ne!(
            key_before_a_later_step_edit,
            changed_stage.cache_key().unwrap()
        );
    }

    #[test]
    fn shared_hash_helpers_keep_the_checkpoint_wire_format() {
        let mut hasher = Sha256::new();
        hash_field(&mut hasher, "field", b"value");
        assert_eq!(
            hex_digest(hasher.finalize()),
            "12b4d850e072c0d26a95b2e8192430e5464fb87cfe622820587f146dbae60b9c"
        );
        assert_eq!(
            sha256_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn duplicate_scope_roles_retain_one_payload() {
        let scope = identity(b"packages").scope();
        let key = "a".repeat(64);
        let mut index = ScopeIndex::empty(scope);
        index.assign(CheckpointSlot::BeforeLastStep, key.clone());
        index.assign(CheckpointSlot::ExpensivePrefix, key.clone());

        assert_eq!(
            index.role(CheckpointSlot::BeforeLastStep),
            Some(key.as_str())
        );
        assert_eq!(
            index.role(CheckpointSlot::ExpensivePrefix),
            Some(key.as_str())
        );
        assert_eq!(index.retained_keys().len(), 1);
    }

    #[test]
    fn private_payload_integrity_uses_the_blake3_known_vector() {
        let temp = tempfile::tempdir().unwrap();
        let payload = temp.path().join("payload");
        fs::write(&payload, b"abc").unwrap();

        assert_eq!(
            payload_digest(&payload).unwrap(),
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
    }

    #[test]
    fn v1_checkpoint_metadata_is_not_restored() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );

        let entry = entry_path(&cache_root, &id.cache_key().unwrap());
        let metadata_path = entry.join(ENTRY_FILE_METADATA);
        let mut metadata =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&metadata_path).unwrap())
                .unwrap();
        metadata["format"] = json!("intar-checkpoint-cache-v1");
        let metadata_bytes = serde_json::to_vec(&metadata).unwrap();
        fs::write(&metadata_path, &metadata_bytes).unwrap();
        fs::write(
            entry.join(ENTRY_FILE_COMPLETE),
            serde_json::to_vec(&json!({
                "format": "intar-checkpoint-cache-v1",
                "key": id.cache_key().unwrap(),
                "metadata_sha256": sha256_bytes(&metadata_bytes),
            }))
            .unwrap(),
        )
        .unwrap();

        assert!(cache.restore(&id).unwrap().is_none());
    }

    #[test]
    fn published_checkpoint_is_restored_with_exact_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 8 * 1024 * 1024);
        let id = identity(b"packages");
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );

        let lease = cache.restore(&id).unwrap().unwrap();
        assert!(lease.entry.qcow2_path.is_file());
        assert!(lease.entry.memory_state_path.is_file());
        assert!(lease.entry.seed_disk_path.is_file());
        assert_eq!(
            fs::read(&lease.entry.seed_disk_path).unwrap(),
            vec![b's'; 32 * 1024]
        );
    }

    #[test]
    fn moving_publication_transfers_snapshot_sources_and_returns_a_lease() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 8 * 1024 * 1024);
        let snapshot = temp.path().join("snapshot");
        fs::create_dir(&snapshot).unwrap();
        let (qcow2, memory, seed) = payloads(&snapshot, "first", 32 * 1024);
        let id = identity(b"packages");

        let lease = stored(
            cache
                .reserve(&id, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 2, json!({}))
                .unwrap(),
        );

        assert!(!qcow2.exists());
        assert!(!memory.exists());
        assert_eq!(fs::read(&seed).unwrap(), vec![b's'; 32 * 1024]);
        assert!(lease.entry.qcow2_path.is_file());
        assert!(lease.entry.memory_state_path.is_file());
        let replacement = identity(b"packages changed");
        let pending = cache
            .reserve(&replacement, CheckpointSlot::ExpensivePrefix, 64 * 1024)
            .unwrap()
            .unwrap();
        drop(pending);

        drop(lease);
        assert!(cache.restore(&id).unwrap().is_some());
    }

    #[test]
    fn skipped_moving_publication_keeps_the_local_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 8 * 1024);
        let snapshot = temp.path().join("snapshot");
        fs::create_dir(&snapshot).unwrap();
        let (qcow2, memory, seed) = payloads(&snapshot, "first", 32 * 1024);
        let id = identity(b"packages");

        let publication = cache
            .reserve(&id, CheckpointSlot::ExpensivePrefix, 1)
            .unwrap()
            .unwrap()
            .publish_moving(&qcow2, &memory, &seed, 2, json!({}))
            .unwrap();

        assert!(matches!(publication, CheckpointPublish::Skipped));
        assert_eq!(fs::read(&qcow2).unwrap(), vec![b'q'; 32 * 1024]);
        assert_eq!(fs::read(&memory).unwrap(), vec![b'm'; 32 * 1024]);
        assert_eq!(fs::read(&seed).unwrap(), vec![b's'; 32 * 1024]);
    }

    #[test]
    fn rollback_after_staging_failure_returns_moved_snapshot_sources() {
        let temp = tempfile::tempdir().unwrap();
        let snapshot = temp.path().join("snapshot");
        let staging = temp.path().join("staging");
        fs::create_dir(&snapshot).unwrap();
        create_private_dir(&staging).unwrap();
        let (qcow2, memory, _) = payloads(&snapshot, "first", 32 * 1024);
        let mut moved_sources = MovedSources::default();

        let (_, moved_qcow2) =
            move_or_copy_payload(&qcow2, &staging.join(ENTRY_FILE_QCOW2)).unwrap();
        moved_sources.push(moved_qcow2);
        let (_, moved_memory) =
            move_or_copy_payload(&memory, &staging.join(ENTRY_FILE_MEMORY)).unwrap();
        moved_sources.push(moved_memory);
        assert!(!qcow2.exists());
        assert!(!memory.exists());

        assert!(
            fail_publication::<()>(
                &mut moved_sources,
                &staging,
                None,
                anyhow::anyhow!("simulated checkpoint metadata write failure"),
            )
            .is_err()
        );
        assert_eq!(fs::read(&qcow2).unwrap(), vec![b'q'; 32 * 1024]);
        assert_eq!(fs::read(&memory).unwrap(), vec![b'm'; 32 * 1024]);
        assert!(!staging.exists());
    }

    #[cfg(unix)]
    #[test]
    fn checkpoint_payloads_and_private_resume_metadata_are_owner_only() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );
        let entry = entry_path(&cache_root, &id.cache_key().unwrap());
        let scope_index = scope_index_path(&cache_root, &id.scope());
        for path in [
            cache_root,
            entry.clone(),
            entry.join(ENTRY_FILE_QCOW2),
            entry.join(ENTRY_FILE_MEMORY),
            entry.join(ENTRY_FILE_SEED),
            entry.join(ENTRY_FILE_METADATA),
            entry.join(ENTRY_FILE_COMPLETE),
            scope_index,
        ] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o077, 0);
        }
    }

    #[test]
    fn corrupt_payload_or_metadata_is_a_cache_miss() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );
        let entry = entry_path(&cache_root, &id.cache_key().unwrap());
        fs::write(entry.join(ENTRY_FILE_MEMORY), b"changed").unwrap();
        assert!(cache.restore(&id).unwrap().is_none());

        cache.invalidate(&id).unwrap();
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "second",
        );
        let metadata_path = entry.join("metadata.json");
        let mut metadata =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&metadata_path).unwrap())
                .unwrap();
        metadata["stage_index"] = json!(99);
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(cache.restore(&id).unwrap().is_none());
    }

    #[test]
    fn failed_publish_is_not_visible_and_releases_its_reservation() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        let (qcow2, _, seed) = payloads(temp.path(), "first", 4096);
        let missing = temp.path().join("missing.memory");
        let writer = cache
            .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
            .unwrap()
            .unwrap();
        assert!(
            writer
                .publish_moving(&qcow2, &missing, &seed, 0, json!({}))
                .is_err()
        );
        assert!(!entry_path(&cache_root, &id.cache_key().unwrap()).exists());
        assert!(
            cache
                .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn failed_publications_release_entry_locks_under_parallel_load() {
        std::thread::scope(|scope| {
            for worker in 0..32 {
                scope.spawn(move || {
                    for iteration in 0..8 {
                        let temp = tempfile::tempdir().unwrap();
                        let cache = cache(&temp.path().join("cache"), 8 * 1024 * 1024);
                        let id = identity(format!("packages-{worker}-{iteration}").as_bytes());
                        let (qcow2, _, seed) = payloads(temp.path(), "first", 4096);
                        let missing = temp.path().join("missing.memory");
                        let writer = cache
                            .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
                            .unwrap()
                            .unwrap();
                        assert!(
                            writer
                                .publish_moving(&qcow2, &missing, &seed, 0, json!({}))
                                .is_err()
                        );
                        assert!(
                            cache
                                .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
                                .unwrap()
                                .is_some(),
                            "worker={worker} iteration={iteration}"
                        );
                    }
                });
            }
        });
    }

    #[test]
    fn active_lease_allows_a_pending_replacement_without_retiring_it() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 8 * 1024 * 1024);
        let first = identity(b"packages");
        publish(
            &cache,
            &first,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );
        let lease = cache.restore(&first).unwrap().unwrap();
        let second = identity(b"packages changed");
        let pending = cache
            .reserve(&second, CheckpointSlot::ExpensivePrefix, 64 * 1024)
            .unwrap()
            .unwrap();
        drop(pending);
        drop(lease);
        assert!(
            cache
                .reserve(&second, CheckpointSlot::ExpensivePrefix, 64 * 1024)
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn leased_slot_defers_replacement_until_publication() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let old = identity(b"old prefix");
        let replacement = identity(b"new prefix");
        let old_key = old.cache_key().unwrap();
        let replacement_key = replacement.cache_key().unwrap();
        let (old_qcow2, old_memory, old_seed) = payloads(temp.path(), "old", 32 * 1024);
        let old_lease = stored(
            cache
                .reserve(&old, CheckpointSlot::BeforeLastStep, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&old_qcow2, &old_memory, &old_seed, 0, json!({}))
                .unwrap(),
        );
        drop(old_lease);
        let old_lease = cache.restore(&old).unwrap().unwrap();
        let old_entry = entry_path(&cache_root, &old_key);
        let replacement_entry = entry_path(&cache_root, &replacement_key);
        let (qcow2, memory, seed) = payloads(temp.path(), "replacement", 32 * 1024);

        let blocked = cache
            .reserve(&replacement, CheckpointSlot::BeforeLastStep, 3 * 64 * 1024)
            .unwrap()
            .unwrap()
            .publish_moving(&qcow2, &memory, &seed, 1, json!({}))
            .unwrap();
        assert!(matches!(blocked, CheckpointPublish::Skipped));
        assert!(old_entry.is_dir());
        assert!(!replacement_entry.exists());
        assert!(qcow2.is_file());
        assert!(memory.is_file());

        drop(old_lease);
        let new_lease = stored(
            cache
                .reserve(&replacement, CheckpointSlot::BeforeLastStep, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 1, json!({}))
                .unwrap(),
        );
        let index = current_scope_index(&cache_root, &replacement.scope());
        assert_eq!(
            index.role(CheckpointSlot::BeforeLastStep),
            Some(replacement_key.as_str())
        );
        assert!(!old_entry.exists());
        assert!(replacement_entry.is_dir());
        assert_eq!(fs::read_dir(cache_root.join("entries")).unwrap().count(), 1);
        assert!(entries_stored_bytes(&cache_root).unwrap() <= 8 * 1024 * 1024);
        let referenced = referenced_entry_keys(&cache_root).unwrap();
        assert!(!referenced.contains(&old_key));
        assert!(referenced.contains(&replacement_key));

        drop(new_lease);
        assert!(cache.restore(&replacement).unwrap().is_some());
    }

    #[test]
    fn appended_expensive_prefix_reassigns_its_parent_role() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let parent = identity(b"old final step");
        let parent_key = parent.cache_key().unwrap();
        let (parent_qcow2, parent_memory, parent_seed) = payloads(temp.path(), "parent", 32 * 1024);
        let parent_lease = stored(
            cache
                .reserve(&parent, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&parent_qcow2, &parent_memory, &parent_seed, 0, json!({}))
                .unwrap(),
        );
        drop(parent_lease);

        let mut appended = identity(b"appended final step");
        appended.parent_prefix = parent_key.clone();
        let appended_key = appended.cache_key().unwrap();
        let (qcow2, memory, seed) = payloads(temp.path(), "appended", 32 * 1024);
        let appended_lease = stored(
            cache
                .reserve(&appended, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 1, json!({}))
                .unwrap(),
        );

        let index = current_scope_index(&cache_root, &appended.scope());
        assert_eq!(
            index.role(CheckpointSlot::BeforeLastStep),
            Some(parent_key.as_str())
        );
        assert_eq!(
            index.role(CheckpointSlot::ExpensivePrefix),
            Some(appended_key.as_str())
        );
        assert!(entry_path(&cache_root, &parent_key).is_dir());
        assert!(entry_path(&cache_root, &appended_key).is_dir());
        let parent_metadata = serde_json::from_slice::<serde_json::Value>(
            &fs::read(entry_path(&cache_root, &parent_key).join(ENTRY_FILE_METADATA)).unwrap(),
        )
        .unwrap();
        assert_eq!(parent_metadata["slot"], "expensive_prefix");

        drop(appended_lease);
        assert!(cache.restore(&parent).unwrap().is_some());
        assert!(cache.restore(&appended).unwrap().is_some());
    }

    #[test]
    fn oversized_replacement_keeps_the_old_role_index() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 450 * 1024);
        let old = identity(b"old final step");
        let old_key = old.cache_key().unwrap();
        let (old_qcow2, old_memory, old_seed) = payloads(temp.path(), "old", 32 * 1024);
        let old_lease = stored(
            cache
                .reserve(&old, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&old_qcow2, &old_memory, &old_seed, 0, json!({}))
                .unwrap(),
        );
        drop(old_lease);

        let mut oversized = identity(b"oversized appended step");
        oversized.parent_prefix = old_key.clone();
        let (qcow2, memory, seed) = payloads(temp.path(), "oversized", 256 * 1024);
        assert!(matches!(
            cache
                .reserve(&oversized, CheckpointSlot::ExpensivePrefix, 8 * 1024 * 1024,)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 1, json!({}))
                .unwrap(),
            CheckpointPublish::Skipped
        ));
        let index = current_scope_index(&cache_root, &old.scope());
        assert_eq!(
            index.role(CheckpointSlot::ExpensivePrefix),
            Some(old_key.as_str())
        );
        assert!(index.role(CheckpointSlot::BeforeLastStep).is_none());
        assert!(entry_path(&cache_root, &old_key).is_dir());
        assert!(qcow2.is_file());
        assert!(memory.is_file());
    }

    #[test]
    fn uncertain_index_write_preserves_old_role_and_rejects_new_cache_hit() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let old = identity(b"old final step");
        let old_key = old.cache_key().unwrap();
        let (old_qcow2, old_memory, old_seed) = payloads(temp.path(), "old", 32 * 1024);
        let old_lease = stored(
            cache
                .reserve(&old, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
                .unwrap()
                .unwrap()
                .publish_moving(&old_qcow2, &old_memory, &old_seed, 0, json!({}))
                .unwrap(),
        );
        drop(old_lease);

        let mut appended = identity(b"appended final step");
        appended.parent_prefix = old_key.clone();
        let appended_key = appended.cache_key().unwrap();
        let (qcow2, memory, seed) = payloads(temp.path(), "appended", 32 * 1024);
        fail_next_scope_index_write();
        let publication = cache
            .reserve(&appended, CheckpointSlot::ExpensivePrefix, 3 * 64 * 1024)
            .unwrap()
            .unwrap()
            .publish_moving(&qcow2, &memory, &seed, 1, json!({}))
            .unwrap();

        assert!(matches!(publication, CheckpointPublish::RetentionUncertain));
        let index = current_scope_index(&cache_root, &old.scope());
        assert_eq!(
            index.role(CheckpointSlot::ExpensivePrefix),
            Some(old_key.as_str())
        );
        assert!(index.role(CheckpointSlot::BeforeLastStep).is_none());
        assert!(entry_path(&cache_root, &old_key).is_dir());
        assert!(entry_path(&cache_root, &appended_key).is_dir());
        assert!(cache.restore(&old).unwrap().is_some());
        assert!(cache.restore(&appended).unwrap().is_none());
    }

    #[test]
    fn concurrent_reserve_and_restore_skip_a_writer_instead_of_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 8 * 1024 * 1024);
        let id = identity(b"packages");
        let writer = cache
            .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
            .unwrap()
            .unwrap();

        assert!(cache.restore(&id).unwrap().is_none());
        assert!(
            cache
                .reserve(&id, CheckpointSlot::ExpensivePrefix, 64 * 1024)
                .unwrap()
                .is_none()
        );
        drop(writer);
    }

    #[test]
    fn cache_skips_oversized_publication_or_free_floor() {
        let temp = tempfile::tempdir().unwrap();
        let id = identity(b"packages");
        let tiny = cache(&temp.path().join("tiny"), 1);
        let (qcow2, memory, seed) = payloads(temp.path(), "oversized", 4096);
        assert!(matches!(
            tiny.reserve(&id, CheckpointSlot::ExpensivePrefix, 1)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 0, json!({}))
                .unwrap(),
            CheckpointPublish::Skipped
        ));
        assert!(qcow2.is_file());
        assert!(memory.is_file());
        assert!(seed.is_file());
        assert!(!entry_path(&temp.path().join("tiny"), &id.cache_key().unwrap()).exists());

        let blocked = CheckpointCache::new(CheckpointCacheConfig {
            root: temp.path().join("floor"),
            use_cache: true,
            budget_bytes: 8 * 1024 * 1024,
            minimum_free_bytes: u64::MAX,
        })
        .unwrap();
        assert!(
            blocked
                .reserve(&id, CheckpointSlot::ExpensivePrefix, 1024)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn duplicate_identity_uses_one_physical_checkpoint_for_both_slots() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        publish(
            &cache,
            &id,
            CheckpointSlot::ExpensivePrefix,
            temp.path(),
            "first",
        );
        assert!(
            cache
                .reserve(&id, CheckpointSlot::BeforeLastStep, 64 * 1024)
                .unwrap()
                .is_none()
        );
        let entries = fs::read_dir(cache_root.join("entries")).unwrap().count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn worst_case_reservation_keeps_entries_that_fit_the_cache_budget() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 450 * 1024);
        let mut first = identity(b"packages");
        first.scenario_id = "first".to_string();
        let mut second = identity(b"packages");
        second.scenario_id = "second".to_string();
        let mut pending = identity(b"packages");
        pending.scenario_id = "pending".to_string();

        publish_sized(&cache, &first, temp.path(), "first", 64 * 1024, 200 * 1024);
        publish_sized(
            &cache,
            &second,
            temp.path(),
            "second",
            64 * 1024,
            200 * 1024,
        );

        let writer = cache
            .reserve(&pending, CheckpointSlot::ExpensivePrefix, 8 * 1024 * 1024)
            .unwrap()
            .unwrap();
        assert!(cache.restore(&first).unwrap().is_some());
        assert!(cache.restore(&second).unwrap().is_some());
        drop(writer);
    }

    #[test]
    fn oversized_publication_skips_without_evicting_completed_entries() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache = cache(&cache_root, 450 * 1024);
        let mut first = identity(b"packages");
        first.scenario_id = "first".to_string();
        let mut second = identity(b"packages");
        second.scenario_id = "second".to_string();
        let mut oversized = identity(b"packages");
        oversized.scenario_id = "oversized".to_string();

        publish_sized(&cache, &first, temp.path(), "first", 64 * 1024, 200 * 1024);
        publish_sized(
            &cache,
            &second,
            temp.path(),
            "second",
            64 * 1024,
            200 * 1024,
        );
        let (qcow2, memory, seed) = payloads(temp.path(), "oversized", 256 * 1024);

        assert!(matches!(
            cache
                .reserve(&oversized, CheckpointSlot::ExpensivePrefix, 8 * 1024 * 1024,)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 0, json!({}))
                .unwrap(),
            CheckpointPublish::Skipped
        ));
        assert!(qcow2.is_file());
        assert!(memory.is_file());
        assert!(seed.is_file());
        assert!(!entry_path(&cache_root, &oversized.cache_key().unwrap()).exists());
        assert!(cache.restore(&first).unwrap().is_some());
        assert!(cache.restore(&second).unwrap().is_some());
    }

    #[test]
    fn budget_eviction_keeps_the_most_recent_unleased_entry() {
        let temp = tempfile::tempdir().unwrap();
        let cache = cache(&temp.path().join("cache"), 450 * 1024);
        let mut first = identity(b"packages");
        first.scenario_id = "first".to_string();
        let mut second = identity(b"packages");
        second.scenario_id = "second".to_string();
        let mut third = identity(b"packages");
        third.scenario_id = "third".to_string();

        publish_sized(&cache, &first, temp.path(), "first", 64 * 1024, 200 * 1024);
        publish_sized(
            &cache,
            &second,
            temp.path(),
            "second",
            64 * 1024,
            200 * 1024,
        );
        drop(cache.restore(&first).unwrap().unwrap());

        publish_sized(&cache, &third, temp.path(), "third", 64 * 1024, 200 * 1024);

        assert!(cache.restore(&first).unwrap().is_some());
        assert!(cache.restore(&second).unwrap().is_none());
        assert!(cache.restore(&third).unwrap().is_some());
    }

    #[test]
    fn cache_startup_removes_an_unlocked_interrupted_staging_directory() {
        let temp = tempfile::tempdir().unwrap();
        let cache_root = temp.path().join("cache");
        let cache_instance = cache(&cache_root, 8 * 1024 * 1024);
        let id = identity(b"packages");
        let staging = cache_root
            .join(".staging")
            .join(format!(".{}-999-1", id.cache_key().unwrap()));
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial"), b"partial").unwrap();
        drop(cache_instance);

        let _reopened = cache(&cache_root, 8 * 1024 * 1024);
        assert!(!staging.exists());
    }

    fn publish_sized(
        cache: &CheckpointCache,
        identity: &CheckpointIdentity,
        root: &Path,
        label: &str,
        payload_bytes: usize,
        expected_bytes: u64,
    ) {
        let (qcow2, memory, seed) = payloads(root, label, payload_bytes);
        drop(stored(
            cache
                .reserve(identity, CheckpointSlot::ExpensivePrefix, expected_bytes)
                .unwrap()
                .unwrap()
                .publish_moving(&qcow2, &memory, &seed, 0, json!({}))
                .unwrap(),
        ));
    }
}
