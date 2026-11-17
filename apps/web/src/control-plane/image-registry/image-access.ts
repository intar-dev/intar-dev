import { sql } from "drizzle-orm";
import type { VerifiedAgentHost } from "@/control-plane/auth";

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
        SELECT 1 FROM user owner WHERE owner.id = current_host.user_id
          AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0
      ))))`;
}
