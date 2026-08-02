SELECT
  (SELECT count(*) FROM active_runtime_slots) AS active_runtime_slots,
  (SELECT count(*) FROM runtime_executions WHERE ended_at IS NULL) AS unended_runtime_executions,
  (SELECT count(*) FROM hetzner_allocations WHERE deletion_confirmed_at IS NULL) AS unconfirmed_hetzner_allocations,
  (SELECT count(*) FROM workshop_publication_provider_attempts WHERE deletion_confirmed_at IS NULL) AS unconfirmed_publication_provider_attempts,
  (SELECT count(*) FROM runtime_provider_cost_ledger WHERE deletion_confirmed_at IS NULL) AS open_runtime_provider_cost_entries,
  (SELECT count(*) FROM workshop_publication_provider_cost_ledger WHERE deletion_confirmed_at IS NULL) AS open_publication_provider_cost_entries,
  (SELECT count(*) FROM organization_provider_connections WHERE state != 'disconnected') AS connected_provider_connections,
  (SELECT count(*) FROM organization_provider_connections WHERE active_credential_version_id IS NOT NULL) AS active_provider_credentials,
  (SELECT count(*) FROM runtime_terminal_sessions WHERE ended_at IS NULL) AS open_runtime_terminal_sessions,
  (SELECT count(*) FROM runtime_artifacts WHERE upload_status = 'pending') AS pending_runtime_artifacts,
  (SELECT count(*) FROM runtime_provider_artifact_upload_grants WHERE used_at IS NULL AND expires_at > cast(unixepoch('subsecond') * 1000 as integer)) AS active_provider_artifact_grants,
  (SELECT count(*) FROM workshop_assist_grants WHERE revoked_at IS NULL AND expires_at > cast(unixepoch('subsecond') * 1000 as integer)) AS active_workshop_assist_grants,
  (SELECT count(*) FROM workshop_help_requests WHERE status IN ('open', 'claimed')) AS active_workshop_help_requests,
  (SELECT count(*) FROM workshop_route_issuance_intents WHERE state IN ('pending', 'issued')) AS live_workshop_route_issuance_intents,
  (SELECT count(*) FROM runtime_allocation_locks) AS runtime_allocation_locks,
  (SELECT count(*) FROM host_resource_reservations WHERE released_at IS NULL) AS active_host_resource_reservations,
  (SELECT count(*) FROM host_cpu_reservations) AS active_host_cpu_reservations,
  (SELECT count(*) FROM image_builds WHERE status IN ('queued', 'assigned', 'building')) AS active_image_builds,
  (SELECT count(*) FROM image_build_coordination_locks) AS image_build_coordination_locks,
  (SELECT count(*)
   FROM host_desired_state desired,
        json_each(desired.doc_json, '$.vms') vm
   WHERE json_extract(vm.value, '$.desired_phase') IS NOT 'absent') AS host_desired_vm_entries,
  (SELECT coalesce(sum(json_array_length(doc_json, '$.builds')), 0) FROM host_desired_state) AS host_desired_build_entries,
  (SELECT coalesce(sum(json_array_length(report_json, '$.vms')), 0) FROM host_actual_state) AS host_actual_vm_entries,
  (SELECT coalesce(sum(json_array_length(report_json, '$.builds')), 0) FROM host_actual_state) AS host_actual_build_entries,
  (SELECT count(*)
   FROM runtime_vm_actual_state actual
   JOIN runtime_executions execution ON execution.id = actual.execution_id
   WHERE actual.phase <> 'absent'
     AND execution.ended_at IS NULL) AS nonabsent_runtime_vm_actual_states,
  (SELECT count(*)
   FROM agent_hosts host
   LEFT JOIN host_actual_state actual ON actual.host_id = host.id
   LEFT JOIN host_desired_state desired ON desired.host_id = host.id
   WHERE host.disabled = 0
     AND ((host.role = 'agent' AND host.scenario_enabled = 1) OR host.role = 'builder')
     AND (
       host.connected = 0
       OR host.last_heartbeat_at IS NULL
       OR host.last_heartbeat_at < cast(unixepoch('subsecond') * 1000 as integer) - 90000
       OR actual.host_id IS NULL
       OR actual.updated_at < cast(unixepoch('subsecond') * 1000 as integer) - 90000
       OR (desired.host_id IS NOT NULL AND actual.applied_desired_version < desired.version)
     )) AS untrustworthy_enabled_host_reports,
  (SELECT count(*) FROM workshop_publications WHERE status IN ('queued', 'building')) AS active_workshop_publications,
  (SELECT count(*)
   FROM workshop_publication_checkpoints checkpoint
   JOIN workshop_publications publication ON publication.id = checkpoint.publication_id
   WHERE publication.status IN ('queued', 'building')
     AND checkpoint.status IN ('pending', 'building')) AS active_workshop_publication_checkpoints,
  (SELECT count(*)
   FROM workshop_publication_provider_checkpoints checkpoint
   JOIN workshop_publications publication ON publication.id = checkpoint.publication_id
   WHERE publication.status = 'building'
     AND publication.provider_verification_state IN ('verifying', 'cleanup_pending')
     AND checkpoint.verification_status IN ('pending', 'allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'cleanup_pending')) AS active_publication_provider_checkpoints,
  (SELECT count(*) FROM workshop_sessions WHERE state NOT IN ('ended', 'cancelled')) AS nonterminal_workshop_sessions,
  (SELECT count(*) FROM workshop_workspaces WHERE state NOT IN ('ended', 'failed')) AS nonterminal_workshop_workspaces,
  (SELECT count(*) FROM workshop_workspace_generations WHERE state NOT IN ('archived', 'failed')) AS nonterminal_workshop_generations,
  (SELECT count(*) FROM scenario_runs WHERE active_key IS NOT NULL) AS active_scenario_runs,
  (SELECT coalesce(sum(json_array_length(doc_json, '$.vms')), 0) FROM host_desired_state) AS residual_host_desired_vm_entries,
  (SELECT count(*) FROM runtime_vm_actual_state WHERE phase <> 'absent') AS residual_nonabsent_runtime_vm_actual_states,
  (SELECT count(*) FROM workshop_publication_checkpoints WHERE status IN ('pending', 'building')) AS residual_workshop_publication_checkpoints,
  (SELECT count(*) FROM workshop_publication_provider_checkpoints WHERE verification_status IN ('pending', 'allocating', 'bootstrapping', 'applying', 'proof_succeeded', 'deleting', 'cleanup_pending')) AS residual_publication_provider_checkpoints,
  cast(unixepoch('subsecond') * 1000 as integer) AS observed_at;
