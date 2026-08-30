use super::*;

pub(super) fn upsert_archive_job(conn: &Connection, row: &ArchiveJobRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO archive_jobs (
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(run_id, vm_name) DO UPDATE SET
  vm_created_at_ms = excluded.vm_created_at_ms,
  delete_requested_at_ms = excluded.delete_requested_at_ms,
  deleted_at_ms = excluded.deleted_at_ms,
  artifacts_dir = excluded.artifacts_dir,
  next_attempt_at_ms = excluded.next_attempt_at_ms,
  retry_count = excluded.retry_count,
  last_error = excluded.last_error,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![
            row.run_id,
            row.vm_name,
            row.vm_created_at_ms,
            row.delete_requested_at_ms,
            row.deleted_at_ms,
            row.artifacts_dir,
            row.next_attempt_at_ms,
            row.retry_count,
            row.last_error,
            row.created_at_ms,
            row.updated_at_ms,
        ],
    )
    .context("upsert archive job")?;
    Ok(())
}

pub(super) fn load_due_archive_jobs(
    conn: &Connection,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<ArchiveJobRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT
  run_id,
  vm_name,
  vm_created_at_ms,
  delete_requested_at_ms,
  deleted_at_ms,
  artifacts_dir,
  next_attempt_at_ms,
  retry_count,
  last_error,
  created_at_ms,
  updated_at_ms
FROM archive_jobs AS job
WHERE job.next_attempt_at_ms <= ?1
  -- A run has one durable archive head. If an earlier VM in this run is
  -- retrying in the future, later rows must stay hidden rather than being
  -- dispatched by the next ten-second sweep.
  AND NOT EXISTS (
    SELECT 1
    FROM archive_jobs AS prior
    WHERE prior.run_id = job.run_id
      -- `rowid` is the durable first-insertion sequence. UPSERT updates keep
      -- it unchanged, unlike wall-clock values which can collide or move
      -- backward.
      AND prior.rowid < job.rowid
  )
ORDER BY job.next_attempt_at_ms ASC, job.updated_at_ms ASC, job.vm_name ASC
LIMIT ?2;
"#,
        )
        .context("prepare load due archive jobs query")?;
    stmt.query_map(params![now_ms, limit as i64], |row| {
        Ok(ArchiveJobRow {
            run_id: row.get(0)?,
            vm_name: row.get(1)?,
            vm_created_at_ms: row.get(2)?,
            delete_requested_at_ms: row.get(3)?,
            deleted_at_ms: row.get(4)?,
            artifacts_dir: row.get(5)?,
            next_attempt_at_ms: row.get(6)?,
            retry_count: row.get(7)?,
            last_error: row.get(8)?,
            created_at_ms: row.get(9)?,
            updated_at_ms: row.get(10)?,
        })
    })
    .context("query due archive jobs")?
    .collect::<rusqlite::Result<Vec<ArchiveJobRow>>>()
    .context("collect due archive jobs rows")
}

pub(super) fn delete_archive_job(conn: &Connection, run_id: &str, vm_name: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM archive_jobs WHERE run_id = ?1 AND vm_name = ?2;",
        params![run_id, vm_name],
    )
    .context("delete archive job")?;
    Ok(())
}

pub(super) fn update_archive_job_retry(
    conn: &Connection,
    run_id: &str,
    vm_name: &str,
    next_attempt_at_ms: i64,
    retry_count: i64,
    last_error: Option<&str>,
    updated_at_ms: i64,
) -> Result<()> {
    conn.execute(
        r#"
UPDATE archive_jobs
SET next_attempt_at_ms = ?3,
    retry_count = ?4,
    last_error = ?5,
    updated_at_ms = ?6
WHERE run_id = ?1
  AND vm_name = ?2;
"#,
        params![
            run_id,
            vm_name,
            next_attempt_at_ms,
            retry_count,
            last_error,
            updated_at_ms,
        ],
    )
    .context("update archive job retry")?;
    Ok(())
}

pub(super) fn load_desired_state(conn: &Connection) -> Result<Option<DesiredStateRow>> {
    conn.query_row(
        r#"
SELECT host_id, version, doc_json, updated_at_ms
FROM desired_state
WHERE id = 1;
"#,
        [],
        |row| {
            Ok(DesiredStateRow {
                host_id: row.get(0)?,
                version: row.get(1)?,
                doc_json: row.get(2)?,
                updated_at_ms: row.get(3)?,
            })
        },
    )
    .optional()
    .context("load desired_state row")
}

pub(super) fn upsert_desired_state(conn: &Connection, row: &DesiredStateRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO desired_state (
  id,
  host_id,
  version,
  doc_json,
  updated_at_ms
) VALUES (
  1, ?1, ?2, ?3, ?4
)
ON CONFLICT(id) DO UPDATE SET
  host_id = excluded.host_id,
  version = excluded.version,
  doc_json = excluded.doc_json,
  updated_at_ms = excluded.updated_at_ms;
"#,
        params![row.host_id, row.version, row.doc_json, row.updated_at_ms],
    )
    .context("upsert desired_state row")?;
    Ok(())
}

