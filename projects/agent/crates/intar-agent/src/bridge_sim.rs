#![forbid(unsafe_code)]

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, HashMap};

    use serde_json::{Value, json};

    use crate::bridge_core::{
        CpToAgentBatchPlan, DuplicateCommandDecision, clamp_agent_ack_upto,
        command_finished_event_id, command_payload_mismatch_event_id, command_receipt_event_id,
        command_started_event_id, decide_duplicate_command, plan_cp_to_agent_batch,
    };

    #[derive(Clone, Debug)]
    struct SimCommand {
        command_id: String,
        op: String,
        payload_sha: String,
        acknowledged_at_ms: i64,
        started_at_ms: Option<i64>,
        finished_at_ms: Option<i64>,
        state: String,
        result: Option<Value>,
        error: Option<Value>,
    }

    #[derive(Clone, Debug)]
    struct OutboundEvent {
        event_id: String,
    }

    #[derive(Default)]
    struct AgentBridgeSim {
        cp_ack_upto: i64,
        agent_next_seq: i64,
        outbound: BTreeMap<i64, OutboundEvent>,
        by_event_id: HashMap<String, (String, String)>,
        commands: HashMap<String, SimCommand>,
    }

    impl AgentBridgeSim {
        fn new() -> Self {
            Self {
                cp_ack_upto: 0,
                agent_next_seq: 1,
                outbound: BTreeMap::new(),
                by_event_id: HashMap::new(),
                commands: HashMap::new(),
            }
        }

        fn queue_outbound(&mut self, event_id: String, kind: &str, payload: Value) {
            let payload_json = payload.to_string();
            if let Some((existing_kind, existing_payload_json)) = self.by_event_id.get(&event_id) {
                assert_eq!(existing_kind, kind, "event kind mismatch for {event_id}");
                assert_eq!(
                    existing_payload_json, &payload_json,
                    "payload mismatch for existing event_id {event_id}"
                );
                return;
            }

            self.by_event_id
                .insert(event_id.clone(), (kind.to_string(), payload_json));
            self.outbound
                .insert(self.agent_next_seq, OutboundEvent { event_id });
            self.agent_next_seq += 1;
        }

        fn mark_running(&mut self, command_id: &str, started_at_ms: i64) {
            let command = self.commands.get_mut(command_id).expect("command exists");
            command.state = "running".to_string();
            command.started_at_ms = Some(started_at_ms);
            self.queue_outbound(
                command_started_event_id(command_id),
                "agent.command.started",
                json!({
                    "commandId": command_id,
                    "startedAt": started_at_ms,
                }),
            );
        }

        fn mark_finished(
            &mut self,
            command_id: &str,
            status: &str,
            finished_at_ms: i64,
            result: Option<Value>,
            error: Option<Value>,
        ) {
            let command = self.commands.get_mut(command_id).expect("command exists");
            command.state = status.to_string();
            command.finished_at_ms = Some(finished_at_ms);
            command.result = result.clone();
            command.error = error.clone();

            let mut payload = json!({
                "commandId": command_id,
                "status": status,
                "finishedAt": finished_at_ms,
            });
            if let Some(started_at_ms) = command.started_at_ms {
                payload["startedAt"] = json!(started_at_ms);
            }
            if let Some(result) = result {
                payload["result"] = result;
            }
            if let Some(error) = error {
                payload["error"] = error;
            }

            self.queue_outbound(
                command_finished_event_id(command_id, status),
                "agent.command.finished",
                payload,
            );
        }

        fn replay_command_state(&mut self, command_id: &str, fallback_finished_at_ms: i64) {
            let command = self
                .commands
                .get(command_id)
                .expect("command exists")
                .clone();
            self.queue_outbound(
                command_receipt_event_id(&command.command_id),
                "agent.command.receipt",
                json!({
                    "commandId": command.command_id,
                    "acknowledgedAt": command.acknowledged_at_ms,
                }),
            );
            if let Some(started_at_ms) = command.started_at_ms {
                self.queue_outbound(
                    command_started_event_id(&command.command_id),
                    "agent.command.started",
                    json!({
                        "commandId": command.command_id,
                        "startedAt": started_at_ms,
                    }),
                );
            }
            if matches!(command.state.as_str(), "succeeded" | "failed" | "timed_out") {
                let mut payload = json!({
                    "commandId": command.command_id,
                    "status": command.state,
                    "finishedAt": command.finished_at_ms.unwrap_or(fallback_finished_at_ms),
                });
                if let Some(started_at_ms) = command.started_at_ms {
                    payload["startedAt"] = json!(started_at_ms);
                }
                if let Some(result) = command.result {
                    payload["result"] = result;
                }
                if let Some(error) = command.error {
                    payload["error"] = error;
                }
                self.queue_outbound(
                    command_finished_event_id(&command.command_id, &command.state),
                    "agent.command.finished",
                    payload,
                );
            }
        }

        fn handle_command(
            &mut self,
            seq: i64,
            command_id: &str,
            op: &str,
            payload_sha: &str,
            _payload: Value,
            acknowledged_at_ms: i64,
        ) {
            if let Some(existing) = self.commands.get(command_id).cloned() {
                match decide_duplicate_command(&existing.op, &existing.payload_sha, op, payload_sha)
                {
                    DuplicateCommandDecision::ReplayExisting => {
                        self.replay_command_state(command_id, acknowledged_at_ms);
                    }
                    DuplicateCommandDecision::PayloadMismatch => {
                        self.queue_outbound(
                            command_receipt_event_id(command_id),
                            "agent.command.receipt",
                            json!({
                                "commandId": command_id,
                                "acknowledgedAt": existing.acknowledged_at_ms,
                            }),
                        );
                        self.queue_outbound(
                            command_payload_mismatch_event_id(command_id),
                            "agent.command.finished",
                            json!({
                                "commandId": command_id,
                                "status": "failed",
                                "finishedAt": existing.acknowledged_at_ms,
                                "error": {
                                    "code": "command_payload_mismatch",
                                    "message": "command_id was reused with a different op or payload",
                                },
                            }),
                        );
                    }
                }
                self.cp_ack_upto = self.cp_ack_upto.max(seq);
                return;
            }

            self.commands.insert(
                command_id.to_string(),
                SimCommand {
                    command_id: command_id.to_string(),
                    op: op.to_string(),
                    payload_sha: payload_sha.to_string(),
                    acknowledged_at_ms,
                    started_at_ms: None,
                    finished_at_ms: None,
                    state: "acknowledged".to_string(),
                    result: None,
                    error: None,
                },
            );
            self.queue_outbound(
                command_receipt_event_id(command_id),
                "agent.command.receipt",
                json!({
                    "commandId": command_id,
                    "acknowledgedAt": acknowledged_at_ms,
                }),
            );
            self.cp_ack_upto = self.cp_ack_upto.max(seq);
        }

        fn receive_batch(&mut self, first_seq: i64, ids: &[&str]) -> CpToAgentBatchPlan {
            let plan = plan_cp_to_agent_batch(
                self.cp_ack_upto,
                first_seq,
                first_seq + ids.len() as i64 - 1,
                ids.len(),
            )
            .expect("plan");
            if let CpToAgentBatchPlan::Process { start_index } = plan {
                for (index, command_id) in ids.iter().enumerate().skip(start_index) {
                    let seq = first_seq + i64::try_from(index).unwrap_or(i64::MAX);
                    self.handle_command(
                        seq,
                        command_id,
                        "agent.ping",
                        &format!("sha-{command_id}"),
                        json!({}),
                        100 + seq,
                    );
                }
            }
            plan
        }

        fn outbound_event_ids(&self) -> Vec<String> {
            self.outbound
                .values()
                .map(|event| event.event_id.clone())
                .collect()
        }
    }

    #[test]
    fn overlapping_batch_processes_only_unseen_tail() {
        let mut sim = AgentBridgeSim::new();
        assert_eq!(
            sim.receive_batch(1, &["cmd-1", "cmd-2"]),
            CpToAgentBatchPlan::Process { start_index: 0 }
        );
        assert_eq!(sim.cp_ack_upto, 2);

        let before = sim.outbound_event_ids();
        assert_eq!(
            sim.receive_batch(2, &["cmd-2", "cmd-3"]),
            CpToAgentBatchPlan::Process { start_index: 1 }
        );
        assert_eq!(sim.cp_ack_upto, 3);
        assert_eq!(
            sim.outbound_event_ids(),
            before
                .into_iter()
                .chain([command_receipt_event_id("cmd-3")])
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn duplicate_command_replays_stable_lifecycle_event_ids() {
        let mut sim = AgentBridgeSim::new();
        sim.handle_command(1, "cmd-1", "agent.ping", "sha-1", json!({}), 101);
        sim.mark_running("cmd-1", 110);
        sim.mark_finished("cmd-1", "succeeded", 120, Some(json!({ "ok": true })), None);
        let original_ids = sim.outbound_event_ids();

        sim.handle_command(2, "cmd-1", "agent.ping", "sha-1", json!({}), 130);

        assert_eq!(sim.outbound_event_ids(), original_ids);
    }

    #[test]
    fn duplicate_command_payload_mismatch_uses_distinct_terminal_event_id() {
        let mut sim = AgentBridgeSim::new();
        sim.handle_command(1, "cmd-1", "agent.ping", "sha-1", json!({}), 101);

        sim.handle_command(
            2,
            "cmd-1",
            "agent.ping",
            "sha-2",
            json!({ "changed": true }),
            102,
        );

        let ids = sim.outbound_event_ids();
        assert!(ids.contains(&command_receipt_event_id("cmd-1")));
        assert!(ids.contains(&command_payload_mismatch_event_id("cmd-1")));
        assert!(!ids.contains(&command_finished_event_id("cmd-1", "failed")));
    }

    #[test]
    fn ack_clamp_never_advances_beyond_sent_outbound_seq() {
        let mut sim = AgentBridgeSim::new();
        sim.queue_outbound("event-1".to_string(), "agent.host.heartbeat", json!({}));
        sim.queue_outbound("event-2".to_string(), "agent.host.heartbeat", json!({}));
        assert_eq!(clamp_agent_ack_upto(99, sim.agent_next_seq), 2);
    }
}
