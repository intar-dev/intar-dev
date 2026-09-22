import { currentScenarioRunContentAccessCondition } from "@/lib/scenario-runs/content-access";
import { sql } from "drizzle-orm";
import { agentHosts, member, organization, user } from "@/db/schema";

/** Used by selection. Admission repeats it at commit. */
export function metalPlacementForUser(userId: string, organizationId: string | null = null) {
  return sql`EXISTS (SELECT 1 FROM ${user}
    WHERE ${user.id} = ${userId} AND ${user.deletedAt} IS NULL AND coalesce(${user.banned}, 0) = 0
      AND (${organizationId} IS NULL OR EXISTS (SELECT 1 FROM ${member}
        WHERE ${member.userId} = ${userId} AND ${member.organizationId} = ${organizationId}))
      AND ((${user.metalPlacement} = 'personal' AND ${agentHosts.scope} = 'personal'
          AND ${agentHosts.userId} = ${userId})
        OR (${user.metalPlacement} = 'platform'
          AND ((${organizationId} IS NULL AND ${agentHosts.scope} = 'platform')
            OR EXISTS (SELECT 1 FROM ${organization} WHERE ${organization.id} = ${organizationId}
              AND ((${organization.metalPlacement} = 'platform' AND ${agentHosts.scope} = 'platform')
                OR (${organization.metalPlacement} = 'organization' AND ${agentHosts.scope} = 'organization'
                  AND ${agentHosts.organizationId} = ${organizationId})))))))`;
}

/** Catalog totals include every accessible pool, regardless of placement preference. */
export function capacityHostAccessForUser(userId: string, organizationId: string | null = null) {
  return sql`EXISTS (SELECT 1 FROM ${user}
    WHERE ${user.id} = ${userId} AND ${user.deletedAt} IS NULL AND coalesce(${user.banned}, 0) = 0
      AND (${organizationId} IS NULL OR EXISTS (SELECT 1 FROM ${member}
        WHERE ${member.userId} = ${userId} AND ${member.organizationId} = ${organizationId}))
      AND (${agentHosts.scope} = 'platform'
        OR (${agentHosts.scope} = 'personal' AND ${agentHosts.userId} = ${userId})
        OR (${agentHosts.scope} = 'organization' AND EXISTS (SELECT 1 FROM ${member}
          WHERE ${member.userId} = ${userId} AND ${member.organizationId} = ${agentHosts.organizationId}))))`;
}

/** Parameters must be numbered SQLite placeholders, never request text. */
export function metalAdmissionSql(userParameter: string, organizationParameter: string): string {
  if (![userParameter, organizationParameter].every(parameter => /^\?[1-9][0-9]*$/.test(parameter))) {
    throw new Error("Expected numbered placement parameters");
  }
  return `EXISTS (SELECT 1 FROM user owner WHERE owner.id = ${userParameter}
    AND owner.deleted_at IS NULL AND coalesce(owner.banned, 0) = 0
    AND (${organizationParameter} IS NULL OR EXISTS (SELECT 1 FROM member membership
      WHERE membership.user_id = ${userParameter} AND membership.organization_id = ${organizationParameter}))
    AND ((owner.metal_placement = 'personal' AND host.scope = 'personal' AND host.user_id = ${userParameter})
      OR (owner.metal_placement = 'platform'
        AND ((${organizationParameter} IS NULL AND host.scope = 'platform')
          OR EXISTS (SELECT 1 FROM organization org WHERE org.id = ${organizationParameter}
            AND ((org.metal_placement = 'platform' AND host.scope = 'platform')
              OR (org.metal_placement = 'organization' AND host.scope = 'organization'
                AND host.organization_id = ${organizationParameter})))))))`;
}

/** Existing run access uses the assigned host, independent of new-run placement.
 * The caller must join agent_hosts as host, scenario_runs as run, and runtime_executions as execution.
 */
export function currentRunHostScopeCondition(): string {
  return `(host.scope = 'platform'
    OR (host.scope = 'personal' AND host.user_id = execution.user_id)
    OR (host.scope = 'organization' AND host.organization_id = run.organization_id
      AND EXISTS (SELECT 1 FROM user run_owner
        JOIN access_allowlist access ON access.user_id = run_owner.id AND access.state = 'active'
        WHERE run_owner.id = run.user_id AND run_owner.deleted_at IS NULL AND coalesce(run_owner.banned, 0) = 0)
      AND (${currentScenarioRunContentAccessCondition()})))`;
}
