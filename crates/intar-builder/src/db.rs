//! The builder's local state: a disposable cache of the last desired state
//! and of each desired build's latest report. The Worker owns every build;
//! a file of another schema is dropped and recreated, never migrated.

use std::path::Path;

use anyhow::{Context, Result};
use intar_contracts::bridge_v9::{BuildPhaseV2, BuildReportV2, DesiredBuildV2};
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use tracing::info;

/// `PRAGMA user_version` of this layout. Bump it whenever a table changes.
pub const SCHEMA_VERSION: i64 = 2;

const SCHEMA_SQL: &str = r"
CREATE TABLE IF NOT EXISTS desired_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL,
  doc_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS builds (
  build_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  desired_json TEXT NOT NULL,
  report_json TEXT NOT NULL
);
";

#[derive(Debug)]
pub struct BuilderDb {
    conn: Connection,
}

impl BuilderDb {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("failed to create '{}'", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open builder db '{}'", path.display()))?;
        Self::with(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        Self::with(Connection::open_in_memory().context("failed to open an in-memory db")?)
    }

    fn with(mut conn: Connection) -> Result<Self> {
        conn.busy_timeout(std::time::Duration::from_secs(30))
            .context("failed to configure the builder db busy timeout")?;
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .context("failed to configure the builder db")?;
        ensure_schema(&mut conn)?;
        Ok(Self { conn })
    }

    pub fn load_desired_state(&self) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT doc_json FROM desired_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .context("failed to load the cached desired state")
    }

    pub fn save_desired_state(&self, version: u64, doc_json: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO desired_state (id, version, doc_json) VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET version = excluded.version, doc_json = excluded.doc_json",
                params![i64::try_from(version).unwrap_or(i64::MAX), doc_json],
            )
            .context("failed to cache the desired state")?;
        Ok(())
    }

    /// Keep exactly the desired builds. A build that is new, or whose
    /// desired form changed (a new attempt), is queued afresh; the rest keep
    /// their progress. Returns how many were queued.
    pub fn reconcile(&self, desired: &[DesiredBuildV2], now_ms: i64) -> Result<usize> {
        let tx = self
            .conn
            .unchecked_transaction()
            .context("failed to begin reconcile")?;
        let existing: Vec<(String, String)> = {
            let mut stmt = tx.prepare("SELECT build_id, desired_json FROM builds")?;
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (build_id, _) in &existing {
            if !desired.iter().any(|build| &build.build_id == build_id) {
                tx.execute("DELETE FROM builds WHERE build_id = ?1", [build_id])?;
            }
        }
        let mut queued = 0;
        for build in desired {
            let desired_json = serde_json::to_string(build)?;
            if existing
                .iter()
                .any(|(id, json)| id == &build.build_id && json == &desired_json)
            {
                continue;
            }
            let report = report(build, BuildPhaseV2::Queued, now_ms);
            tx.execute(
                "INSERT OR REPLACE INTO builds (build_id, phase, desired_json, report_json)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    build.build_id,
                    phase_name(BuildPhaseV2::Queued),
                    desired_json,
                    serde_json::to_string(&report)?
                ],
            )?;
            queued += 1;
        }
        tx.commit().context("failed to commit reconcile")?;
        Ok(queued)
    }

    /// Take the oldest queued build and mark it fetching.
    pub fn claim_next(&mut self, now_ms: i64) -> Result<Option<DesiredBuildV2>> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .context("failed to begin claim")?;
        let row: Option<String> = tx
            .query_row(
                "SELECT desired_json FROM builds WHERE phase = ?1 ORDER BY rowid LIMIT 1",
                [phase_name(BuildPhaseV2::Queued)],
                |row| row.get(0),
            )
            .optional()?;
        let Some(desired_json) = row else {
            return Ok(None);
        };
        let build: DesiredBuildV2 = serde_json::from_str(&desired_json)?;
        let mut claimed = report(&build, BuildPhaseV2::FetchingSources, now_ms);
        claimed.started_at_unix_ms = Some(now_ms);
        write_report(&tx, &claimed)?;
        tx.commit().context("failed to commit claim")?;
        Ok(Some(build))
    }

    /// Record `report` while its build and attempt are still desired.
    pub fn record(&self, report: &BuildReportV2) -> Result<bool> {
        write_report(&self.conn, report)
    }

    #[cfg(test)]
    pub fn report(&self, build_id: &str) -> Result<Option<BuildReportV2>> {
        let json: Option<String> = self
            .conn
            .query_row(
                "SELECT report_json FROM builds WHERE build_id = ?1",
                [build_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| serde_json::from_str(&json).context("invalid cached build report"))
            .transpose()
    }

    pub fn reports(&self) -> Result<Vec<BuildReportV2>> {
        let mut stmt = self
            .conn
            .prepare("SELECT report_json FROM builds ORDER BY rowid")?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.iter()
            .map(|json| serde_json::from_str(json).context("invalid cached build report"))
            .collect()
    }

    /// A build that was running when the builder stopped runs again.
    pub fn requeue_running(&self, now_ms: i64) -> Result<usize> {
        let mut requeued = 0;
        let running: Vec<String> = {
            let mut stmt = self
                .conn
                .prepare("SELECT desired_json FROM builds WHERE phase IN (?1, ?2, ?3)")?;
            stmt.query_map(
                [
                    phase_name(BuildPhaseV2::FetchingSources),
                    phase_name(BuildPhaseV2::Building),
                    phase_name(BuildPhaseV2::Pushing),
                ],
                |row| row.get(0),
            )?
            .collect::<rusqlite::Result<_>>()?
        };
        for desired_json in running {
            let build: DesiredBuildV2 = serde_json::from_str(&desired_json)?;
            write_report(&self.conn, &report(&build, BuildPhaseV2::Queued, now_ms))?;
            requeued += 1;
        }
        Ok(requeued)
    }
}

