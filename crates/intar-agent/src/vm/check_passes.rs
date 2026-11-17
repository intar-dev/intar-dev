#![forbid(unsafe_code)]

//! When each task of a VM first passed, kept in the VM's artifact
//! spool while it runs so the replay renderer can write the passes into the
//! session casts as asciicast `m` (marker) events. The file stays on the
//! host: only logs and `.krec` recordings are collected for upload.
//!
//! Times are guest wall-clock milliseconds, the clock kino also stamps its
//! session recordings with, so a pass lines up with the recording it
//! happened in.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

#[cfg(any(test, target_os = "linux"))]
use anyhow::{Context as _, Result};
#[cfg(any(test, target_os = "linux"))]
use intar_contracts::bridge_v9::{CheckStatus, VmTaskV1};
use tracing::warn;

pub(crate) const CHECK_PASSES_FILENAME: &str = "check-passes.json";

/// Task id to the guest unix time (ms) of its first pass.
pub(crate) type CheckPasses = BTreeMap<String, u64>;

/// Adds every passing task that has no recorded pass yet; a task that
/// passes, fails and passes again keeps its first time. True when anything
/// was added.
#[cfg(any(test, target_os = "linux"))]
pub(crate) fn merge_first_passes(passes: &mut CheckPasses, tasks: &[VmTaskV1]) -> bool {
    let mut changed = false;
    for task in tasks {
        if task.status != CheckStatus::Pass || passes.contains_key(&task.id) {
            continue;
        }
        let Some(at_ms) = task.passed_at_unix_ms else {
            continue;
        };
        passes.insert(task.id.clone(), at_ms);
        changed = true;
    }
    changed
}

