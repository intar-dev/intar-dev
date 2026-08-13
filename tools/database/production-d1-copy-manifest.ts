import { createHash } from "node:crypto";

export const APPLICATION_TABLES = [
  "access_allowlist",
  "access_events",
  "access_invite_codes",
  "access_invite_removals",
  "account",
  "active_runtime_slots",
  "agent_bootstrap_tokens",
  "agent_hosts",
  "gcp_connection_details",
  "hetzner_connection_details",
  "host_actual_state",
  "host_cpu_reservations",
  "host_desired_state",
  "host_resource_reservations",
  "image_build_bundles",
  "image_build_coordination_locks",
  "image_builds",
  "invitation",
  "jwks",
  "member",
  "oauth_access_token",
  "oauth_client",
  "oauth_client_assertion",
  "oauth_client_resource",
  "oauth_consent",
  "oauth_refresh_token",
  "oauth_resource",
  "organization",
  "provider_audit_events",
  "provider_connections",
  "provider_credential_versions",
  "provider_price_line_items",
  "provider_price_observations",
  "runtime_actual_state",
  "runtime_allocation_locks",
  "runtime_artifact_upload_grants",
  "runtime_artifact_uploads",
  "runtime_artifacts",
  "runtime_checkpoint_bundles",
  "runtime_executions",
  "runtime_guest_credentials",
  "runtime_guest_reports",
  "runtime_provider_allocations",
  "runtime_provider_cost_ledger",
  "runtime_provider_operations",
  "runtime_provider_reconciliation",
  "runtime_provider_resources",
  "runtime_terminal_sessions",
  "runtime_vm_access_keys",
  "runtime_vm_actual_state",
  "runtime_vms",
  "scenario_assignments",
  "scenario_course_catalogs",
  "scenario_run_artifact_uploads",
  "scenario_run_artifacts",
  "scenario_run_probe_snapshots",
  "scenario_run_session_transcripts",
  "scenario_run_ssh_keys",
  "scenario_runs",
  "scenario_sources",
  "session",
  "sso_provider",
  "user",
  "user_ssh_keys",
  "verification",
  "vm_scenario_probes",
  "vm_scenario_vms",
  "vm_scenarios",
  "workshop_assist_grants",
  "workshop_events",
  "workshop_help_requests",
  "workshop_module_progress",
  "workshop_publication_checkpoints",
  "workshop_publications",
  "workshop_registry_tokens",
  "workshop_route_issuance_intents",
  "workshop_runtime_profile_certifications",
  "workshop_runtime_profiles",
  "workshop_session_cost_forecast_line_items",
  "workshop_session_cost_forecasts",
  "workshop_session_cost_summaries",
  "workshop_session_members",
  "workshop_session_runtime_selections",
  "workshop_sessions",
  "workshop_template_revisions",
  "workshop_templates",
  "workshop_workspace_generations",
  "workshop_workspaces",
] as const;

export type ApplicationTable = (typeof APPLICATION_TABLES)[number];
export type CopyRow = Record<string, string | number | boolean | null>;

export interface CopyTablePolicy {
  readonly action: "copy";
  readonly table: ApplicationTable;
  readonly reason: string;
  readonly optionalOnSource?: boolean;
  readonly selfParentColumn?: string;
  readonly transform?: string;
}

export interface ExcludeTablePolicy {
  readonly action: "exclude";
  readonly table: ApplicationTable;
  readonly reason: string;
}

export type TablePolicy = CopyTablePolicy | ExcludeTablePolicy;

/**
 * This order is deliberately explicit. Parents precede children; the one
 * self-referencing table is additionally sorted by source_execution_id.
 */
