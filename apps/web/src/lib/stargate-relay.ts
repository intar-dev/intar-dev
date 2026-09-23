import { organizationHostAdmissionCondition } from "@/control-plane/auth";
import { env } from "cloudflare:workers";
import type { HostRelayCredentials } from "@/generated/bridge";
import type { HostRelayIdentity, RelayTarget, SshTargetTransport } from "@/generated/stargate";
import { activeAccountExistsSql } from "@/lib/account-access";
import { stargateRelayAdminRequest } from "@/lib/stargate";
import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/admission-guards";

export interface HostRelaySession {
  hostId: string;
  sessionId: string;
  credentialGeneration: number;
}
function identity(input: HostRelaySession): HostRelayIdentity {
  return { host_id: input.hostId, session_id: input.sessionId, credential_generation: input.credentialGeneration };
}
const LEASE_MS = 120_000;

async function snapshot(input: HostRelaySession) {
  const host = await env.DB.prepare(`SELECT host.scope, host.organization_id, host.connected_at
    FROM agent_hosts host
    WHERE host.id = ?1 AND host.active_session_id = ?2 AND host.credential_generation = ?3
      AND host.credential_generation > 0 AND host.disabled = 0 AND host.connected = 1
      AND ((host.scope = 'organization' AND host.role = 'agent' AND (${organizationHostAdmissionCondition()}))
        OR (host.scope IN ('platform', 'personal') AND ${activeAccountExistsSql("host.user_id")}))`)
    .bind(input.hostId, input.sessionId, input.credentialGeneration)
    .first<{ scope: "platform" | "personal" | "organization"; organization_id: string | null; connected_at: number }>();
  if (!host) return null;
  if (host.scope === "platform") return { host, rows: [], targets: [] };
  const { results } = await env.DB.prepare(`SELECT execution.id AS execution_id,
      execution.generation, execution.user_id, vm.vm_id,
      json_extract(desired.value, '$.lease_expires_at_unix_ms') AS lease_expires_at
    FROM agent_hosts host
    INNER JOIN host_desired_state desired_state ON desired_state.host_id = host.id
    INNER JOIN json_each(desired_state.doc_json, '$.vms') desired
    INNER JOIN runtime_executions execution ON execution.host_id = host.id
      AND execution.id = json_extract(desired.value, '$.runtime_execution_id')
      AND execution.generation = json_extract(desired.value, '$.generation')
      AND execution.user_id = json_extract(desired.value, '$.owner_user_id')
    INNER JOIN runtime_vms vm ON vm.execution_id = execution.id
      AND vm.vm_id = json_extract(desired.value, '$.vm_id')
    INNER JOIN scenario_runs run ON run.runtime_execution_id = execution.id AND run.run_id = execution.domain_id
      AND run.host_id = host.id AND run.user_id = execution.user_id
    INNER JOIN user runner ON runner.id = execution.user_id AND runner.deleted_at IS NULL AND coalesce(runner.banned, 0) = 0
    WHERE host.id = ?1 AND host.active_session_id = ?2 AND host.credential_generation = ?3
      AND ((host.scope = 'personal' AND host.user_id = execution.user_id)
        OR (host.scope = 'organization' AND host.role = 'agent' AND host.organization_id = run.organization_id
          AND EXISTS (SELECT 1 FROM member membership WHERE membership.organization_id = host.organization_id
            AND membership.user_id = execution.user_id)))
      AND host.disabled = 0 AND host.connected = 1
      AND execution.domain_kind = 'scenario' AND execution.state IN ('queued', 'provisioning', 'ready')
      AND execution.archive_requested_at IS NULL
      AND run.delete_requested_at IS NULL AND run.completed_at IS NULL AND run.failed_at IS NULL
      AND json_extract(desired.value, '$.desired_phase') = 'running'
      AND json_extract(desired.value, '$.lease_expires_at_unix_ms') > ?4
      AND NOT EXISTS (SELECT 1 FROM runtime_executions newer WHERE newer.domain_kind = execution.domain_kind
        AND newer.domain_id = execution.domain_id AND newer.generation > execution.generation)
      AND (${currentScenarioRunContentAccessCondition()})
    ORDER BY execution.id, vm.vm_id LIMIT 65`)
    .bind(input.hostId, input.sessionId, input.credentialGeneration, Date.now())
    .all<{ execution_id: string; generation: number; user_id: string; vm_id: string; lease_expires_at: number }>();
  if (results.length > 64) throw new Error("host relay assignment limit reached");
  return { host, rows: results, targets: results.map((row): RelayTarget => ({
    host: identity(input), owner_id: row.user_id, execution_id: row.execution_id,
    execution_generation: row.generation, vm_id: row.vm_id, service: "ssh",
  })) };
}

