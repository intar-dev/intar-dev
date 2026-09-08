#![allow(clippy::missing_errors_doc)]
#![allow(dead_code)]

use std::path::Path;

use anyhow::{Context, Result};
use intar_contracts::bridge::DesiredBuildV1;
use intar_contracts::catalog::ImageArchitecture;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};

#[derive(Debug)]
pub struct BuilderDb {
    conn: Connection,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DesiredStateRow {
    pub version: u64,
    pub doc_json: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct BuildJobRow {
    pub build_id: String,
    pub scenario_id: String,
    pub arch: ImageArchitecture,
    pub rev: String,
    pub content_hash: String,
    pub bundle_ref: String,
    pub phase: String,
    pub current_vm: Option<String>,
    pub attempt: u32,
    pub error: Option<String>,
    pub started_at_ms: Option<i64>,
    pub finished_at_ms: Option<i64>,
    pub next_attempt_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    /// Local-only metadata for completed image files. The bridge keeps its
    /// existing public phases while a publish retry reuses these bytes.
    pub completed_outputs_json: Option<String>,
    pub publish_state: String,
    pub publish_attempt: u32,
    pub publish_next_attempt_at_ms: Option<i64>,
}

impl BuildJobRow {
    #[must_use]
    pub fn desired_build(&self) -> DesiredBuildV1 {
        DesiredBuildV1 {
            build_id: self.build_id.clone(),
            scenario_id: self.scenario_id.clone(),
            arch: self.arch.clone(),
            rev: self.rev.clone(),
            content_hash: self.content_hash.clone(),
            bundle_ref: self.bundle_ref.clone(),
        }
    }
}

impl BuilderDb {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open builder db '{}'", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(30))
            .context("failed to configure builder db busy timeout")?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("failed to open in-memory builder db")?;
        conn.busy_timeout(std::time::Duration::from_secs(30))
            .context("failed to configure builder db busy timeout")?;
        migrate(&conn)?;
        Ok(Self { conn })
    }

    pub fn load_desired_state(&self) -> Result<Option<DesiredStateRow>> {
        self.conn
            .query_row(
                "SELECT version, doc_json, updated_at_ms FROM desired_state WHERE id = 1",
                [],
                |row| {
                    Ok(DesiredStateRow {
                        version: row.get::<_, i64>(0)? as u64,
                        doc_json: row.get(1)?,
                        updated_at_ms: row.get(2)?,
                    })
                },
            )
            .optional()
            .context("failed to load desired state")
    }

    pub fn save_desired_state(&self, version: u64, doc_json: &str, now_ms: i64) -> Result<()> {
        self.conn
            .execute(
                r#"
INSERT INTO desired_state (id, version, doc_json, updated_at_ms)
VALUES (1, ?1, ?2, ?3)
ON CONFLICT(id) DO UPDATE SET
  version = excluded.version,
  doc_json = excluded.doc_json,
  updated_at_ms = excluded.updated_at_ms
"#,
                params![version as i64, doc_json, now_ms],
            )
            .context("failed to save desired state")?;
        Ok(())
    }

    pub fn upsert_build_job(
        &self,
        build: &DesiredBuildV1,
        phase: &str,
        attempt: u32,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                r#"
INSERT INTO build_jobs (
  build_id, scenario_id, arch, rev, content_hash, bundle_ref,
  phase, attempt, error, next_attempt_at_ms, updated_at_ms
)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, ?10)
ON CONFLICT(build_id) DO UPDATE SET
  scenario_id = excluded.scenario_id,
  arch = excluded.arch,
  rev = excluded.rev,
  content_hash = excluded.content_hash,
  bundle_ref = excluded.bundle_ref,
  phase = excluded.phase,
  attempt = excluded.attempt,
  error = excluded.error,
  next_attempt_at_ms = excluded.next_attempt_at_ms,
  completed_outputs_json = NULL,
  publish_state = 'none',
  publish_attempt = 0,
  publish_next_attempt_at_ms = NULL,
  updated_at_ms = excluded.updated_at_ms
"#,
                params![
                    build.build_id,
                    build.scenario_id,
                    arch_slug(&build.arch),
                    build.rev,
                    build.content_hash,
                    build.bundle_ref,
                    phase,
                    attempt as i64,
                    error,
                    now_ms,
                ],
            )
            .context("failed to upsert build job")?;
        Ok(())
    }

    pub fn list_build_jobs(&self) -> Result<Vec<BuildJobRow>> {
        let mut statement = self
            .conn
            .prepare(
                r#"
SELECT build_id, scenario_id, arch, rev, content_hash, bundle_ref,
       phase, current_vm, attempt, error, started_at_ms, finished_at_ms,
       next_attempt_at_ms, updated_at_ms, completed_outputs_json,
       publish_state, publish_attempt, publish_next_attempt_at_ms
FROM build_jobs
ORDER BY COALESCE(next_attempt_at_ms, updated_at_ms), updated_at_ms, build_id
"#,
            )
            .context("failed to prepare build job query")?;
        let rows = statement
            .query_map([], |row| {
                Ok(BuildJobRow {
                    build_id: row.get(0)?,
                    scenario_id: row.get(1)?,
                    arch: parse_arch(&row.get::<_, String>(2)?)?,
                    rev: row.get(3)?,
                    content_hash: row.get(4)?,
                    bundle_ref: row.get(5)?,
                    phase: row.get(6)?,
                    current_vm: row.get(7)?,
                    attempt: row.get::<_, i64>(8)? as u32,
                    error: row.get(9)?,
                    started_at_ms: row.get(10)?,
                    finished_at_ms: row.get(11)?,
                    next_attempt_at_ms: row.get(12)?,
                    updated_at_ms: row.get(13)?,
                    completed_outputs_json: row.get(14)?,
                    publish_state: row.get(15)?,
                    publish_attempt: row.get::<_, i64>(16)? as u32,
                    publish_next_attempt_at_ms: row.get(17)?,
                })
            })
            .context("failed to query build jobs")?;

        rows.collect::<rusqlite::Result<Vec<_>>>()
            .context("failed to collect build jobs")
    }

    pub fn load_build_job(&self, build_id: &str) -> Result<Option<BuildJobRow>> {
        self.conn
            .query_row(
                r#"
SELECT build_id, scenario_id, arch, rev, content_hash, bundle_ref,
       phase, current_vm, attempt, error, started_at_ms, finished_at_ms,
       next_attempt_at_ms, updated_at_ms, completed_outputs_json,
       publish_state, publish_attempt, publish_next_attempt_at_ms
FROM build_jobs
WHERE build_id = ?1
"#,
                params![build_id],
                |row| {
                    Ok(BuildJobRow {
                        build_id: row.get(0)?,
                        scenario_id: row.get(1)?,
                        arch: parse_arch(&row.get::<_, String>(2)?)?,
                        rev: row.get(3)?,
                        content_hash: row.get(4)?,
                        bundle_ref: row.get(5)?,
                        phase: row.get(6)?,
                        current_vm: row.get(7)?,
                        attempt: row.get::<_, i64>(8)? as u32,
                        error: row.get(9)?,
                        started_at_ms: row.get(10)?,
                        finished_at_ms: row.get(11)?,
                        next_attempt_at_ms: row.get(12)?,
                        updated_at_ms: row.get(13)?,
                        completed_outputs_json: row.get(14)?,
                        publish_state: row.get(15)?,
                        publish_attempt: row.get::<_, i64>(16)? as u32,
                        publish_next_attempt_at_ms: row.get(17)?,
                    })
                },
            )
            .optional()
            .context("failed to load build job")
    }

    pub fn delete_build_job(&self, build_id: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "DELETE FROM build_jobs WHERE build_id = ?1",
                params![build_id],
            )
            .with_context(|| format!("failed to delete build job '{build_id}'"))?;
        Ok(changed > 0)
    }

    pub fn claim_next_queued_build(&self, now_ms: i64) -> Result<Option<BuildJobRow>> {
        let Some(build_id) = self
            .conn
            .query_row(
                r#"
SELECT build_id
FROM build_jobs
WHERE phase = 'queued'
  AND COALESCE(next_attempt_at_ms, 0) <= ?1
ORDER BY COALESCE(next_attempt_at_ms, updated_at_ms), updated_at_ms, build_id
LIMIT 1
"#,
                params![now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("failed to load next queued build")?
        else {
            return Ok(None);
        };

        let changed = self
            .conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = 'fetching_sources',
    current_vm = NULL,
    attempt = attempt + 1,
    error = NULL,
    started_at_ms = COALESCE(started_at_ms, ?2),
    finished_at_ms = NULL,
    next_attempt_at_ms = NULL,
    updated_at_ms = ?2
WHERE build_id = ?1 AND phase = 'queued'
  AND COALESCE(next_attempt_at_ms, 0) <= ?2
"#,
                params![build_id, now_ms],
            )
            .context("failed to claim queued build")?;
        if changed == 0 {
            return Ok(None);
        }

        self.load_build_job(&build_id)
    }

    /// Save finished local image metadata before publication. A build worker
    /// keeps ownership while `publish_state` is `waiting`, so two queued or
    /// active publications cannot grow into an unbounded output queue.
    pub fn save_completed_build_outputs(
        &self,
        build_id: &str,
        completed_outputs_json: &str,
        now_ms: i64,
    ) -> Result<()> {
        let changed = self
            .conn
            .execute(
                r#"
UPDATE build_jobs
SET current_vm = NULL,
    completed_outputs_json = ?2,
    publish_state = 'waiting',
    publish_attempt = 0,
    publish_next_attempt_at_ms = NULL,
    error = NULL,
    updated_at_ms = ?3
WHERE build_id = ?1 AND phase = 'building'
"#,
                params![build_id, completed_outputs_json, now_ms],
            )
            .with_context(|| format!("failed to save completed outputs for build '{build_id}'"))?;
        if changed == 0 {
            anyhow::bail!("build '{build_id}' is no longer waiting for publication");
        }
        Ok(())
    }

    /// Atomically reserve one of the two publication slots. A retry that is
    /// already in a slot takes priority over a newly completed build.
    pub fn claim_next_publication_build(&self, now_ms: i64) -> Result<Option<BuildJobRow>> {
        let transaction = Transaction::new_unchecked(&self.conn, TransactionBehavior::Immediate)
            .context("failed to begin publication claim transaction")?;

        let ready_build_id = transaction
            .query_row(
                r#"
SELECT build_id
FROM build_jobs
WHERE phase = 'publishing'
  AND completed_outputs_json IS NOT NULL
  AND publish_state = 'ready'
  AND COALESCE(publish_next_attempt_at_ms, 0) <= ?1
ORDER BY COALESCE(publish_next_attempt_at_ms, updated_at_ms), updated_at_ms, build_id
LIMIT 1
"#,
                params![now_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("failed to load pending publication retry")?;

        let build_id = if let Some(build_id) = ready_build_id {
            transaction
                .execute(
                    r#"
UPDATE build_jobs
SET publish_state = 'running',
    publish_attempt = publish_attempt + 1,
    publish_next_attempt_at_ms = NULL,
    error = NULL,
    updated_at_ms = ?2
WHERE build_id = ?1 AND phase = 'publishing' AND publish_state = 'ready'
"#,
                    params![build_id, now_ms],
                )
                .context("failed to claim publication retry")?;
            Some(build_id)
        } else {
            let occupied_slots: i64 = transaction
                .query_row(
                    r#"
SELECT COUNT(*)
FROM build_jobs
WHERE phase = 'publishing'
  AND completed_outputs_json IS NOT NULL
  AND publish_state IN ('ready', 'running')
"#,
                    [],
                    |row| row.get(0),
                )
                .context("failed to count publication slots")?;
            if occupied_slots >= 2 {
                None
            } else {
                let waiting_build_id = transaction
                    .query_row(
                        r#"
SELECT build_id
FROM build_jobs
WHERE phase = 'building'
  AND completed_outputs_json IS NOT NULL
  AND publish_state = 'waiting'
ORDER BY updated_at_ms, build_id
LIMIT 1
"#,
                        [],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()
                    .context("failed to load completed build awaiting publication")?;
                if let Some(build_id) = waiting_build_id {
                    transaction
                        .execute(
                            r#"
UPDATE build_jobs
SET phase = 'publishing',
    current_vm = NULL,
    publish_state = 'running',
    publish_attempt = 1,
    publish_next_attempt_at_ms = NULL,
    error = NULL,
    updated_at_ms = ?2
WHERE build_id = ?1
  AND phase = 'building'
  AND publish_state = 'waiting'
  AND completed_outputs_json IS NOT NULL
"#,
                            params![build_id, now_ms],
                        )
                        .context("failed to claim completed build for publication")?;
                    Some(build_id)
                } else {
                    None
                }
            }
        };

        transaction
            .commit()
            .context("failed to commit publication claim transaction")?;
        match build_id {
            Some(build_id) => self.load_build_job(&build_id),
            None => Ok(None),
        }
    }

    pub fn schedule_publication_retry(
        &self,
        build_id: &str,
        error: &str,
        next_attempt_at_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = 'publishing',
    current_vm = NULL,
    publish_state = 'ready',
    error = ?2,
    finished_at_ms = NULL,
    publish_next_attempt_at_ms = ?3,
    updated_at_ms = ?4
WHERE build_id = ?1 AND completed_outputs_json IS NOT NULL
"#,
                params![build_id, error, next_attempt_at_ms, now_ms],
            )
            .with_context(|| {
                format!("failed to schedule publication retry for build '{build_id}'")
            })?;
        Ok(())
    }

    pub fn clear_completed_build_outputs(&self, build_id: &str) -> Result<()> {
        self.conn
            .execute(
                r#"
UPDATE build_jobs
SET completed_outputs_json = NULL,
    publish_state = 'none',
    publish_attempt = 0,
    publish_next_attempt_at_ms = NULL
WHERE build_id = ?1
"#,
                params![build_id],
            )
            .with_context(|| format!("failed to clear completed outputs for build '{build_id}'"))?;
        Ok(())
    }

    pub fn schedule_build_job_retry(
        &self,
        build_id: &str,
        attempt: u32,
        error: &str,
        next_attempt_at_ms: i64,
        now_ms: i64,
    ) -> Result<()> {
        self.conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = 'queued',
    current_vm = NULL,
    attempt = ?2,
    error = ?3,
    finished_at_ms = NULL,
    next_attempt_at_ms = ?4,
    completed_outputs_json = NULL,
    publish_state = 'none',
    publish_attempt = 0,
    publish_next_attempt_at_ms = NULL,
    updated_at_ms = ?5
WHERE build_id = ?1
"#,
                params![build_id, attempt as i64, error, next_attempt_at_ms, now_ms],
            )
            .context("failed to schedule build job retry")?;
        Ok(())
    }

    pub fn update_build_job_phase(
        &self,
        build_id: &str,
        phase: &str,
        current_vm: Option<&str>,
        attempt: u32,
        error: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        let started_at_ms = if phase == "queued" {
            None
        } else {
            Some(now_ms)
        };
        let finished_at_ms = if matches!(phase, "succeeded" | "failed") {
            Some(now_ms)
        } else {
            None
        };
        self.conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = ?2,
    current_vm = ?3,
    attempt = ?4,
    error = ?5,
    started_at_ms = CASE
      WHEN ?6 IS NULL THEN started_at_ms
      ELSE COALESCE(started_at_ms, ?6)
    END,
    finished_at_ms = ?7,
    next_attempt_at_ms = NULL,
    updated_at_ms = ?8
WHERE build_id = ?1
"#,
                params![
                    build_id,
                    phase,
                    current_vm,
                    attempt as i64,
                    error,
                    started_at_ms,
                    finished_at_ms,
                    now_ms,
                ],
            )
            .context("failed to update build job phase")?;
        Ok(())
    }

    pub fn reset_active_build_jobs(&self, now_ms: i64) -> Result<usize> {
        let reset_incomplete = self
            .conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = 'queued',
    current_vm = NULL,
    error = 'builder daemon restarted while build was ' || phase,
    finished_at_ms = NULL,
    next_attempt_at_ms = ?1,
    completed_outputs_json = NULL,
    publish_state = 'none',
    publish_attempt = 0,
    publish_next_attempt_at_ms = NULL,
    updated_at_ms = ?1
WHERE phase IN (
  'fetching_sources',
  'building_base',
  'building',
  'publishing',
  'uploading_logs'
)
  AND completed_outputs_json IS NULL
"#,
                params![now_ms],
            )
            .context("failed to reset incomplete build jobs after restart")?;
        let reset_publication = self
            .conn
            .execute(
                r#"
UPDATE build_jobs
SET current_vm = NULL,
    publish_state = 'ready',
    error = 'builder daemon restarted while publication was running',
    finished_at_ms = NULL,
    publish_next_attempt_at_ms = ?1,
    updated_at_ms = ?1
WHERE phase = 'publishing'
  AND completed_outputs_json IS NOT NULL
"#,
                params![now_ms],
            )
            .context("failed to reset publication jobs after restart")?;
        let reset_log_upload = self
            .conn
            .execute(
                r#"
UPDATE build_jobs
SET phase = 'publishing',
    current_vm = NULL,
    error = 'builder daemon restarted before build log upload; retrying publication',
    finished_at_ms = NULL,
    publish_state = 'ready',
    publish_next_attempt_at_ms = ?1,
    updated_at_ms = ?1
WHERE phase = 'uploading_logs'
  AND completed_outputs_json IS NOT NULL
"#,
                params![now_ms],
            )
            .context("failed to reset published job after restart")?;
        Ok(reset_incomplete + reset_publication + reset_log_upload)
    }
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS build_jobs (
  build_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  arch TEXT NOT NULL,
  rev TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  phase TEXT NOT NULL,
  current_vm TEXT,
  attempt INTEGER NOT NULL,
  error TEXT,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  next_attempt_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL,
  completed_outputs_json TEXT,
  publish_state TEXT NOT NULL DEFAULT 'none',
  publish_attempt INTEGER NOT NULL DEFAULT 0,
  publish_next_attempt_at_ms INTEGER
);
"#,
    )
    .context("failed to migrate builder db")?;
    migrate_legacy_kino_column(conn)?;
    ensure_column(conn, "build_jobs", "current_vm", "TEXT")?;
    ensure_column(conn, "build_jobs", "started_at_ms", "INTEGER")?;
    ensure_column(conn, "build_jobs", "finished_at_ms", "INTEGER")?;
    ensure_column(conn, "build_jobs", "next_attempt_at_ms", "INTEGER")?;
    ensure_column(conn, "build_jobs", "completed_outputs_json", "TEXT")?;
    ensure_column(
        conn,
        "build_jobs",
        "publish_state",
        "TEXT NOT NULL DEFAULT 'none'",
    )?;
    ensure_column(
        conn,
        "build_jobs",
        "publish_attempt",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(conn, "build_jobs", "publish_next_attempt_at_ms", "INTEGER")?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_build_jobs_phase_updated ON build_jobs(phase, updated_at_ms);",
    )
    .context("failed to create builder job index")?;
    Ok(())
}