export const COPY_TABLES = [
  copy("user", "durable identity"),
  copy("organization", "durable tenancy"),
  copy("member", "durable tenant membership"),
  copy("account", "stable provider identity with credentials stripped", {
    transform: "strip_auth_credentials",
  }),
  copy("sso_provider", "durable tenant identity-provider configuration"),
  copy("access_invite_codes", "platform admission and invite audit", {
    transform: "release_invite_leases",
  }),
  copy("access_invite_removals", "invite archive audit", {
    optionalOnSource: true,
  }),
  copy("access_allowlist", "platform beta entitlement"),
  copy("access_events", "platform admission audit"),
  copy("scenario_course_catalogs", "durable scenario catalog"),
  copy("scenario_sources", "durable scenario authoring source"),
  copy("scenario_assignments", "durable tenant scenario assignment"),
  copy("vm_scenarios", "durable scenario catalog"),
  copy("vm_scenario_vms", "durable scenario catalog"),
  copy("vm_scenario_probes", "durable scenario catalog"),
  copy("agent_hosts", "durable host registration, normalized offline", {
    transform: "disconnect_hosts",
  }),
  copy("image_build_bundles", "durable image catalog"),
  copy("image_builds", "terminal image-build history"),
  copy("provider_connections", "durable provider configuration"),
  copy(
    "provider_credential_versions",
    "encrypted durable provider configuration; replacement Worker retains the KEK",
  ),
  copy("hetzner_connection_details", "durable provider configuration"),
  copy("gcp_connection_details", "durable provider configuration"),
  copy("provider_audit_events", "provider audit history"),
  copy("workshop_templates", "durable workshop catalog"),
  copy("workshop_template_revisions", "durable workshop catalog"),
  copy(
    "workshop_registry_tokens",
    "registry-token audit with token invalidated",
    {
      transform: "retire_registry_tokens",
    },
  ),
  copy("workshop_runtime_profiles", "durable runtime catalog"),
  copy(
    "workshop_runtime_profile_certifications",
    "terminal certification history",
  ),
  copy("workshop_sessions", "terminal workshop history"),
  copy("workshop_session_members", "terminal workshop roster history"),
  copy("workshop_workspaces", "terminal workshop workspace history"),
  copy("workshop_module_progress", "workshop learning history"),
  copy("workshop_help_requests", "terminal workshop help history"),
  copy("workshop_assist_grants", "revoked workshop assistance history"),
  copy("workshop_events", "workshop audit history"),
  copy(
    "workshop_session_runtime_selections",
    "durable workshop runtime configuration",
  ),
  copy("runtime_checkpoint_bundles", "durable runtime catalog"),
  copy("provider_price_observations", "durable pricing attribution"),
  copy("provider_price_line_items", "durable pricing attribution"),
  copy("workshop_session_cost_forecasts", "durable cost history"),
  copy("workshop_session_cost_forecast_line_items", "durable cost history"),
  copy("workshop_session_cost_summaries", "durable cost history"),
  copy("runtime_executions", "terminal runtime history", {
    selfParentColumn: "source_execution_id",
  }),
  copy(
    "runtime_vms",
    "terminal runtime history with connection secrets stripped",
    {
      transform: "strip_terminal_credentials",
    },
  ),
  copy("runtime_artifacts", "uploaded terminal/runtime artifacts"),
  copy("runtime_terminal_sessions", "ended terminal session history"),
  copy("runtime_guest_reports", "terminal runtime report history"),
  copy("scenario_runs", "terminal scenario history"),
  copy("scenario_run_probe_snapshots", "terminal scenario history"),
  copy("scenario_run_artifacts", "uploaded scenario artifacts"),
  copy("scenario_run_session_transcripts", "terminal transcript history"),
  copy("runtime_provider_allocations", "terminal provider allocation history"),
  copy("runtime_provider_resources", "deleted provider resource history"),
  copy("runtime_provider_operations", "terminal provider operation history"),
  copy("runtime_provider_cost_ledger", "immutable provider cost history"),
  copy(
    "workshop_workspace_generations",
    "terminal workspace generation history",
  ),
  copy("workshop_publications", "terminal publication history", {
    transform: "clear_publication_claims",
  }),
  copy(
    "workshop_publication_checkpoints",
    "terminal publication checkpoint history",
  ),
] as const satisfies readonly CopyTablePolicy[];