/// Records the first passes in `tasks` beside the VM's artifacts. Most
/// reports add nothing and write nothing; a write replaces the file
/// atomically, so a crash never leaves half a document.
#[cfg(any(test, target_os = "linux"))]
pub(crate) async fn record_check_passes(artifacts_dir: &Path, tasks: &[VmTaskV1]) -> Result<()> {
    if !tasks.iter().any(|task| task.status == CheckStatus::Pass) {
        return Ok(());
    }
    let path = artifacts_dir.join(CHECK_PASSES_FILENAME);
    let mut passes = match tokio::fs::read(&path).await {
        Ok(bytes) => parse_check_passes(&bytes, &path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CheckPasses::new(),
        Err(error) => {
            return Err(error).with_context(|| format!("failed to read {}", path.display()));
        }
    };
    if !merge_first_passes(&mut passes, tasks) {
        return Ok(());
    }
    tokio::fs::create_dir_all(artifacts_dir)
        .await
        .with_context(|| format!("failed to create {}", artifacts_dir.display()))?;
    let temp = artifacts_dir.join(format!("{CHECK_PASSES_FILENAME}.tmp"));
    let body = serde_json::to_vec(&passes).context("failed to serialize check passes")?;
    tokio::fs::write(&temp, body)
        .await
        .with_context(|| format!("failed to write {}", temp.display()))?;
    tokio::fs::rename(&temp, &path)
        .await
        .with_context(|| format!("failed to replace {}", path.display()))
}

/// The recorded passes, or none: a missing or unreadable file only costs the
/// replay its check markers.
pub(crate) fn load_check_passes(artifacts_dir: &Path) -> CheckPasses {
    let path = artifacts_dir.join(CHECK_PASSES_FILENAME);
    match std::fs::read(&path) {
        Ok(bytes) => parse_check_passes(&bytes, &path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => CheckPasses::new(),
        Err(error) => {
            warn!(path = %path.display(), error = %error, "failed to read check passes");
            CheckPasses::new()
        }
    }
}

fn parse_check_passes(bytes: &[u8], path: &Path) -> CheckPasses {
    serde_json::from_slice(bytes).unwrap_or_else(|error| {
        warn!(path = %path.display(), error = %error, "ignoring unreadable check passes");
        CheckPasses::new()
    })
}

/// The passes that belong to a session starting at `start_ms`, as offsets in
/// seconds from its start, in time order. A session owns the passes from its
/// start until the next session starts (`next_start_ms`), so a check that
/// passed after the last keystroke still marks the session that caused it.
pub(crate) fn session_check_markers(
    passes: &CheckPasses,
    start_ms: u64,
    next_start_ms: Option<u64>,
) -> Vec<(f64, String)> {
    let mut markers = passes
        .iter()
        .filter(|&(_, &at_ms)| at_ms >= start_ms && next_start_ms.is_none_or(|next| at_ms < next))
        .map(|(id, &at_ms)| {
            (
                Duration::from_millis(at_ms - start_ms).as_secs_f64(),
                id.clone(),
            )
        })
        .collect::<Vec<_>>();
    markers.sort_by(|left, right| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    });
    markers
}

#[cfg(test)]
mod tests {
    use anyhow::Result;
    use intar_contracts::bridge_v9::{CheckStatus, VmTaskV1};

    use super::{
        CHECK_PASSES_FILENAME, CheckPasses, load_check_passes, merge_first_passes,
        record_check_passes, session_check_markers,
    };

    fn task(id: &str, status: CheckStatus, passed_at_unix_ms: Option<u64>) -> VmTaskV1 {
        VmTaskV1 {
            id: id.to_string(),
            status,
            message: String::new(),
            passed_at_unix_ms,
        }
    }

    #[test]
    fn keeps_the_first_pass_of_each_task() {
        let mut passes = CheckPasses::new();
        assert!(merge_first_passes(
            &mut passes,
            &[
                task("nginx", CheckStatus::Pass, Some(1_000)),
                task("site", CheckStatus::Fail, None)
            ],
        ));
        // A later report where it still (or again) passes changes nothing.
        assert!(!merge_first_passes(
            &mut passes,
            &[task("nginx", CheckStatus::Pass, Some(9_000))],
        ));
        // A pass without a pass time is not recorded.
        assert!(!merge_first_passes(
            &mut passes,
            &[task("site", CheckStatus::Pass, None)],
        ));
        assert!(merge_first_passes(
            &mut passes,
            &[task("site", CheckStatus::Pass, Some(4_000))],
        ));
        assert_eq!(
            passes,
            CheckPasses::from([("nginx".to_string(), 1_000), ("site".to_string(), 4_000)])
        );
    }

    #[tokio::test]
    async fn records_passes_across_reports_and_reads_them_back() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let artifacts = dir.path().join("artifacts");

        record_check_passes(&artifacts, &[task("nginx", CheckStatus::Fail, None)]).await?;
        assert!(!artifacts.join(CHECK_PASSES_FILENAME).exists());

        record_check_passes(&artifacts, &[task("nginx", CheckStatus::Pass, Some(7_000))]).await?;
        record_check_passes(
            &artifacts,
            &[
                task("nginx", CheckStatus::Pass, Some(8_000)),
                task("site", CheckStatus::Pass, Some(21_000)),
            ],
        )
        .await?;

        assert_eq!(
            load_check_passes(&artifacts),
            CheckPasses::from([("nginx".to_string(), 7_000), ("site".to_string(), 21_000)])
        );
        Ok(())
    }

    #[test]
    fn a_missing_or_corrupt_file_reads_as_no_passes() -> Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(load_check_passes(dir.path()).is_empty());
        std::fs::write(dir.path().join(CHECK_PASSES_FILENAME), "{not json")?;
        assert!(load_check_passes(dir.path()).is_empty());
        Ok(())
    }

    #[test]
    fn a_session_owns_the_passes_until_the_next_one_starts() {
        let passes = CheckPasses::from([
            ("before".to_string(), 500),
            ("first".to_string(), 3_000),
            ("late".to_string(), 1_500),
            ("second".to_string(), 12_000),
        ]);
        assert_eq!(
            session_check_markers(&passes, 1_000, Some(10_000)),
            vec![(0.5, "late".to_string()), (2.0, "first".to_string())]
        );
        assert_eq!(
            session_check_markers(&passes, 10_000, None),
            vec![(2.0, "second".to_string())]
        );
    }
}