pub(super) fn touch_image_cache_entry(conn: &Connection, row: &ImageCacheAccessRow) -> Result<()> {
    conn.execute(
        r#"
INSERT INTO image_cache_access (
  image_sha256,
  image_key,
  kernel_sha256,
  initrd_sha256,
  raw_bytes,
  last_accessed_at_ms
) VALUES (
  ?1, ?2, ?3, ?4, ?5, ?6
)
ON CONFLICT(image_sha256) DO UPDATE SET
  image_key = excluded.image_key,
  kernel_sha256 = excluded.kernel_sha256,
  initrd_sha256 = excluded.initrd_sha256,
  raw_bytes = excluded.raw_bytes,
  last_accessed_at_ms = excluded.last_accessed_at_ms;
"#,
        params![
            row.image_sha256,
            row.image_key,
            row.kernel_sha256,
            row.initrd_sha256,
            row.raw_bytes,
            row.last_accessed_at_ms,
        ],
    )
    .context("touch image cache entry")?;
    Ok(())
}

#[cfg(test)]
pub(super) fn load_image_cache_access(conn: &Connection) -> Result<Vec<ImageCacheAccessRow>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT image_key, image_sha256, kernel_sha256, initrd_sha256, raw_bytes, last_accessed_at_ms
FROM image_cache_access
ORDER BY last_accessed_at_ms ASC, image_sha256 ASC;
"#,
        )
        .context("prepare load_image_cache_access")?;
    let rows = stmt
        .query_map([], |row| {
            Ok(ImageCacheAccessRow {
                image_key: row.get(0)?,
                image_sha256: row.get(1)?,
                kernel_sha256: row.get(2)?,
                initrd_sha256: row.get(3)?,
                raw_bytes: row.get(4)?,
                last_accessed_at_ms: row.get(5)?,
            })
        })
        .context("query image_cache_access")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("collect image_cache_access")
}

pub(super) fn load_local_vm_image_shas(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare(
            r#"
SELECT DISTINCT image_sha256
FROM vms
WHERE image_sha256 IS NOT NULL
  AND image_sha256 <> ''
ORDER BY image_sha256 ASC;
"#,
        )
        .context("prepare load local vm image sha query")?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .context("query local vm image shas")?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("collect local vm image shas")
}

#[cfg(test)]
pub(super) fn delete_image_cache_access(conn: &Connection, image_sha256: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM image_cache_access WHERE image_sha256 = ?1;",
        params![image_sha256],
    )
    .context("delete image cache access")?;
    Ok(())
}

pub(super) const BASELINE_SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS vms (
  name TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  image_key TEXT,
  image_sha256 TEXT,
  guest_tools_json TEXT,
  created_at_s INTEGER NOT NULL,
  updated_at_s INTEGER NOT NULL,
  running_at_s INTEGER,
  error TEXT,
  root_disk_path TEXT,
  seed_disk_path TEXT,
  mac TEXT,
  lease_duration_seconds INTEGER,
  guest_ip TEXT,
  guest_ip_cidr TEXT,
  gateway TEXT,
  bridge_name TEXT,
  ssh_public_port INTEGER,
  tap_name TEXT,
  ch_socket_path TEXT,
  ch_pid INTEGER,
  ch_start_time_ticks INTEGER,
  host_boot_id TEXT,
  jail_generation TEXT,
  jail_unit_name TEXT,
  jail_cgroup_path TEXT,
  jail_root_path TEXT,
  jail_root_inode INTEGER,
  jail_uid INTEGER,
  jail_gid INTEGER,
  jail_netns_name TEXT,
  kino_vsock_cid INTEGER,
  kino_vsock_port INTEGER,
  kino_vsock_path TEXT,
  ssh_host_keys_openssh_json TEXT,
  run_id TEXT,
  recording_disk_path TEXT,
  spool_dir TEXT,
  cpu_millis INTEGER,
  vcpu_count INTEGER,
  ch_executable_sha256 TEXT
);

CREATE INDEX IF NOT EXISTS idx_vms_lease
  ON vms(lease_duration_seconds, running_at_s, state);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vms_guest_ip ON vms(guest_ip);

CREATE TABLE IF NOT EXISTS vm_probe_state (
  vm_name TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  collection_state TEXT NOT NULL,
  collection_error TEXT,
  summary_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  generated_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vm_probe_state_run_id
  ON vm_probe_state(run_id, updated_at_ms);

CREATE TABLE IF NOT EXISTS archive_jobs (
  run_id TEXT NOT NULL,
  vm_name TEXT NOT NULL,
  vm_created_at_ms INTEGER NOT NULL,
  delete_requested_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER NOT NULL,
  artifacts_dir TEXT NOT NULL,
  next_attempt_at_ms INTEGER NOT NULL,
  retry_count INTEGER NOT NULL,
  last_error TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, vm_name)
);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_due
  ON archive_jobs(next_attempt_at_ms, updated_at_ms);

CREATE INDEX IF NOT EXISTS idx_archive_jobs_run_head
  ON archive_jobs(run_id);

CREATE TABLE IF NOT EXISTS desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  host_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image_cache_access (
  image_sha256 TEXT PRIMARY KEY,
  image_key TEXT NOT NULL,
  kernel_sha256 TEXT NOT NULL,
  initrd_sha256 TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_image_cache_access_lru
  ON image_cache_access(last_accessed_at_ms);

"#;