export const EXCLUDED_TABLES = [
  exclude("active_runtime_slots", "live allocation state"),
  exclude("agent_bootstrap_tokens", "bootstrap capability"),
  exclude("host_actual_state", "ephemeral observed state"),
  exclude("host_cpu_reservations", "live capacity reservation"),
  exclude("host_desired_state", "live orchestration intent"),
  exclude("host_resource_reservations", "live capacity reservation"),
  exclude("image_build_coordination_locks", "coordination lease"),
  exclude("invitation", "organization invitation capability"),
  exclude(
    "jwks",
    "private signing keys; sessions and OAuth capabilities are discarded and keys rotate after cutover",
  ),
  exclude("oauth_access_token", "OAuth capability"),
  exclude("oauth_client", "OAuth client secret material"),
  exclude("oauth_client_assertion", "OAuth assertion replay state"),
  exclude("oauth_client_resource", "OAuth runtime configuration"),
  exclude("oauth_consent", "OAuth runtime grant"),
  exclude("oauth_refresh_token", "OAuth capability"),
  exclude("oauth_resource", "OAuth runtime configuration"),
  exclude("runtime_actual_state", "ephemeral observed state"),
  exclude("runtime_allocation_locks", "coordination lease"),
  exclude("runtime_artifact_upload_grants", "upload capability"),
  exclude("runtime_artifact_uploads", "in-flight multipart upload state"),
  exclude("runtime_guest_credentials", "guest/bootstrap capability"),
  exclude("runtime_provider_reconciliation", "live reconciliation lease"),
  exclude("runtime_vm_access_keys", "runtime access capability"),
  exclude("runtime_vm_actual_state", "ephemeral observed state"),
  exclude("scenario_run_artifact_uploads", "in-flight multipart upload state"),
  exclude("scenario_run_ssh_keys", "runtime private key material"),
  exclude("session", "application session capability"),
  exclude("user_ssh_keys", "user access capability; re-enroll after cutover"),
  exclude("verification", "one-time verification capability"),
  exclude("workshop_route_issuance_intents", "route capability issuance state"),
] as const satisfies readonly ExcludeTablePolicy[];

export const TABLE_POLICIES = [
  ...COPY_TABLES,
  ...EXCLUDED_TABLES,
] as const satisfies readonly TablePolicy[];

export interface SourceGate {
  readonly id: string;
  readonly description: string;
  readonly sql: string;
  readonly usesCutoverTime?: boolean;
}