/// A fresh report of `build` in `phase`.
#[must_use]
pub fn report(build: &DesiredBuildV2, phase: BuildPhaseV2, now_ms: i64) -> BuildReportV2 {
    BuildReportV2 {
        build_id: build.build_id.clone(),
        build_key: build.build_key.clone(),
        attempt: build.attempt,
        phase,
        observed_at_unix_ms: now_ms,
        started_at_unix_ms: None,
        finished_at_unix_ms: None,
        error: None,
        image_digest: None,
    }
}

fn write_report(conn: &Connection, report: &BuildReportV2) -> Result<bool> {
    let desired_json: Option<String> = conn
        .query_row(
            "SELECT desired_json FROM builds WHERE build_id = ?1",
            [&report.build_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(desired_json) = desired_json else {
        return Ok(false);
    };
    let desired: DesiredBuildV2 = serde_json::from_str(&desired_json)?;
    if desired.attempt != report.attempt || desired.build_key != report.build_key {
        return Ok(false);
    }
    conn.execute(
        "UPDATE builds SET phase = ?2, report_json = ?3 WHERE build_id = ?1",
        params![
            report.build_id,
            phase_name(report.phase),
            serde_json::to_string(report)?
        ],
    )?;
    Ok(true)
}

fn phase_name(phase: BuildPhaseV2) -> &'static str {
    match phase {
        BuildPhaseV2::Queued => "queued",
        BuildPhaseV2::FetchingSources => "fetching_sources",
        BuildPhaseV2::Building => "building",
        BuildPhaseV2::Pushing => "pushing",
        BuildPhaseV2::Succeeded => "succeeded",
        BuildPhaseV2::Failed => "failed",
    }
}

/// Bring the file to [`SCHEMA_VERSION`]; a file of another version loses
/// every table first. Nothing here is migrated: the Worker re-sends the
/// desired state and the builds it still wants.
fn ensure_schema(conn: &mut Connection) -> Result<()> {
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .context("failed to read the builder db schema marker")?;
    if version == SCHEMA_VERSION {
        return conn
            .execute_batch(SCHEMA_SQL)
            .context("failed to apply the builder db schema");
    }
    let tx = conn
        .transaction()
        .context("failed to begin the schema reset")?;
    let tables: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        stmt.query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?
    };
    for table in &tables {
        tx.execute_batch(&format!("DROP TABLE \"{}\";", table.replace('"', "\"\"")))
            .with_context(|| format!("failed to drop table {table}"))?;
    }
    tx.execute_batch(&format!(
        "{SCHEMA_SQL}PRAGMA user_version = {SCHEMA_VERSION};"
    ))
    .context("failed to apply the builder db schema")?;
    tx.commit().context("failed to commit the schema reset")?;
    if !tables.is_empty() {
        info!(
            from = version,
            to = SCHEMA_VERSION,
            dropped_tables = tables.len(),
            "builder state schema changed; dropped the cached state"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use intar_contracts::bridge_v9::{BuildPhaseV2, BuildTargetV1, DesiredBuildV2};
    use intar_contracts::oci::OciDigest;

    use super::{BuilderDb, SCHEMA_VERSION, report};

    fn build(id: &str, attempt: u32) -> DesiredBuildV2 {
        DesiredBuildV2 {
            build_id: id.to_owned(),
            build_key: OciDigest::from_sha256(&[7; 32]),
            bundle_rev: "rev-1".to_owned(),
            target: BuildTargetV1::Machine {
                scenario: "broken-nginx".to_owned(),
                machine: "web".to_owned(),
            },
            attempt,
        }
    }

    #[test]
    fn another_schema_is_dropped_and_recreated() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.sqlite3");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE build_jobs (build_id TEXT, content_hash TEXT);
                 INSERT INTO build_jobs VALUES ('old', 'x');
                 CREATE TABLE desired_state (id INTEGER, legacy TEXT);",
            )
            .unwrap();
        }
        let db = BuilderDb::open(&path).unwrap();
        db.reconcile(&[build("b-1", 1)], 1).unwrap();
        drop(db);

        let conn = rusqlite::Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let old: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'build_jobs'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);

        // The same version is kept as it is.
        let db = BuilderDb::open(&path).unwrap();
        assert_eq!(db.reports().unwrap().len(), 1);
    }

    #[test]
    fn a_new_attempt_requeues_and_a_dropped_build_goes() {
        let mut db = BuilderDb::open_in_memory().unwrap();
        assert_eq!(db.reconcile(&[build("a", 1), build("b", 1)], 1).unwrap(), 2);
        let claimed = db.claim_next(2).unwrap().unwrap();
        assert_eq!(claimed.build_id, "a");
        let mut failed = report(&claimed, BuildPhaseV2::Failed, 3);
        failed.error = Some("boom".to_owned());
        assert!(db.record(&failed).unwrap());

        // Unchanged: progress stays.
        assert_eq!(db.reconcile(&[build("a", 1), build("b", 1)], 4).unwrap(), 0);
        assert_eq!(db.report("a").unwrap().unwrap().phase, BuildPhaseV2::Failed);

        // A new attempt queues again; b left the desired state.
        assert_eq!(db.reconcile(&[build("a", 2)], 5).unwrap(), 1);
        assert_eq!(db.report("a").unwrap().unwrap().phase, BuildPhaseV2::Queued);
        assert!(db.report("b").unwrap().is_none());
        // A late report of the old attempt is dropped.
        assert!(!db.record(&failed).unwrap());
    }

    #[test]
    fn a_running_build_runs_again_after_a_restart() {
        let mut db = BuilderDb::open_in_memory().unwrap();
        db.reconcile(&[build("a", 1)], 1).unwrap();
        db.claim_next(2).unwrap().unwrap();
        assert!(db.claim_next(3).unwrap().is_none());
        assert_eq!(db.requeue_running(4).unwrap(), 1);
        assert_eq!(db.claim_next(5).unwrap().unwrap().build_id, "a");
    }
}
