import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { workshopSessions } from "@/db/schema";
import { appError } from "@/lib/app-error";
import {
  FlagshipFeatureToggleService,
  flagshipBindingFromEnvironment,
  type FeatureToggleService,
} from "@/lib/feature-toggles";

export const WORKSHOPS_FEATURE_FLAG = "workshops_enabled";
export const WORKSHOP_HCLOUD_RUNTIME_FEATURE_FLAG =
  "workshop_hcloud_runtime_enabled";

export async function isWorkshopsEnabledForOrganization(
  organizationId: string,
  service: FeatureToggleService = workshopFeatureToggleService(),
): Promise<boolean> {
  const normalized = organizationId.trim();
  if (!normalized) return false;
  return service.getBoolean(WORKSHOPS_FEATURE_FLAG, false, {
    targetingKey: normalized,
    organizationId: normalized,
  });
}

export async function requireWorkshopsEnabledForOrganization(
  organizationId: string,
  service?: FeatureToggleService,
): Promise<void> {
  if (
    await isWorkshopsEnabledForOrganization(
      organizationId,
      service ?? workshopFeatureToggleService(),
    )
  ) {
    return;
  }
  throw workshopsDisabled();
}

export async function requireWorkshopsEnabledForSession(
  sessionId: string,
  service?: FeatureToggleService,
): Promise<string> {
  const rows = await drizzle(env.DB)
    .select({ organizationId: workshopSessions.organizationId })
    .from(workshopSessions)
    .where(eq(workshopSessions.id, sessionId))
    .limit(1);
  const organizationId = rows[0]?.organizationId;
  if (!organizationId) throw workshopsDisabled();
  await requireWorkshopsEnabledForOrganization(organizationId, service);
  return organizationId;
}

export function workshopFeatureToggleService(): FeatureToggleService {
  return new FlagshipFeatureToggleService(flagshipBindingFromEnvironment(env));
}

export async function isWorkshopHcloudRuntimeEnabledForOrganization(
  organizationId: string,
  service: FeatureToggleService = workshopFeatureToggleService(),
): Promise<boolean> {
  const normalized = organizationId.trim();
  if (!normalized) return false;
  return service.getBoolean(WORKSHOP_HCLOUD_RUNTIME_FEATURE_FLAG, false, {
    targetingKey: normalized,
    organizationId: normalized,
  });
}

export async function requireWorkshopHcloudRuntimeEnabledForOrganization(
  organizationId: string,
  service?: FeatureToggleService,
): Promise<void> {
  if (
    await isWorkshopHcloudRuntimeEnabledForOrganization(
      organizationId,
      service ?? workshopFeatureToggleService(),
    )
  ) {
    return;
  }
  throw appError(
    404,
    "workshop_hcloud_runtime_not_found",
    "Hetzner workshop runtime is not enabled",
  );
}

function workshopsDisabled() {
  return appError(404, "workshops_not_found", "workshops not found");
}
