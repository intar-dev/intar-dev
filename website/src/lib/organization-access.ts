import { env } from "cloudflare:workers";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { member } from "@/db/schema";
import {
  FlagshipFeatureToggleService,
  flagshipBindingFromEnvironment,
  type FeatureToggleService,
} from "@/lib/feature-toggles";

export const ORGANIZATION_CREATION_FLAG = "organization-creation";

export async function canCreateOrganization(
  userId: string,
  service: FeatureToggleService = featureToggleService(),
): Promise<boolean> {
  const targetingKey = userId.trim();
  if (!targetingKey) return false;

  return service.getBoolean(ORGANIZATION_CREATION_FLAG, false, {
    targetingKey,
  });
}

export async function hasReachedOwnedOrganizationLimit(
  userId: string,
): Promise<boolean> {
  const rows = await drizzle(env.DB)
    .select({ value: count() })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.role, "owner")));
  return (rows[0]?.value ?? 0) >= 1;
}

export function featureToggleService(): FeatureToggleService {
  return new FlagshipFeatureToggleService(flagshipBindingFromEnvironment(env));
}
