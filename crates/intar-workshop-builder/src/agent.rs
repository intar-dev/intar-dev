use std::time::Duration;

use anyhow::Result;
use tokio::time::sleep;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

use crate::backend::WorkshopExecutionBackend;
use crate::client::WorkshopRegistryClient;
use crate::config::WorkerConfig;
use crate::orchestrator::{ProcessOutcome, process_next_until_cancelled};

/// Run the workshop publication worker until the process is cancelled. A job
/// failure is terminal for that publication but not for the daemon; transport
/// failures back off and retry authentication.
pub async fn run_forever<B>(
    client: &WorkshopRegistryClient,
    backend: &mut B,
    worker: &WorkerConfig,
) -> Result<()>
where
    B: WorkshopExecutionBackend,
{
    run_forever_until_cancelled(client, backend, worker, CancellationToken::new()).await
}

/// Run the publication worker until the shared shutdown token is cancelled.
/// Cancellation aborts active local execution state but deliberately leaves
/// the claimed publication without a terminal failure report so it can be
/// reclaimed after its registry lease expires.
pub async fn run_forever_until_cancelled<B>(
    client: &WorkshopRegistryClient,
    backend: &mut B,
    worker: &WorkerConfig,
    cancellation: CancellationToken,
) -> Result<()>
where
    B: WorkshopExecutionBackend,
{
    loop {
        if cancellation.is_cancelled() {
            backend.abort();
            return Ok(());
        }
        let authentication = tokio::select! {
            biased;
            () = cancellation.cancelled() => {
                backend.abort();
                return Ok(());
            }
            result = client.authenticate() => result,
        };
        let session = match authentication {
            Ok(session) => session,
            Err(error) => {
                warn!(error = %error, "workshop builder authentication failed");
                if sleep_until_retry_or_cancelled(
                    Duration::from_secs(worker.error_retry_seconds),
                    &cancellation,
                )
                .await
                {
                    backend.abort();
                    return Ok(());
                }
                continue;
            }
        };
        match process_next_until_cancelled(&session, backend, worker, &cancellation).await {
            Ok(ProcessOutcome::Idle) => {
                if sleep_until_retry_or_cancelled(
                    Duration::from_secs(worker.poll_interval_seconds),
                    &cancellation,
                )
                .await
                {
                    backend.abort();
                    return Ok(());
                }
            }
            Ok(ProcessOutcome::Succeeded { publication_id }) => {
                info!(publication_id, "workshop builder completed publication");
            }
            Ok(ProcessOutcome::Failed {
                publication_id,
                error,
            }) => {
                warn!(
                    publication_id,
                    error, "workshop builder reported terminal failure"
                );
            }
            Err(error) => {
                backend.abort();
                if cancellation.is_cancelled() {
                    info!("workshop builder cancelled; active publication remains resumable");
                    return Ok(());
                }
                warn!(error = %error, "workshop builder worker iteration failed");
                if sleep_until_retry_or_cancelled(
                    Duration::from_secs(worker.error_retry_seconds),
                    &cancellation,
                )
                .await
                {
                    backend.abort();
                    return Ok(());
                }
            }
        }
    }
}

async fn sleep_until_retry_or_cancelled(
    duration: Duration,
    cancellation: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        () = cancellation.cancelled() => true,
        () = sleep(duration) => false,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use std::time::Duration;

    use tokio_util::sync::CancellationToken;

    use super::sleep_until_retry_or_cancelled;

    #[tokio::test]
    async fn cancellation_interrupts_retry_sleep() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();

        let cancelled = tokio::time::timeout(
            Duration::from_millis(100),
            sleep_until_retry_or_cancelled(Duration::from_secs(60), &cancellation),
        )
        .await
        .unwrap();

        assert!(cancelled);
    }
}