/** Every query returns one `count` and must be zero before any target write. */
export const SOURCE_GATES = [
  gate(
    "connected_hosts",
    "agent or builder socket may still write",
    `
    SELECT count(*) AS count FROM agent_hosts
    WHERE connected = 1 OR active_session_id IS NOT NULL`,
  ),
  gate(
    "host_actual_state",
    "host actual state indicates a live agent",
    `
    SELECT count(*) AS count FROM host_actual_state`,
  ),
  timedGate(
    "agent_bootstrap",
    "agent bootstrap capability remains",
    `
    SELECT count(*) AS count FROM agent_bootstrap_tokens
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
  ),
  timedGate(
    "registry_tokens",
    "workshop registry capability remains",
    `
    SELECT count(*) AS count FROM workshop_registry_tokens
    WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
  ),
  gate(
    "access_cleanup",
    "beta revocation cleanup is still running",
    `
    SELECT count(*) AS count FROM access_allowlist
    WHERE state = 'blocked'
      AND revocation_cleanup_started_at IS NOT NULL
      AND revocation_cleanup_completed_at IS NULL`,
  ),
  gate(
    "scenario_runs",
    "scenario run is nonterminal",
    `
    SELECT count(*) AS count FROM scenario_runs
    WHERE state NOT IN ('completed', 'failed') OR active_key IS NOT NULL`,
  ),
  gate(
    "runtime_executions",
    "runtime execution is nonterminal",
    `
    SELECT count(*) AS count FROM runtime_executions
    WHERE state NOT IN ('archived', 'failed')`,
  ),
  gate(
    "runtime_terminals",
    "terminal session is open",
    `
    SELECT count(*) AS count FROM runtime_terminal_sessions WHERE ended_at IS NULL`,
  ),
  gate(
    "runtime_artifacts",
    "runtime artifact upload is incomplete",
    `
    SELECT count(*) AS count FROM runtime_artifacts WHERE upload_status <> 'uploaded'`,
  ),
  gate(
    "scenario_artifacts",
    "scenario artifact upload is incomplete",
    `
    SELECT count(*) AS count FROM scenario_run_artifacts WHERE upload_status <> 'uploaded'`,
  ),
  gate(
    "workshop_sessions",
    "workshop session is nonterminal",
    `
    SELECT count(*) AS count FROM workshop_sessions WHERE state NOT IN ('ended', 'cancelled')`,
  ),
  gate(
    "workshop_members",
    "workshop roster provisioning is nonterminal",
    `
    SELECT count(*) AS count FROM workshop_session_members
    WHERE provision_state IN ('queued', 'provisioning', 'ready')`,
  ),
  gate(
    "workshop_workspaces",
    "workshop workspace or route is live",
    `
    SELECT count(*) AS count FROM workshop_workspaces
    WHERE state NOT IN ('ended', 'failed')
       OR json_array_length(terminal_route_usernames_json) > 0
       OR json_array_length(application_route_ids_json) > 0`,
  ),
  gate(
    "workshop_generations",
    "workspace generation is nonterminal",
    `
    SELECT count(*) AS count FROM workshop_workspace_generations
    WHERE state NOT IN ('archived', 'failed')`,
  ),
  gate(
    "workshop_help",
    "help request is active",
    `
    SELECT count(*) AS count FROM workshop_help_requests WHERE status IN ('open', 'claimed')`,
  ),
  gate(
    "workshop_assist",
    "assistance grant is active or still routed",
    `
    SELECT count(*) AS count FROM workshop_assist_grants
    WHERE revoked_at IS NULL OR json_array_length(terminal_route_usernames_json) > 0`,
  ),
  timedGate(
    "route_capabilities",
    "workshop route capability is active",
    `
    SELECT count(*) AS count FROM workshop_route_issuance_intents
    WHERE state IN ('pending', 'issued') AND capability_expires_at > ?`,
  ),
  gate(
    "image_builds",
    "image build is active",
    `
    SELECT count(*) AS count FROM image_builds WHERE status IN ('queued', 'assigned', 'building')`,
  ),
  timedGate(
    "image_build_locks",
    "image build coordination lock is active",
    `
    SELECT count(*) AS count FROM image_build_coordination_locks
    WHERE expires_at IS NULL OR expires_at > ?`,
  ),
  gate(
    "publications",
    "workshop publication/certification is active",
    `
    SELECT count(*) AS count FROM workshop_publications
    WHERE status IN ('queued', 'building')
       OR certification_state IN ('verifying', 'cleanup_pending')`,
  ),
  gate(
    "publication_checkpoints",
    "publication checkpoint is active",
    `
    SELECT count(*) AS count FROM workshop_publication_checkpoints
    WHERE status IN ('pending', 'building')`,
  ),
  gate(
    "runtime_profile_certification",
    "runtime profile certification is active",
    `
    SELECT count(*) AS count FROM workshop_runtime_profile_certifications
    WHERE state IN ('pending', 'verifying', 'cleanup_pending')`,
  ),
  gate(
    "desired_state",
    "host desired state contains active work",
    `
    SELECT count(*) AS count FROM host_desired_state
    WHERE EXISTS (
      SELECT 1 FROM json_each(host_desired_state.doc_json, '$.vms') vm
      WHERE json_extract(vm.value, '$.desired_phase') <> 'absent'
    ) OR json_array_length(doc_json, '$.builds') > 0`,
  ),
  gate(
    "cpu_reservations",
    "host CPU reservation remains",
    `
    SELECT count(*) AS count FROM host_cpu_reservations`,
  ),
  gate(
    "resource_reservations",
    "host resource reservation remains active",
    `
    SELECT count(*) AS count FROM host_resource_reservations WHERE state <> 'released'`,
  ),
  gate(
    "active_slots",
    "active runtime slot remains",
    `
    SELECT count(*) AS count FROM active_runtime_slots`,
  ),
  timedGate(
    "runtime_locks",
    "runtime allocation lock is active",
    `
    SELECT count(*) AS count FROM runtime_allocation_locks WHERE expires_at > ?`,
  ),
  gate(
    "provider_allocations",
    "provider allocation is nonterminal",
    `
    SELECT count(*) AS count FROM runtime_provider_allocations
    WHERE state NOT IN ('deleted', 'failed')`,
  ),
  gate(
    "provider_resources",
    "provider resource deletion is unconfirmed",
    `
    SELECT count(*) AS count FROM runtime_provider_resources
    WHERE disappearance_confirmed_at IS NULL`,
  ),
  gate(
    "provider_operations",
    "provider operation is nonterminal",
    `
    SELECT count(*) AS count FROM runtime_provider_operations
    WHERE state IN ('pending', 'running', 'retryable')`,
  ),
  gate(
    "provider_reconciliation",
    "provider reconciliation has not observed deletion",
    `
    SELECT count(*) AS count FROM runtime_provider_reconciliation
    WHERE desired_state <> 'deleted' OR observed_state <> 'deleted'`,
  ),
  gate(
    "cost_cleanup",
    "provider cost cleanup remains unverified",
    `
    SELECT count(*) AS count FROM workshop_session_cost_summaries
    WHERE cleanup_pending_count > 0 OR manual_cleanup_unverified = 1`,
  ),
  timedGate(
    "organization_invitations",
    "organization invitation is still usable",
    `
    SELECT count(*) AS count FROM invitation
    WHERE status = 'pending' AND expires_at > ?`,
  ),
] as const satisfies readonly SourceGate[];