fn migrate_legacy_kino_column(conn: &Connection) -> Result<()> {
    if !table_has_column(conn, "build_jobs", "kino_version")? {
        return Ok(());
    }
    conn.execute_batch(
        r#"
DROP INDEX IF EXISTS idx_build_jobs_phase_updated;
ALTER TABLE build_jobs RENAME TO build_jobs_v9;
CREATE TABLE build_jobs (
  build_id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  arch TEXT NOT NULL,
  rev TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  bundle_ref TEXT NOT NULL,
  phase TEXT NOT NULL,
  current_vm TEXT,
  attempt INTEGER NOT NULL,
  error TEXT,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  next_attempt_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO build_jobs (
  build_id, scenario_id, arch, rev, content_hash, bundle_ref, phase, current_vm,
  attempt, error, started_at_ms, finished_at_ms, next_attempt_at_ms, updated_at_ms
)
SELECT build_id, scenario_id, arch, rev, content_hash, bundle_ref, phase, current_vm,
       attempt, error, started_at_ms, finished_at_ms, next_attempt_at_ms, updated_at_ms
FROM build_jobs_v9;
DROP TABLE build_jobs_v9;
"#,
    )
    .context("failed to migrate builder jobs from v9")?;
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let mut statement = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .context("failed to prepare table_info query")?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .context("failed to query table_info")?
        .collect::<rusqlite::Result<Vec<_>>>()
        .context("failed to collect table_info rows")?;
    Ok(columns.iter().any(|existing| existing == column))
}

fn ensure_column(conn: &Connection, table: &str, column: &str, column_type: &str) -> Result<()> {
    if table_has_column(conn, table, column)? {
        return Ok(());
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {column_type}"),
        [],
    )
    .with_context(|| format!("failed to add {table}.{column}"))?;
    Ok(())
}

fn arch_slug(arch: &ImageArchitecture) -> &'static str {
    match arch {
        ImageArchitecture::X86_64 => "x86_64",
        ImageArchitecture::Aarch64 => "aarch64",
    }
}

