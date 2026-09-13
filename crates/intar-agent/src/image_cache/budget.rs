use super::*;

/// One image prepare job in the whole agent process.
///
/// The scrub pass can want hundreds of images at the same time. Preparing one
/// image at a time keeps the CPU, the disk read path, and the jailerd template
/// store predictable while a learner boot needs them.
const PREPARE_JOB_LIMIT: usize = 1;

/// Five chunk network transfers at the same time, in the whole process: one
/// background entry's fanout plus the transfer slot that a learner-visible
/// launch must always be able to take. A transfer slot is held for the full
/// request, so a stalled registry stream cannot open a sixth connection.
pub(super) const TRANSFER_LIMIT: usize = 5;

/// Chunk transfers in flight for one cache image entry.
///
/// The waiter holds the exclusive prepare job, so only one background entry
/// opens chunk transfers at a time. The last transfer slot always stays free
/// for a learner-visible transfer: the launch path downloads a missing pinned
/// guest tools disk through the same budget, and a boot must not queue behind
/// a background image warm. Nothing holds a transfer slot while it waits for a
/// boot window or for the prepare job, so the reservation cannot deadlock.
pub(super) const BACKGROUND_CHUNK_FANOUT: usize = 4;

const _: () = assert!(
    BACKGROUND_CHUNK_FANOUT < TRANSFER_LIMIT,
    "a background entry must leave one transfer slot free for the launch path"
);

static PREPARE_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
static TRANSFER_PERMITS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn prepare_slots() -> Arc<Semaphore> {
    Arc::clone(PREPARE_SLOTS.get_or_init(|| Arc::new(Semaphore::new(PREPARE_JOB_LIMIT))))
}

fn transfer_slots() -> Arc<Semaphore> {
    Arc::clone(TRANSFER_PERMITS.get_or_init(|| Arc::new(Semaphore::new(TRANSFER_LIMIT))))
}

/// Hold while one image is downloaded, decoded, and prepared.
pub(super) async fn acquire_prepare_job() -> Result<tokio::sync::OwnedSemaphorePermit> {
    prepare_slots()
        .acquire_owned()
        .await
        .context("image prepare budget is closed")
}

/// Hold while one registry HTTP transfer is in flight.
pub(super) async fn acquire_transfer_slot() -> Result<tokio::sync::OwnedSemaphorePermit> {
    transfer_slots()
        .acquire_owned()
        .await
        .context("image transfer budget is closed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_prepare_job_is_available_and_global() -> Result<()> {
        let first = acquire_prepare_job().await?;
        assert!(prepare_slots().try_acquire().is_err());
        drop(first);
        assert!(prepare_slots().try_acquire().is_ok());
        // The global semaphore kept its permit count after the cycle.
        assert_eq!(prepare_slots().available_permits(), PREPARE_JOB_LIMIT);
        Ok(())
    }
}
