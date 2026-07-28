import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  organizationProviderConnections,
  workshopEvents,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopTemplateRevisions,
  type ProviderHardwareShape,
  type ProviderPriceObservation,
  type WorkshopManifestV1,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { resolveHetznerCatalog } from "@/lib/hcloud-provider-service";
import {
  createWorkshopCostForecast,
  loadLatestWorkshopCostForecast,
  type WorkshopCostForecastTrigger,
} from "./cost-storage";
import { requireWorkshopHcloudRuntimeEnabledForOrganization } from "./feature-flag";
import {
  refreshHetznerCatalog,
  requireConnection,
} from "./provider-connections";

export type WorkshopRuntimeProviderInput =
  | { kind: "agent_kvm" }
  | { kind: "hetzner_cloud"; connectionId: string };

export interface PreparedWorkshopSessionProvider {
  providerKind: "agent_kvm" | "hetzner_cloud";
  connectionId: string | null;
  serverType: string | null;
  hardware: ProviderHardwareShape | null;
  permittedLocations: string[];
  initialPriceObservation: ProviderPriceObservation | null;
}

export async function prepareWorkshopSessionProvider(input: {
  organizationId: string;
  manifest: WorkshopManifestV1;
  runtimeProvider?: WorkshopRuntimeProviderInput;
}): Promise<PreparedWorkshopSessionProvider> {
  const requested = input.runtimeProvider ?? { kind: "agent_kvm" as const };
  if (requested.kind === "agent_kvm") {
    return {
      providerKind: "agent_kvm",
      connectionId: null,
      serverType: null,
      hardware: null,
      permittedLocations: [],
      initialPriceObservation: null,
    };
  }
  await requireWorkshopHcloudRuntimeEnabledForOrganization(
    input.organizationId,
  );
  const declaration = input.manifest.workspace.provider;
  if (!declaration || declaration.kind !== "hetzner_cloud") {
    throw appError(
      409,
      "workshop_revision_not_hcloud_compatible",
      "this workshop revision is not verified for Hetzner Cloud",
    );
  }
  const connection = await requireConnection(
    input.organizationId,
    requested.connectionId,
  );
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "the selected Hetzner provider connection is not active",
    );
  }
  const requirements = workshopRequirements(input.manifest, declaration.vmId);
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
    ...requirements,
  });
  assertPinnedHardwareUnchanged(declaration.hardware, resolved.hardware);
  return {
    providerKind: "hetzner_cloud",
    connectionId: connection.id,
    serverType: resolved.serverType,
    hardware: resolved.hardware,
    permittedLocations: connection.approvedLocationsJson,
    initialPriceObservation: resolved.prices,
  };
}