fn parse_arch(value: &str) -> rusqlite::Result<ImageArchitecture> {
    match value {
        "x86_64" | "amd64" => Ok(ImageArchitecture::X86_64),
        "aarch64" | "arm64" => Ok(ImageArchitecture::Aarch64),
        other => Err(rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Text,
            format!("unsupported build architecture '{other}'").into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use intar_contracts::catalog::ImageArchitecture;

    use super::BuilderDb;

    #[test]
    fn persists_desired_state() {
        let db = BuilderDb::open_in_memory().unwrap();
        assert_eq!(db.load_desired_state().unwrap(), None);

        db.save_desired_state(42, r#"{"version":42}"#, 1000)
            .unwrap();
        let row = db.load_desired_state().unwrap().unwrap();
        assert_eq!(row.version, 42);
        assert_eq!(row.doc_json, r#"{"version":42}"#);
        assert_eq!(row.updated_at_ms, 1000);
    }

    #[test]
    fn upserts_build_jobs() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
        };

        db.upsert_build_job(&build, "queued", 0, None, 1000)
            .unwrap();
        db.upsert_build_job(&build, "building", 1, Some("retrying"), 2000)
            .unwrap();

        let rows = db.list_build_jobs().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].build_id, "build-1");
        assert_eq!(rows[0].phase, "building");
        assert_eq!(rows[0].attempt, 1);
        assert_eq!(rows[0].error.as_deref(), Some("retrying"));
        assert_eq!(rows[0].next_attempt_at_ms, None);
    }

    #[test]
    fn claims_due_queued_build_once() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = intar_contracts::bridge::DesiredBuildV1 {
            build_id: "build-1".to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
        };
        db.upsert_build_job(&build, "queued", 0, None, 1000)
            .unwrap();
        db.schedule_build_job_retry("build-1", 1, "retry later", 2500, 1500)
            .unwrap();

        assert!(db.claim_next_queued_build(2000).unwrap().is_none());

        let claimed = db.claim_next_queued_build(2500).unwrap().unwrap();
        assert_eq!(claimed.phase, "fetching_sources");
        assert_eq!(claimed.attempt, 2);
        assert_eq!(claimed.started_at_ms, Some(2500));
        assert_eq!(claimed.next_attempt_at_ms, None);
        assert!(db.claim_next_queued_build(3000).unwrap().is_none());
    }

    #[test]
    fn limits_publication_to_two_completed_or_running_outputs() {
        let db = BuilderDb::open_in_memory().unwrap();
        for build_id in ["build-a", "build-b", "build-c"] {
            let build = build(build_id);
            db.upsert_build_job(&build, "building", 1, None, 1000)
                .unwrap();
            db.save_completed_build_outputs(build_id, "[]", 1000)
                .unwrap();
        }

        let first = db.claim_next_publication_build(1000).unwrap().unwrap();
        let second = db.claim_next_publication_build(1000).unwrap().unwrap();

        assert_eq!(first.phase, "publishing");
        assert_eq!(first.publish_state, "running");
        assert_eq!(first.publish_attempt, 1);
        assert_eq!(second.phase, "publishing");
        assert_eq!(second.publish_state, "running");
        assert!(db.claim_next_publication_build(1000).unwrap().is_none());
        let third = db.load_build_job("build-c").unwrap().unwrap();
        assert_eq!(third.phase, "building");
        assert_eq!(third.publish_state, "waiting");
    }

    #[test]
    fn restart_preserves_completed_outputs_for_publication_retry() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = build("build-1");
        db.upsert_build_job(&build, "building", 1, None, 1000)
            .unwrap();
        db.save_completed_build_outputs("build-1", "[]", 1000)
            .unwrap();

        assert_eq!(db.reset_active_build_jobs(2000).unwrap(), 0);
        let waiting = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(waiting.phase, "building");
        assert_eq!(waiting.publish_state, "waiting");
        assert_eq!(waiting.completed_outputs_json.as_deref(), Some("[]"));

        let running = db.claim_next_publication_build(2000).unwrap().unwrap();
        assert_eq!(running.phase, "publishing");
        assert_eq!(running.publish_attempt, 1);
        db.schedule_publication_retry("build-1", "registry unavailable", 2500, 2100)
            .unwrap();

        assert_eq!(db.reset_active_build_jobs(2200).unwrap(), 1);
        let retry = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(retry.phase, "publishing");
        assert_eq!(retry.publish_state, "ready");
        assert_eq!(retry.completed_outputs_json.as_deref(), Some("[]"));
        assert_eq!(retry.publish_next_attempt_at_ms, Some(2200));

        db.update_build_job_phase("build-1", "uploading_logs", None, 1, None, 2300)
            .unwrap();
        assert_eq!(db.reset_active_build_jobs(2400).unwrap(), 1);
        let resumed_after_logs = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(resumed_after_logs.phase, "publishing");
        assert_eq!(resumed_after_logs.publish_state, "ready");
        assert_eq!(
            resumed_after_logs.completed_outputs_json.as_deref(),
            Some("[]")
        );
    }

    #[test]
    fn resets_active_builds_after_restart() {
        let db = BuilderDb::open_in_memory().unwrap();
        let active = build("build-active");
        let terminal = build("build-terminal");
        db.upsert_build_job(&active, "building", 1, None, 1000)
            .unwrap();
        db.update_build_job_phase("build-active", "publishing", None, 1, None, 2000)
            .unwrap();
        db.upsert_build_job(&terminal, "succeeded", 1, None, 1000)
            .unwrap();

        let reset = db.reset_active_build_jobs(3000).unwrap();

        assert_eq!(reset, 1);
        let active = db.load_build_job("build-active").unwrap().unwrap();
        assert_eq!(active.phase, "queued");
        assert_eq!(
            active.error.as_deref(),
            Some("builder daemon restarted while build was publishing")
        );
        assert_eq!(active.next_attempt_at_ms, Some(3000));
        let terminal = db.load_build_job("build-terminal").unwrap().unwrap();
        assert_eq!(terminal.phase, "succeeded");
    }

    fn build(build_id: &str) -> intar_contracts::bridge::DesiredBuildV1 {
        intar_contracts::bridge::DesiredBuildV1 {
            build_id: build_id.to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
        }
    }
}
