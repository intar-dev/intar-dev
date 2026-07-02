use crate::probe::{ProbeDefinition, ProbeStatus};
use crate::state::{ProbeStore, ProbeUpdate, duration_millis_u64, unix_time_ms};
use std::sync::Arc;
use std::time::{Instant, SystemTime};
use tokio::task::JoinHandle;
use tokio::time::MissedTickBehavior;

pub(crate) fn spawn_probe_tasks(
    probes: Vec<Arc<ProbeDefinition>>,
    store: &ProbeStore,
) -> Vec<JoinHandle<()>> {
    probes
        .into_iter()
        .map(|probe| {
            let store_clone = (*store).clone();
            tokio::spawn(async move {
                run_probe_loop(probe, store_clone).await;
            })
        })
        .collect()
}

async fn run_probe_loop(probe: Arc<ProbeDefinition>, store: ProbeStore) {
    let mut ticker = tokio::time::interval(probe.every());
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;

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

        store.apply_update(probe.id(), update).await;
    }
}
