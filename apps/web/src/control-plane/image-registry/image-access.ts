import { and, eq, or, sql } from "drizzle-orm";
import type { VerifiedAgentHost } from "@/control-plane/auth";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { scenarioCatalogCandidates, vmScenarios, vmScenarioVms } from "@/db/schema";
import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/content-access";
import { personalPreparationImageAccess } from "@/lib/personal-image-access";

/** Recheck the identity snapshot at each content read, including platform reads. */
export function currentAgentHost(agent: VerifiedAgentHost) {
  if ((agent.scope !== "platform" && agent.scope !== "personal" && agent.scope !== "organization") ||
      !Number.isSafeInteger(agent.credentialGeneration) || agent.credentialGeneration < 1) return sql`0 = 1`;
  return sql`EXISTS (SELECT 1 FROM agent_hosts current_host
    WHERE current_host.id = ${agent.hostId} AND current_host.user_id = ${agent.userId}
      AND current_host.scope = ${agent.scope} AND current_host.role = ${agent.role}
      AND current_host.credential_generation = ${agent.credentialGeneration}
      AND current_host.disabled = 0
      AND (${agent.scope} = 'platform' OR (${agent.scope} = 'organization'
        AND current_host.organization_id = ${agent.organizationId ?? null} AND current_host.role = 'agent'
        AND EXISTS (SELECT 1 FROM organization org WHERE org.id = current_host.organization_id))
        OR (${agent.scope} = 'personal' AND EXISTS (
        SELECT 1 FROM access_allowlist access WHERE access.user_id = current_host.user_id
          AND access.state = 'active' AND access.source_invite_id = ${agent.betaSourceInviteId}
          AND access.source_lease_id = ${agent.betaSourceLeaseId}
          AND access.granted_at = ${agent.betaAdmissionGrantedAt}
      ))))`;
}

/** Correlated with vmScenarios and vmScenarioVms in the caller's query. */
export function agentScenarioImageAccess(agent: VerifiedAgentHost) {
  if (agent.scope === "platform") return currentAgentHost(agent);
  if (agent.scope !== "personal" && agent.scope !== "organization") return sql`0 = 1`;

  return and(currentAgentHost(agent), assignedPersonalScenarioImageAccess(agent.hostId));
}

