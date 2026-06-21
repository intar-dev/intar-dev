#![forbid(unsafe_code)]

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DuplicateRequestDecision {
    ReplayExisting,
    PayloadMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InboundBatchPlan {
    AckOnly,
    Gap,
    Process { start_index: usize },
}

#[cfg(test)]
pub(crate) fn decide_duplicate_request(
    existing_method: &str,
    existing_payload_sha: &str,
    incoming_method: &str,
    incoming_payload_sha: &str,
) -> DuplicateRequestDecision {
    if existing_method == incoming_method && existing_payload_sha == incoming_payload_sha {
        DuplicateRequestDecision::ReplayExisting
    } else {
        DuplicateRequestDecision::PayloadMismatch
    }
}

#[cfg(test)]
pub(crate) fn clamp_outbound_ack_upto(ack_upto: i64, next_seq: i64) -> i64 {
    let max_sent_seq = next_seq.saturating_sub(1).max(0);
    ack_upto.clamp(0, max_sent_seq)
}

pub(crate) fn plan_inbound_batch(
    current_acked_seq: i64,
    first_seq: i64,
    last_seq: i64,
    envelope_count: usize,
) -> Result<InboundBatchPlan, &'static str> {
    if envelope_count == 0 {
        return Err("invalid inbound batch size");
    }
    if first_seq <= 0 || last_seq < first_seq {
        return Err("invalid inbound sequence range");
    }
    let expected_len = usize::try_from(last_seq.saturating_sub(first_seq).saturating_add(1))
        .map_err(|_| "inbound sequence range overflow")?;
    if expected_len != envelope_count {
        return Err("inbound batch length does not match sequence range");
    }
    if last_seq <= current_acked_seq {
        return Ok(InboundBatchPlan::AckOnly);
    }
    if first_seq > current_acked_seq + 1 {
        return Ok(InboundBatchPlan::Gap);
    }
    let next_seq = current_acked_seq + 1;
    let start_index =
        usize::try_from(next_seq.saturating_sub(first_seq)).map_err(|_| "invalid overlap index")?;
    Ok(InboundBatchPlan::Process { start_index })
}

#[cfg(test)]
pub(crate) type DuplicateCommandDecision = DuplicateRequestDecision;
#[cfg(test)]
pub(crate) type CpToAgentBatchPlan = InboundBatchPlan;

#[cfg(test)]
pub(crate) fn decide_duplicate_command(
    existing_op: &str,
    existing_payload_sha: &str,
    incoming_op: &str,
    incoming_payload_sha: &str,
) -> DuplicateCommandDecision {
    decide_duplicate_request(
        existing_op,
        existing_payload_sha,
        incoming_op,
        incoming_payload_sha,
    )
}

#[cfg(test)]
pub(crate) fn clamp_agent_ack_upto(ack_upto: i64, agent_next_seq: i64) -> i64 {
    clamp_outbound_ack_upto(ack_upto, agent_next_seq)
}

#[cfg(test)]
pub(crate) fn plan_cp_to_agent_batch(
    current_ack_upto: i64,
    first_seq: i64,
    last_seq: i64,
    event_count: usize,
) -> Result<CpToAgentBatchPlan, &'static str> {
    plan_inbound_batch(current_ack_upto, first_seq, last_seq, event_count)
}

#[cfg(test)]
pub(crate) fn command_receipt_event_id(command_id: &str) -> String {
    format!("cmd:{command_id}:receipt")
}

#[cfg(test)]
pub(crate) fn command_started_event_id(command_id: &str) -> String {
    format!("cmd:{command_id}:started")
}

#[cfg(test)]
pub(crate) fn command_finished_event_id(command_id: &str, status: &str) -> String {
    format!("cmd:{command_id}:finished:{status}")
}

#[cfg(test)]
pub(crate) fn command_payload_mismatch_event_id(command_id: &str) -> String {
    format!("cmd:{command_id}:finished:payload-mismatch")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Lcg(u64);

    impl Lcg {
        fn new(seed: u64) -> Self {
            Self(seed)
        }

        fn next_u32(&mut self) -> u32 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (self.0 >> 32) as u32
        }

        fn next_range(&mut self, max_inclusive: u32) -> u32 {
            if max_inclusive == 0 {
                return 0;
            }
            self.next_u32() % (max_inclusive + 1)
        }
    }

    #[test]
    fn duplicate_request_decision_distinguishes_replay_and_mismatch() {
        assert_eq!(
            decide_duplicate_request("vm.launch", "sha-a", "vm.launch", "sha-a"),
            DuplicateRequestDecision::ReplayExisting
        );
        assert_eq!(
            decide_duplicate_request("vm.launch", "sha-a", "vm.launch", "sha-b"),
            DuplicateRequestDecision::PayloadMismatch
        );
        assert_eq!(
            decide_duplicate_request("vm.launch", "sha-a", "host.ping", "sha-a"),
            DuplicateRequestDecision::PayloadMismatch
        );
    }

    #[test]
    fn clamp_outbound_ack_upto_never_exceeds_sent_seq() {
        assert_eq!(clamp_outbound_ack_upto(-10, 5), 0);
        assert_eq!(clamp_outbound_ack_upto(0, 5), 0);
        assert_eq!(clamp_outbound_ack_upto(2, 5), 2);
        assert_eq!(clamp_outbound_ack_upto(99, 5), 4);
        assert_eq!(clamp_outbound_ack_upto(99, 0), 0);
    }

    #[test]
    fn plan_inbound_batch_handles_overlap_gap_and_ack_only() {
        assert_eq!(
            plan_inbound_batch(3, 1, 3, 3).expect("ack-only"),
            InboundBatchPlan::AckOnly
        );
        assert_eq!(
            plan_inbound_batch(3, 5, 6, 2).expect("gap"),
            InboundBatchPlan::Gap
        );
        assert_eq!(
            plan_inbound_batch(3, 2, 5, 4).expect("overlap"),
            InboundBatchPlan::Process { start_index: 2 }
        );
        assert_eq!(
            plan_inbound_batch(3, 4, 5, 2).expect("tail only"),
            InboundBatchPlan::Process { start_index: 0 }
        );
    }

    #[test]
    fn inbound_batch_fuzz_keeps_overlap_index_and_gap_behavior_consistent() {
        let mut rng = Lcg::new(0x5eed_cafe_u64);
        for _ in 0..1_000 {
            let current_ack = i64::from(rng.next_range(20));
            let first_seq = i64::from(rng.next_range(20)) + 1;
            let envelope_count = usize::try_from(rng.next_range(6) + 1).unwrap_or(1);
            let last_seq = first_seq + i64::try_from(envelope_count).unwrap_or(1) - 1;

            let plan =
                plan_inbound_batch(current_ack, first_seq, last_seq, envelope_count).expect("plan");

            match plan {
                InboundBatchPlan::AckOnly => {
                    assert!(last_seq <= current_ack);
                }
                InboundBatchPlan::Gap => {
                    assert!(first_seq > current_ack + 1);
                }
                InboundBatchPlan::Process { start_index } => {
                    assert!(first_seq <= current_ack + 1);
                    assert!(last_seq > current_ack);
                    let expected = usize::try_from((current_ack + 1) - first_seq).unwrap_or(0);
                    assert_eq!(start_index, expected);
                    assert!(start_index < envelope_count);
                }
            }
        }
    }
}
