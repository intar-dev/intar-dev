import { sql } from "drizzle-orm";
import { agentHosts, user } from "@/db/schema";

/** Used by selection and capacity displays. Admission repeats it at commit. */
export function metalPlacementForUser(userId: string) {
  return sql`EXISTS (SELECT 1 FROM ${user}
    WHERE ${user.id} = ${userId}
      AND ((${user.metalPlacement} = 'platform' AND ${agentHosts.scope} = 'platform')
        OR (${user.metalPlacement} = 'personal' AND ${agentHosts.scope} = 'personal'
          AND ${agentHosts.userId} = ${userId})))`;
}

/** userParameter must be a numbered SQLite placeholder, never request text. */
export function metalAdmissionSql(userParameter: string): string {
  if (!/^\?[1-9][0-9]*$/.test(userParameter)) {
    throw new Error("Expected a numbered user parameter");
  }
  return `EXISTS (SELECT 1 FROM user owner WHERE owner.id = ${userParameter}
    AND ((owner.metal_placement = 'platform' AND host.scope = 'platform')
      OR (owner.metal_placement = 'personal' AND host.scope = 'personal'
        AND host.user_id = ${userParameter})))`;
}