/** Public and private images both need an exact current workload or preparation. */
export function assignedPersonalScenarioImageAccess(hostId: string) {
  // Materialize content access separately to stay within D1's expression-depth limit.
  return or(personalPreparationImageAccess(hostId), sql`EXISTS (
    WITH permitted_runs AS MATERIALIZED (
      SELECT run.run_id FROM scenario_runs run
      WHERE run.host_id = ${hostId} AND (${sql.raw(currentScenarioRunContentAccessCondition())})
    )
    SELECT 1 FROM runtime_vms vm
    JOIN runtime_executions execution ON execution.id = vm.execution_id
    JOIN scenario_runs run ON run.runtime_execution_id = execution.id
    JOIN permitted_runs permitted ON permitted.run_id = run.run_id
    JOIN agent_hosts host ON host.id = execution.host_id
    JOIN host_desired_state desired ON desired.host_id = host.id
    JOIN json_each(desired.doc_json, '$.vms') intent
    WHERE host.id = ${hostId} AND host.disabled = 0
      AND ((host.scope = 'personal' AND host.user_id = execution.user_id)
        OR (host.scope = 'organization' AND host.organization_id = run.organization_id
          AND EXISTS (SELECT 1 FROM member membership WHERE membership.organization_id = host.organization_id
            AND membership.user_id = execution.user_id)))
      AND (json_extract(desired.doc_json, '$.scope'), json_extract(desired.doc_json, '$.owner_user_id')) = (host.scope, host.user_id)
      AND EXISTS (SELECT 1 FROM user owner JOIN access_allowlist access ON access.user_id = owner.id
        WHERE owner.id = execution.user_id AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0
          AND access.state = 'active')
      AND (execution.user_id, run.user_id, run.host_id, execution.domain_kind, execution.domain_id) =
        (run.user_id, execution.user_id, host.id, 'scenario', run.run_id)
      AND (execution.state IN ('provisioning', 'ready') AND execution.ended_at IS NULL
        AND execution.archive_requested_at IS NULL AND execution.lease_expires_at > CAST(unixepoch('subsecond') * 1000 AS INTEGER))
      AND NOT EXISTS (SELECT 1 FROM runtime_executions newer
        WHERE newer.domain_kind = execution.domain_kind AND newer.domain_id = execution.domain_id
          AND newer.generation > execution.generation)
      AND (run.active_key = execution.user_id AND run.hidden_at IS NULL AND run.completed_at IS NULL
        AND run.failed_at IS NULL AND run.delete_requested_at IS NULL)
      AND run.scenario_id = ${vmScenarios.scenarioId}
      AND (vm.image_sha256, json_extract(vm.image_key_json, '$.scenario'), json_extract(vm.image_key_json, '$.vm'),
        json_extract(vm.image_key_json, '$.arch')) = (${vmScenarioVms.imageSha256},
        json_extract(${vmScenarioVms.imageKeyJson}, '$.scenario'), json_extract(${vmScenarioVms.imageKeyJson}, '$.vm'),
        json_extract(${vmScenarioVms.imageKeyJson}, '$.arch'))
      AND (json_extract(intent.value, '$.run_id'), json_extract(intent.value, '$.owner_user_id'),
        json_extract(intent.value, '$.runtime_execution_id'), json_extract(intent.value, '$.generation'),
        json_extract(intent.value, '$.vm_name'), json_extract(intent.value, '$.desired_phase')) =
        (run.run_id, execution.user_id, execution.id, execution.generation, vm.runtime_vm_name, 'running')
      AND json_extract(intent.value, '$.lease_expires_at_unix_ms') > CAST(unixepoch('subsecond') * 1000 AS INTEGER)
      AND (json_extract(intent.value, '$.image_id'), json_extract(intent.value, '$.image_key.scenario'),
        json_extract(intent.value, '$.image_key.vm'), json_extract(intent.value, '$.image_key.arch')) =
        (vm.image_sha256, json_extract(vm.image_key_json, '$.scenario'), json_extract(vm.image_key_json, '$.vm'),
        json_extract(vm.image_key_json, '$.arch'))
  )`);
}

/** Match one manifest; the hash selects context, never an authorization grant. */
export async function agentCanAccessManifest(
  db: DrizzleD1Database, agent: VerifiedAgentHost, manifestSha256: string, imageId?: string,
): Promise<boolean> {
  const rows = await db.select({ id: vmScenarioVms.id }).from(vmScenarioVms)
    .innerJoin(vmScenarios, eq(vmScenarios.scenarioId, vmScenarioVms.scenarioId))
    .where(and(
      eq(vmScenarioVms.chunkManifestSha256, manifestSha256),
      eq(vmScenarioVms.imageFormat, "raw_chunks_v1"),
      imageId === undefined ? undefined : eq(vmScenarioVms.imageSha256, imageId),
      agentScenarioImageAccess(agent),
    )).limit(1);
  if (rows.length) return true;
  if (agent.scope !== "platform") return false;
  // Platform candidate preparation is an exact desired image, not every candidate.
  const candidates = await db.select({ id: scenarioCatalogCandidates.scenarioId }).from(scenarioCatalogCandidates)
    .where(and(currentAgentHost(agent), sql`EXISTS (
      SELECT 1 FROM json_each(${scenarioCatalogCandidates.manifestJson}, '$.vms') vm
      JOIN host_desired_state desired ON desired.host_id = ${agent.hostId}
      JOIN json_each(desired.doc_json, '$.cached_images') intent
      WHERE json_extract(vm.value, '$.chunk_manifest_sha256') = ${manifestSha256}
        AND (${imageId ?? null} IS NULL OR json_extract(vm.value, '$.image_id') = ${imageId ?? null})
        AND json_extract(vm.value, '$.image_format') = 'raw_chunks_v1'
        AND json_extract(intent.value, '$.image_id') = json_extract(vm.value, '$.image_id')
        AND json_extract(intent.value, '$.image_key.scenario') = json_extract(vm.value, '$.image_key.scenario')
        AND json_extract(intent.value, '$.image_key.vm') = json_extract(vm.value, '$.image_key.vm')
        AND json_extract(intent.value, '$.image_key.arch') = json_extract(vm.value, '$.image_key.arch')
    )`)).limit(1);
  return candidates.length > 0;
}
