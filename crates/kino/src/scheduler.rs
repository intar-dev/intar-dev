use crate::probe::{ProbeDefinition, ProbeStatus};
use crate::state::{ProbeStore, ProbeUpdate, duration_millis_u64, unix_time_ms};
#[cfg(test)]
use futures_util::future::join_all;
use futures_util::stream::{FuturesUnordered, StreamExt as _};
use intar_contracts::run_cli::RUN_CLI_MAX_PROBE_IDS;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

/// Runs scheduled and learner-requested probes through the same per-probe
/// locks. A learner check must be fresh, but it must not start a second copy
/// of a slow probe that the scheduler already has in flight.
#[derive(Clone)]
pub(crate) struct ProbeExecutor {
    probes: Arc<BTreeMap<String, Arc<ProbeDefinition>>>,
    probe_locks: Arc<BTreeMap<String, Arc<Mutex<()>>>>,
    manual_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManualProbeResult {
    pub(crate) id: String,
    pub(crate) status: ProbeStatus,
    pub(crate) duration_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ProbeExecutionResult {
    status: ProbeStatus,
    duration_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum ManualProbeError {
    #[error("a manual check must select at least one probe")]
    EmptySelection,
    #[error("manual check selected too many probes")]
    TooManyProbes,
    #[error("manual check selected an unknown probe")]
    UnknownProbe,
    #[error("manual check selected the same probe more than once")]
    DuplicateProbe,
    #[error("another manual check is already running")]
    Busy,
}

impl ProbeExecutor {
    pub(crate) fn new(probes: &[Arc<ProbeDefinition>]) -> Self {
        let probes = probes
            .iter()
            .map(|probe| (probe.id().to_owned(), Arc::clone(probe)))
            .collect::<BTreeMap<_, _>>();
        let probe_locks = probes
            .keys()
            .map(|id| (id.clone(), Arc::new(Mutex::new(()))))
            .collect::<BTreeMap<_, _>>();

        Self {
            probes: Arc::new(probes),
            probe_locks: Arc::new(probe_locks),
            manual_lock: Arc::new(Mutex::new(())),
        }
    }

    async fn run_one(
        &self,
        probe: &Arc<ProbeDefinition>,
        store: &ProbeStore,
    ) -> ProbeExecutionResult {
        let Some(lock) = self.probe_locks.get(probe.id()) else {
            // ProbeExecutor is built from the same definitions. This branch is
            // defensive only; returning Fail keeps a malformed service from
            // claiming a successful check.
            return ProbeExecutionResult {
                status: ProbeStatus::Fail,
                duration_ms: 0,
            };
        };
        let _guard = lock.lock().await;
        run_probe_once(probe, store).await
    }

    /// Run a bounded, fresh, explicit selection. A second manual batch fails
    /// immediately instead of queuing behind the control deadline; per-probe
    /// locks still fence the background scheduler.
    #[cfg(test)]
    pub(crate) async fn run_manual(
        &self,
        probe_ids: &[String],
        store: &ProbeStore,
    ) -> Result<Vec<ManualProbeResult>, ManualProbeError> {
        let selected = self.select_manual_probes(probe_ids)?;
        let _manual_guard = self
            .manual_lock
            .try_lock()
            .map_err(|_| ManualProbeError::Busy)?;
        // One learner action executes its distinct selected probes together.
        // `run_one` still takes each per-probe lock, so this cannot overlap a
        // scheduled execution of that probe. `join_all` preserves the input
        // order for callers that need a completed batch.
        Ok(join_all(
            selected
                .into_iter()
                .map(|probe| async move { self.manual_result_for(&probe, store).await }),
        )
        .await)
    }

    /// Execute the selected probes concurrently and publish each real result
    /// as it completes. This keeps one manual batch serialized while allowing
    /// the CLI to show a fast probe before a slow, unrelated one finishes.
    pub(crate) async fn run_manual_stream(
        &self,
        probe_ids: &[String],
        store: &ProbeStore,
        results: tokio::sync::mpsc::Sender<ManualProbeResult>,
    ) -> Result<(), ManualProbeError> {
        let selected = self.select_manual_probes(probe_ids)?;
        let _manual_guard = self
            .manual_lock
            .try_lock()
            .map_err(|_| ManualProbeError::Busy)?;
        let mut in_flight = FuturesUnordered::new();
        for probe in selected {
            in_flight.push(async move { self.manual_result_for(&probe, store).await });
        }
        while let Some(result) = in_flight.next().await {
            if results.send(result).await.is_err() {
                // The learner disconnected. Dropping in-flight futures stops
                // work that no caller can observe; the scheduler remains live.
                return Ok(());
            }
        }
        Ok(())
    }

    fn select_manual_probes(
        &self,
        probe_ids: &[String],
    ) -> Result<Vec<Arc<ProbeDefinition>>, ManualProbeError> {
        if probe_ids.is_empty() {
            return Err(ManualProbeError::EmptySelection);
        }
        if probe_ids.len() > RUN_CLI_MAX_PROBE_IDS {
            return Err(ManualProbeError::TooManyProbes);
        }

        let mut seen = BTreeSet::new();
        probe_ids
            .iter()
            .map(|id| {
                if !seen.insert(id) {
                    return Err(ManualProbeError::DuplicateProbe);
                }
                self.probes
                    .get(id)
                    .cloned()
                    .ok_or(ManualProbeError::UnknownProbe)
            })
            .collect::<Result<Vec<_>, _>>()
    }

    async fn manual_result_for(
        &self,
        probe: &Arc<ProbeDefinition>,
        store: &ProbeStore,
    ) -> ManualProbeResult {
        let outcome = self.run_one(probe, store).await;
        ManualProbeResult {
            id: probe.id().to_owned(),
            status: outcome.status,
            duration_ms: outcome.duration_ms,
        }
    }
}

pub(crate) fn spawn_probe_tasks(
    probes: Vec<Arc<ProbeDefinition>>,
    store: &ProbeStore,
    executor: ProbeExecutor,
) -> Vec<JoinHandle<()>> {
    probes
        .into_iter()
        .map(|probe| {
            let store_clone = (*store).clone();
            let executor_clone = executor.clone();
            tokio::spawn(async move {
                run_probe_loop(probe, store_clone, executor_clone).await;
            })
        })
        .collect()
}

async fn run_probe_loop(probe: Arc<ProbeDefinition>, store: ProbeStore, executor: ProbeExecutor) {
    let mut ticker = tokio::time::interval(probe.every());
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        executor.run_one(&probe, &store).await;
    }
}

async fn run_probe_once(probe: &ProbeDefinition, store: &ProbeStore) -> ProbeExecutionResult {
    let attempt_started = SystemTime::now();
    let attempt_started_unix_ms = unix_time_ms(attempt_started);
    let timer_started = Instant::now();

    let timeout_duration = probe.timeout();
    let timed_result = tokio::time::timeout(timeout_duration, probe.run()).await;
    let duration_ms = duration_millis_u64(timer_started.elapsed());

    let update = match timed_result {
        Ok(result) => ProbeUpdate {
            status: result.status,
            value: Some(result.value),
            error: result.error,
            attempted_at_unix_ms: attempt_started_unix_ms,
            duration_ms,
        },
        Err(_) => ProbeUpdate {
            status: ProbeStatus::Fail,
            value: None,
            error: Some(format!(
                "probe execution timed out after {}s",
                timeout_duration.as_secs()
            )),
            attempted_at_unix_ms: attempt_started_unix_ms,
            duration_ms,
        },
    };

    let status = update.status;
    store.apply_update(probe.id(), update).await;
    ProbeExecutionResult {
        status,
        duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::{ManualProbeError, ProbeExecutor};
    use crate::config::{ProbeConfig, ProbeKindConfig};
    use crate::probe::{ProbeStatus, build_probes};
    use crate::state::ProbeStore;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn manual_checks_are_fresh_and_update_the_shared_store() {
        let temp = tempfile::tempdir().expect("tempdir");
        let present = temp.path().join("present");
        std::fs::write(&present, "ok").expect("write fixture");
        let configs = vec![ProbeConfig {
            id: "safe-check".to_owned(),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(1),
            intar: crate::config::IntarProbeMetadata::default(),
            kind: ProbeKindConfig::FileExists { path: present },
        }];
        let probes = build_probes(&configs)
            .await
            .expect("build probe")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let store = ProbeStore::new(&probes);
        let executor = ProbeExecutor::new(&probes);

        let result = executor
            .run_manual(&["safe-check".to_owned()], &store)
            .await
            .expect("run manual probe");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].status, ProbeStatus::Pass);

        let snapshot = store.snapshot_proto_with_host_keys(Vec::new()).await;
        assert_eq!(snapshot.probes[0].status, 1);
        assert_ne!(snapshot.probes[0].last_attempt_unix_ms, 0);
    }

    #[tokio::test]
    async fn manual_checks_reject_empty_duplicate_and_unknown_probe_ids() {
        let configs = vec![ProbeConfig {
            id: "known".to_owned(),
            every: Duration::from_secs(60),
            timeout: Duration::from_secs(1),
            intar: crate::config::IntarProbeMetadata::default(),
            kind: ProbeKindConfig::FileExists {
                path: "/dev/null".into(),
            },
        }];
        let probes = build_probes(&configs)
            .await
            .expect("build probe")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let store = ProbeStore::new(&probes);
        let executor = ProbeExecutor::new(&probes);

        assert!(matches!(
            executor.run_manual(&[], &store).await,
            Err(ManualProbeError::EmptySelection)
        ));
        assert!(matches!(
            executor.run_manual(&["missing".to_owned()], &store).await,
            Err(ManualProbeError::UnknownProbe)
        ));
        assert!(matches!(
            executor
                .run_manual(&["known".to_owned(), "known".to_owned()], &store)
                .await,
            Err(ManualProbeError::DuplicateProbe)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn manual_checks_run_distinct_slow_probes_concurrently() {
        let configs = (1..=3)
            .map(|index| ProbeConfig {
                id: format!("slow-{index}"),
                every: Duration::from_secs(60),
                timeout: Duration::from_millis(120),
                intar: crate::config::IntarProbeMetadata::default(),
                kind: ProbeKindConfig::CommandJsonPath {
                    argv: vec![
                        "/bin/sh".to_owned(),
                        "-c".to_owned(),
                        "sleep 0.25; printf '{\"passed\":true}'".to_owned(),
                    ],
                    json_path: "$.passed".to_owned(),
                    expected: Some(serde_json::json!(true)),
                },
            })
            .collect::<Vec<_>>();
        let probes = build_probes(&configs)
            .await
            .expect("build probes")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let store = ProbeStore::new(&probes);
        let executor = ProbeExecutor::new(&probes);
        let ids = configs
            .iter()
            .map(|config| config.id.clone())
            .collect::<Vec<_>>();

        let started = std::time::Instant::now();
        let results = executor
            .run_manual(&ids, &store)
            .await
            .expect("manual checks complete");
        let elapsed = started.elapsed();

        assert_eq!(results.len(), 3);
        assert!(
            results
                .iter()
                .all(|result| result.status == ProbeStatus::Fail)
        );
        // Serial execution would take roughly 3 × 120 ms. Allow headroom for
        // slower CI, while still proving the checks overlap.
        assert!(elapsed < Duration::from_millis(300), "elapsed: {elapsed:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_second_manual_batch_is_busy_instead_of_queuing_behind_the_deadline() {
        let temp = tempfile::tempdir().expect("tempdir");
        let started_path = temp.path().join("started");
        let slow_command = format!(
            "printf started > '{}'; sleep 0.2; printf '{{\"passed\":true}}'",
            started_path.display()
        );
        let configs = vec![
            ProbeConfig {
                id: "slow".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(1),
                intar: crate::config::IntarProbeMetadata::default(),
                kind: ProbeKindConfig::CommandJsonPath {
                    argv: vec!["/bin/sh".to_owned(), "-c".to_owned(), slow_command],
                    json_path: "$.passed".to_owned(),
                    expected: Some(serde_json::json!(true)),
                },
            },
            ProbeConfig {
                id: "fast".to_owned(),
                every: Duration::from_secs(60),
                timeout: Duration::from_secs(1),
                intar: crate::config::IntarProbeMetadata::default(),
                kind: ProbeKindConfig::FileExists {
                    path: "/dev/null".into(),
                },
            },
        ];
        let probes = build_probes(&configs)
            .await
            .expect("build probes")
            .into_iter()
            .map(Arc::new)
            .collect::<Vec<_>>();
        let store = ProbeStore::new(&probes);
        let executor = ProbeExecutor::new(&probes);
        let first_executor = executor.clone();
        let first_store = store.clone();
        let first = tokio::spawn(async move {
            first_executor
                .run_manual(&["slow".to_owned()], &first_store)
                .await
        });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first batch starts");
        assert!(matches!(
            executor.run_manual(&["fast".to_owned()], &store).await,
            Err(ManualProbeError::Busy)
        ));
        first
            .await
            .expect("first task")
            .expect("first batch completes");
    }
}