export function transformCopiedRow(
  table: ApplicationTable,
  row: CopyRow,
  cutoverAt: number,
): CopyRow {
  const transformed = { ...row };

  if (table === "account") {
    for (const column of [
      "access_token",
      "refresh_token",
      "id_token",
      "access_token_expires_at",
      "refresh_token_expires_at",
      "scope",
      "password",
    ]) {
      transformed[column] = null;
    }
  } else if (table === "access_invite_codes" && row.state === "leased") {
    transformed.state = "pending";
    transformed.lease_id = null;
    transformed.leased_at = null;
    transformed.lease_expires_at = null;
    transformed.version =
      asInteger(row.version, "access_invite_codes.version") + 1;
    transformed.updated_at = cutoverAt;
  } else if (table === "agent_hosts") {
    transformed.connected = 0;
    transformed.active_session_id = null;
    transformed.disconnected_at = cutoverAt;
    transformed.updated_at = cutoverAt;
  } else if (table === "workshop_registry_tokens") {
    transformed.token_hash = createHash("sha256")
      .update(
        `retired-at-d1-cutover:${String(row.id)}:${String(row.token_hash)}`,
      )
      .digest("hex");
    transformed.revoked_at = row.revoked_at ?? cutoverAt;
  } else if (table === "runtime_vms") {
    for (const column of [
      "terminal_host",
      "terminal_port",
      "terminal_username",
      "terminal_host_key_openssh",
      "terminal_private_key_ciphertext_b64",
      "terminal_private_key_iv_b64",
      "terminal_observed_at",
    ]) {
      transformed[column] = null;
    }
  } else if (table === "workshop_publications") {
    transformed.claim_expires_at = null;
  }

  return transformed;
}

function copy(
  table: ApplicationTable,
  reason: string,
  options: Omit<CopyTablePolicy, "action" | "table" | "reason"> = {},
): CopyTablePolicy {
  return { action: "copy", table, reason, ...options };
}

function exclude(table: ApplicationTable, reason: string): ExcludeTablePolicy {
  return { action: "exclude", table, reason };
}

function gate(id: string, description: string, sql: string): SourceGate {
  return { id, description, sql: sql.trim() };
}

function timedGate(id: string, description: string, sql: string): SourceGate {
  return { ...gate(id, description, sql), usesCutoverTime: true };
}

function asInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return value;
}