export async function persistWorkshopSessionProvider(input: {
  sessionId: string;
  prepared: PreparedWorkshopSessionProvider;
  now: number;
}): Promise<void> {
  await drizzle(env.DB).insert(workshopSessionRuntimeProviders).values({
    sessionId: input.sessionId,
    providerKind: input.prepared.providerKind,
    connectionId: input.prepared.connectionId,
    serverType: input.prepared.serverType,
    hardwareJson: input.prepared.hardware,
    permittedLocationsJson: input.prepared.permittedLocations,
    initialPriceObservationJson: input.prepared.initialPriceObservation,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export async function refreshWorkshopSessionProviderPreflight(input: {
  sessionId: string;
  actorUserId?: string | null;
  trigger: "lobby_refresh" | "admin_refresh" | "price_changed";
}): Promise<{ kind: "agent_kvm" } | { kind: "hetzner_cloud" }> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      organizationId: workshopSessions.organizationId,
      manifest: workshopTemplateRevisions.manifestJson,
      providerKind: workshopSessionRuntimeProviders.providerKind,
      connectionId: workshopSessionRuntimeProviders.connectionId,
      serverType: workshopSessionRuntimeProviders.serverType,
      hardware: workshopSessionRuntimeProviders.hardwareJson,
      locations: workshopSessionRuntimeProviders.permittedLocationsJson,
      grossOverrideAt: workshopSessionRuntimeProviders.grossCeilingOverrideAt,
      maxGrossMicros: organizationProviderConnections.maxSessionGrossMicros,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopTemplateRevisions.id, workshopSessions.templateRevisionId),
    )
    .innerJoin(
      workshopSessionRuntimeProviders,
      eq(workshopSessionRuntimeProviders.sessionId, workshopSessions.id),
    )
    .leftJoin(
      organizationProviderConnections,
      eq(
        organizationProviderConnections.id,
        workshopSessionRuntimeProviders.connectionId,
      ),
    )
    .where(eq(workshopSessions.id, input.sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  if (row.providerKind === "agent_kvm") return { kind: "agent_kvm" };
  const declaration = row.manifest.workspace.provider;
  if (!declaration || !row.connectionId || !row.serverType || !row.hardware) {
    throw appError(
      409,
      "workshop_provider_pin_invalid",
      "workshop session provider pin is incomplete",
    );
  }
  const connection = await requireConnection(
    row.organizationId,
    row.connectionId,
  );
  if (connection.state !== "active") {
    throw appError(
      409,
      "provider_connection_inactive",
      "the selected Hetzner provider connection is not active",
    );
  }
  if (declaration.serverType !== row.serverType) {
    throw appError(
      409,
      "workshop_provider_type_changed",
      "the session-pinned server type does not match its immutable revision",
    );
  }
  const catalog = await refreshHetznerCatalog({
    organizationId: row.organizationId,
    connectionId: row.connectionId,
    requiredServerTypes: [row.serverType],
    systemImage: declaration.systemImage,
  });
  const resolved = resolveHetznerCatalog({
    catalog,
    exactServerType: row.serverType,
    systemImage: declaration.systemImage,
    permittedLocations: row.locations,
    ...workshopRequirements(row.manifest, declaration.vmId),
  });
  assertPinnedHardwareUnchanged(row.hardware, resolved.hardware);
  const previousForecast = await loadLatestWorkshopCostForecast(
    input.sessionId,
  );
  const priceChanged = Boolean(
    previousForecast &&
    priceFingerprint(previousForecast.priceObservation) !==
      priceFingerprint(resolved.prices),
  );
  const forecastTrigger = workshopForecastTriggerForResolvedPrices({
    requestedTrigger: input.trigger,
    previous: previousForecast?.priceObservation ?? null,
    resolved: resolved.prices,
  });
  const forecast = await createWorkshopCostForecast({
    sessionId: input.sessionId,
    priceObservation: resolved.prices,
    trigger: forecastTrigger,
    ...(input.actorUserId === undefined
      ? {}
      : { actorUserId: input.actorUserId }),
  });
  if (priceChanged && previousForecast) {
    await db.insert(workshopEvents).values({
      id: createAppId(),
      organizationId: row.organizationId,
      sessionId: input.sessionId,
      actorUserId: input.actorUserId ?? null,
      type: "provider.price_changed",
      payloadJson: {
        previousForecastVersion: previousForecast.version,
        forecastVersion: forecast.version,
        currency: forecast.currency,
        exceedsGrossCeiling: forecast.exceedsGrossCeiling,
      },
      createdAt: forecast.createdAt,
    });
  }
  if (forecast.exceedsGrossCeiling && row.grossOverrideAt === null) {
    throw appError(
      409,
      "workshop_cost_ceiling_exceeded",
      "the lease-ceiling Hetzner forecast exceeds the organization limit",
    );
  }
  return { kind: "hetzner_cloud" };
}

export function workshopForecastTriggerForResolvedPrices(input: {
  requestedTrigger: "lobby_refresh" | "admin_refresh" | "price_changed";
  previous: ProviderPriceObservation | null;
  resolved: ProviderPriceObservation;
}): "lobby_refresh" | "admin_refresh" | "price_changed" {
  return input.previous &&
    priceFingerprint(input.previous) !== priceFingerprint(input.resolved)
    ? "price_changed"
    : input.requestedTrigger;
}

function priceFingerprint(observation: ProviderPriceObservation): string {
  return JSON.stringify({
    currency: observation.currency,
    serverType: observation.serverType,
    locations: observation.locations.map((entry) => ({
      location: entry.location,
      available: entry.available,
      serverHourlyNet: entry.serverHourlyNet,
      serverHourlyGross: entry.serverHourlyGross,
      serverMonthlyNet: entry.serverMonthlyNet ?? null,
      serverMonthlyGross: entry.serverMonthlyGross ?? null,
      ipv4HourlyNet: entry.ipv4HourlyNet,
      ipv4HourlyGross: entry.ipv4HourlyGross,
      ipv4MonthlyNet: entry.ipv4MonthlyNet ?? null,
      ipv4MonthlyGross: entry.ipv4MonthlyGross ?? null,
    })),
  });
}

export async function createInitialWorkshopSessionForecast(input: {
  sessionId: string;
  prepared: PreparedWorkshopSessionProvider;
  actorUserId: string;
}): Promise<void> {
  if (
    input.prepared.providerKind !== "hetzner_cloud" ||
    !input.prepared.initialPriceObservation
  ) {
    return;
  }
  await createWorkshopCostForecast({
    sessionId: input.sessionId,
    priceObservation: input.prepared.initialPriceObservation,
    trigger: "session_created",
    actorUserId: input.actorUserId,
  });
}

export async function createWorkshopSessionForecastFromPinnedPrice(input: {
  sessionId: string;
  actorUserId: string;
  trigger: Extract<
    WorkshopCostForecastTrigger,
    "session_created" | "roster_changed" | "schedule_changed"
  >;
}): Promise<void> {
  const rows = await drizzle(env.DB)
    .select({
      providerKind: workshopSessionRuntimeProviders.providerKind,
      initialPriceObservation:
        workshopSessionRuntimeProviders.initialPriceObservationJson,
    })
    .from(workshopSessionRuntimeProviders)
    .where(eq(workshopSessionRuntimeProviders.sessionId, input.sessionId))
    .limit(1);
  const provider = rows[0];
  if (provider?.providerKind !== "hetzner_cloud") return;
  const latest = await loadLatestWorkshopCostForecast(input.sessionId);
  const prices = latest?.priceObservation ?? provider.initialPriceObservation;
  if (!prices) {
    throw appError(
      409,
      "workshop_price_observation_missing",
      "the Hetzner workshop session has no price observation",
    );
  }
  await createWorkshopCostForecast({
    sessionId: input.sessionId,
    priceObservation: prices,
    trigger:
      !latest && input.trigger === "roster_changed"
        ? "session_created"
        : input.trigger,
    actorUserId: input.actorUserId,
  });
}

function workshopRequirements(manifest: WorkshopManifestV1, vmId: string) {
  const vm = manifest.workspace.vms.find((candidate) => candidate.id === vmId);
  if (!vm || manifest.workspace.vms.length !== 1) {
    throw appError(
      409,
      "workshop_revision_not_hcloud_compatible",
      "Hetzner workshops require exactly one declared learner VM",
    );
  }
  return {
    requiredCpuMillis: vm.cpuMillis,
    requiredMemoryMib: vm.memoryMib,
    requiredDiskMib: vm.diskMib,
  };
}

function assertPinnedHardwareUnchanged(
  pinned: ProviderHardwareShape,
  observed: ProviderHardwareShape,
): void {
  if (
    pinned.architecture !== observed.architecture ||
    pinned.cores !== observed.cores ||
    pinned.memoryMib !== observed.memoryMib ||
    pinned.diskMib !== observed.diskMib
  ) {
    throw appError(
      409,
      "hcloud_server_type_materially_changed",
      "the pinned Hetzner server type hardware shape materially changed",
    );
  }
}
