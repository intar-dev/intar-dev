import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  organizationProviderConnections,
  type ProviderPriceObservation,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { resolveHetznerCatalog } from "@/lib/hcloud-provider-service";
import { requireWorkshopHcloudRuntimeEnabledForOrganization } from "@/lib/workshops/feature-flag";
import { refreshHetznerCatalog } from "@/lib/workshops/provider-connections";
import type {
  ResolvedWorkshopWorkspaceProvider,
  ValidatedWorkshopSourceBundle,
} from "./archive";

interface HetznerAuthoringDeclaration {
  kind: "hetzner_cloud";
  vmId: string;
  serverType: string;
  systemImage: string;
  requirements: {
    requiredCpuMillis: number;
    requiredMemoryMib: number;
    requiredDiskMib: number;
  };
}

/**
 * Turn an author declaration into the only provider representation that may
 * be stored in an immutable revision. This intentionally requires the
 * organization's live BYOK connection; source-bundle input can never assert
 * `compatible: true` by itself.
 */
export async function resolveWorkshopPublicationProvider(input: {
  d1: D1Database;
  organizationId: string;
  source: ValidatedWorkshopSourceBundle;
  now?: number;
}): Promise<ResolvedWorkshopWorkspaceProvider | undefined> {
  return (await resolveWorkshopPublicationProviderContext(input))?.provider;
}

export interface ResolvedWorkshopPublicationProviderContext {
  provider: ResolvedWorkshopWorkspaceProvider;
  connectionId: string;
  permittedLocations: string[];
  priceObservation: ProviderPriceObservation;
}

export async function resolveWorkshopPublicationProviderContext(input: {
  d1: D1Database;
  organizationId: string;
  source: ValidatedWorkshopSourceBundle;
  now?: number;
}): Promise<ResolvedWorkshopPublicationProviderContext | undefined> {
  const declaration = readHetznerAuthoringDeclaration(input.source);
  if (!declaration) return undefined;

  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    input.organizationId,
  );
  const db = drizzle(input.d1);
  const connections = await db
    .select()
    .from(organizationProviderConnections)
    .where(
      and(
        eq(
          organizationProviderConnections.organizationId,
          input.organizationId,
        ),
        eq(organizationProviderConnections.providerKind, "hetzner_cloud"),
      ),
    )
    .limit(2);
  const connection = connections[0];
  if (!connection) {
    throw appError(
      409,
      "hcloud_provider_connection_required",
      "an active organization Hetzner project connection is required to publish this workshop",
    );
  }
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "the organization Hetzner project connection is not active",
    );
  }

  const catalog = await refreshHetznerCatalog({
    organizationId: input.organizationId,
    connectionId: connection.id,
    requiredServerTypes: [declaration.serverType],
    systemImage: declaration.systemImage,
  });
  const resolved = resolveHetznerCatalog({
    catalog,
    exactServerType: declaration.serverType,
    systemImage: declaration.systemImage,
    permittedLocations: connection.approvedLocationsJson,
    ...declaration.requirements,
  });
  const now = input.now ?? Date.now();
  await db
    .update(organizationProviderConnections)
    .set({ lastValidatedAt: now, updatedAt: now })
    .where(eq(organizationProviderConnections.id, connection.id));
  return {
    provider: {
      kind: "hetzner_cloud",
      vmId: declaration.vmId,
      serverType: resolved.serverType,
      systemImage: resolved.systemImage,
      hardware: resolved.hardware,
      compatible: true,
    },
    connectionId: connection.id,
    permittedLocations: [...connection.approvedLocationsJson],
    priceObservation: resolved.prices,
  };
}

export function workshopUsesHetznerProvider(
  source: ValidatedWorkshopSourceBundle,
): boolean {
  return readHetznerAuthoringDeclaration(source) !== undefined;
}

function readHetznerAuthoringDeclaration(
  source: ValidatedWorkshopSourceBundle,
): HetznerAuthoringDeclaration | undefined {
  const compiled = source.compiledManifest;
  const manifest = object(compiled.manifest, "manifest");
  const workspace = object(manifest.workspace, "manifest.workspace");
  if (workspace.provider === undefined || workspace.provider === null) {
    return undefined;
  }
  const provider = object(workspace.provider, "manifest.workspace.provider");
  if (provider.kind !== "hetzner_cloud") {
    throw appError(
      400,
      "workshop_provider_unsupported",
      "workshop workspace provider is unsupported",
    );
  }
  const vmId = text(provider.vm_id, "workspace provider vm_id");
  const vms = Array.isArray(workspace.vms) ? workspace.vms : [];
  const vm = vms
    .map((value) => object(value, "workspace VM"))
    .find((candidate) => candidate.id === vmId);
  if (!vm || vms.length !== 1) {
    throw appError(
      400,
      "workshop_provider_vm_invalid",
      "Hetzner workshop provider must reference the only workspace VM",
    );
  }
  const diskGib = integer(vm.disk_gib, "workspace VM disk_gib");
  const requiredDiskMib = diskGib * 1_024;
  if (!Number.isSafeInteger(requiredDiskMib)) {
    throw appError(
      400,
      "workshop_provider_requirements_invalid",
      "workshop VM disk requirement is out of range",
    );
  }
  return {
    kind: "hetzner_cloud",
    vmId,
    serverType: text(provider.server_type, "workspace provider server_type"),
    systemImage: text(provider.system_image, "workspace provider system_image"),
    requirements: {
      requiredCpuMillis: integer(vm.vcpu_millis, "workspace VM vcpu_millis"),
      requiredMemoryMib: integer(vm.memory_mib, "workspace VM memory_mib"),
      requiredDiskMib,
    },
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw appError(
      400,
      "workshop_provider_invalid",
      `${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw appError(400, "workshop_provider_invalid", `${label} is required`);
  }
  return value.trim();
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw appError(
      400,
      "workshop_provider_invalid",
      `${label} must be a positive integer`,
    );
  }
  return Number(value);
}