/** Called once per host snapshot/lease refresh. Data streams do not call D1 or a DO. */
export async function refreshStargateHostRelay(input: HostRelaySession): Promise<HostRelayCredentials | null> {
  const before = await snapshot(input);
  if (!before) {
    const host = await env.DB.prepare("SELECT scope FROM agent_hosts WHERE id = ?1").bind(input.hostId).first<{scope:string}>();
    if (host?.scope === "personal" || host?.scope === "organization") await revokeStargateHostRelay(input);
    return null;
  }
  if (before.host.scope === "platform") return null;
  // Session order can advance by one millisecond when two hellos share a clock tick.
  const issuedAt = Math.max(Date.now(), before.host.connected_at);
  try {
    const response = await stargateRelayAdminRequest("grant", {
      identity: identity(input), targets: before.targets,
      session_started_at_unix_ms: before.host.connected_at,
      issued_at_unix_ms: issuedAt,
      expires_at_unix_ms: Math.min(issuedAt + LEASE_MS, ...before.rows.map((row) => row.lease_expires_at)),
    });
    if (!response.ok) throw new Error(`host relay grant failed (${response.status})`);
    const credentials: HostRelayCredentials = await response.json();
    if (JSON.stringify(before) !== JSON.stringify(await snapshot(input))) throw new Error("host relay authorization changed during issuance");
    const expected = identity(input);
    if (credentials.identity.host_id !== expected.host_id || credentials.identity.session_id !== expected.session_id
      || credentials.identity.credential_generation !== expected.credential_generation
      || !credentials.websocket_url.startsWith("wss://") || credentials.expires_at_unix_ms <= Date.now()) {
      throw new Error("invalid host relay credentials");
    }
    return credentials;
  } catch (error) {
    await revokeStargateHostRelay(input);
    throw error;
  }
}

export async function revokeStargateHostRelay(input: HostRelaySession): Promise<void> {
  const response = await stargateRelayAdminRequest("revoke", identity(input));
  if (!response.ok) throw new Error(`host relay revoke failed (${response.status})`);
}
export async function revokeStargateHostRelayCredentials(input: { hostId: string; credentialGeneration: number }): Promise<void> {
  const response = await stargateRelayAdminRequest("revoke-credentials", { host_id: input.hostId, credential_generation: input.credentialGeneration });
  if (!response.ok) throw new Error(`host relay credential revoke failed (${response.status})`);
}

/** Personal and organization hosts always use the outbound relay. */
export async function loadStargateSshTransport(input: {
  hostId: string; ownerId: string; executionId: string; executionGeneration: number;
  vmId: string; directHost: string; directPort: number;
}): Promise<SshTargetTransport> {
  const host = await env.DB.prepare(`SELECT scope, user_id, active_session_id, credential_generation
    FROM agent_hosts WHERE id = ?1 AND disabled = 0 AND credential_generation > 0`)
    .bind(input.hostId).first<{ scope: "personal" | "platform" | "organization"; user_id: string; active_session_id: string | null; credential_generation: number }>();
  if (!host) throw new Error("terminal host is not available");
  if (host.scope === "platform") return { kind: "direct", host: input.directHost, port: input.directPort };
  if (!host.active_session_id || (host.scope !== "personal" && host.scope !== "organization")
    || (host.scope === "personal" && host.user_id !== input.ownerId)) throw new Error("host relay is not available");
  if (host.scope === "organization") {
    const authorized = await snapshot({ hostId: input.hostId, sessionId: host.active_session_id,
      credentialGeneration: host.credential_generation });
    if (!authorized?.targets.some(target => target.owner_id === input.ownerId
      && target.execution_id === input.executionId && target.execution_generation === input.executionGeneration
      && target.vm_id === input.vmId)) throw new Error("organization relay target is not available");
  }
  return { kind: "relay", target: {
    host: { host_id: input.hostId, session_id: host.active_session_id, credential_generation: host.credential_generation },
    owner_id: input.ownerId, execution_id: input.executionId,
    execution_generation: input.executionGeneration, vm_id: input.vmId, service: "ssh",
  } };
}
