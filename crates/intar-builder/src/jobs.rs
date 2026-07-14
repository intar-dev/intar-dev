#![allow(clippy::missing_errors_doc)]
#![allow(dead_code)]

use std::collections::HashSet;

use anyhow::Result;
use intar_contracts::bridge::DesiredBuildV1;

use crate::db::BuilderDb;

pub fn reconcile_desired_builds(
    db: &BuilderDb,
    desired_builds: &[DesiredBuildV1],
    now_ms: i64,
) -> Result<usize> {
    let mut inserted = 0;
    let desired_build_ids = desired_builds
        .iter()
        .map(|build| build.build_id.as_str())
        .collect::<HashSet<_>>();

    for job in db.list_build_jobs()? {
        if !desired_build_ids.contains(job.build_id.as_str()) {
            db.delete_build_job(&job.build_id)?;
        }
    }

    for build in desired_builds {
        if let Some(existing) = db.load_build_job(&build.build_id)? {
            let needs_queue_refresh = (existing.phase == "queued"
                && existing.desired_build() != *build)
                || existing.phase == "failed";
            if needs_queue_refresh {
                db.upsert_build_job(build, "queued", 0, None, now_ms)?;
            }
            continue;
        }
        db.upsert_build_job(build, "queued", 0, None, now_ms)?;
        inserted += 1;
    }
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use intar_contracts::bridge::DesiredBuildV1;
    use intar_contracts::catalog::ImageArchitecture;

    use crate::db::BuilderDb;
    use crate::jobs::reconcile_desired_builds;

    #[test]
    fn inserts_new_desired_builds_as_queued() {
        let db = BuilderDb::open_in_memory().unwrap();
        let inserted = reconcile_desired_builds(&db, &[desired_build("build-1")], 1000).unwrap();

        assert_eq!(inserted, 1);
        let job = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(job.phase, "queued");
        assert_eq!(job.attempt, 0);
    }

    #[test]
    fn preserves_existing_build_progress() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = desired_build("build-1");
        db.upsert_build_job(&build, "building", 2, None, 1000)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, &[build], 2000).unwrap();

        assert_eq!(inserted, 0);
        let job = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(job.phase, "building");
        assert_eq!(job.attempt, 2);
        assert_eq!(job.updated_at_ms, 1000);
    }

    #[test]
    fn refreshes_queued_build_payload_when_desired_state_changes() {
        let db = BuilderDb::open_in_memory().unwrap();
        let original = desired_build("build-1");
        let mut updated = desired_build("build-1");
        updated.rev = "def456".to_string();
        updated.bundle_ref = "builds/bundles/def456.tar.gz".to_string();
        updated.content_hash = "a".repeat(64);
        db.upsert_build_job(&original, "queued", 0, None, 1000)
            .unwrap();
        db.schedule_build_job_retry("build-1", 1, "retry later", 5000, 1500)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, &[updated], 2000).unwrap();

        assert_eq!(inserted, 0);
        let job = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(job.phase, "queued");
        assert_eq!(job.attempt, 0);
        assert_eq!(job.error, None);
        assert_eq!(job.rev, "def456");
        assert_eq!(job.bundle_ref, "builds/bundles/def456.tar.gz");
        assert_eq!(job.content_hash, "a".repeat(64));
        assert_eq!(job.next_attempt_at_ms, None);
        assert_eq!(job.updated_at_ms, 2000);
    }

    #[test]
    fn keeps_retry_schedule_for_unchanged_queued_build() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = desired_build("build-1");
        db.upsert_build_job(&build, "queued", 0, None, 1000)
            .unwrap();
        db.schedule_build_job_retry("build-1", 1, "retry later", 5000, 1500)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, &[build], 2000).unwrap();

        assert_eq!(inserted, 0);
        let job = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(job.phase, "queued");
        assert_eq!(job.attempt, 1);
        assert_eq!(job.error.as_deref(), Some("retry later"));
        assert_eq!(job.next_attempt_at_ms, Some(5000));
        assert_eq!(job.updated_at_ms, 1500);
    }

    #[test]
    fn requeues_failed_job_when_desired_state_contains_it_again() {
        let db = BuilderDb::open_in_memory().unwrap();
        let build = desired_build("build-1");
        db.upsert_build_job(&build, "failed", 3, Some("previous failure"), 1000)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, std::slice::from_ref(&build), 2000).unwrap();

        assert_eq!(inserted, 0);
        let job = db.load_build_job("build-1").unwrap().unwrap();
        assert_eq!(job.phase, "queued");
        assert_eq!(job.attempt, 0);
        assert_eq!(job.error, None);
        assert_eq!(job.next_attempt_at_ms, None);
        assert_eq!(job.updated_at_ms, 2000);
    }

    #[test]
    fn removes_queued_and_active_builds_missing_from_desired_state() {
        let db = BuilderDb::open_in_memory().unwrap();
        let keep = desired_build("keep");
        let remove = desired_build("remove");
        let active = desired_build("active");
        db.upsert_build_job(&keep, "queued", 0, None, 1000).unwrap();
        db.upsert_build_job(&remove, "queued", 0, None, 1000)
            .unwrap();
        db.upsert_build_job(&active, "building", 1, None, 1000)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, std::slice::from_ref(&keep), 2000).unwrap();

        assert_eq!(inserted, 0);
        assert!(db.load_build_job("keep").unwrap().is_some());
        assert!(db.load_build_job("remove").unwrap().is_none());
        assert!(db.load_build_job("active").unwrap().is_none());
    }

    #[test]
    fn removes_terminal_builds_missing_from_desired_state() {
        let db = BuilderDb::open_in_memory().unwrap();
        let keep = desired_build("keep");
        let succeeded = desired_build("succeeded");
        let failed = desired_build("failed");
        db.upsert_build_job(&keep, "queued", 0, None, 1000).unwrap();
        db.upsert_build_job(&succeeded, "succeeded", 1, None, 1000)
            .unwrap();
        db.upsert_build_job(&failed, "failed", 3, Some("boom"), 1000)
            .unwrap();

        let inserted = reconcile_desired_builds(&db, std::slice::from_ref(&keep), 2000).unwrap();

        assert_eq!(inserted, 0);
        assert!(db.load_build_job("keep").unwrap().is_some());
        assert!(db.load_build_job("succeeded").unwrap().is_none());
        assert!(db.load_build_job("failed").unwrap().is_none());
    }

    fn desired_build(build_id: &str) -> DesiredBuildV1 {
        DesiredBuildV1 {
            build_id: build_id.to_string(),
            scenario_id: "broken-nginx".to_string(),
            arch: ImageArchitecture::X86_64,
            rev: "abc123".to_string(),
            content_hash: "f".repeat(64),
            bundle_ref: "builds/bundles/abc123.tar.gz".to_string(),
            kino_version: "0.1.24".to_string(),
        }
    }
}
