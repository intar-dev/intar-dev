import { env } from "cloudflare:workers";
import { and, count, desc, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ProviderOperationResult } from "@intar/provider-contracts";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerConnections,
  providerCredentialVersions,
  providerPriceLineItems,
  providerPriceObservations,
  runtimeExecutions,
  runtimeProviderAllocations,
  runtimeProviderCostLedger,
  workshopRuntimeProfiles,
  workshopSessionCostForecastLineItems,
  workshopSessionCostForecasts,
  workshopSessionCostSummaries,
  workshopSessionMembers,
  workshopSessionRuntimeSelections,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaces,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  CURRENCY_NANOS,
  calculateWorkshopCostForecast,
  decimalCurrencyToNanos,
  estimateLedgerLineItem,
  providerObservationToJson,
  type CostTaxTreatment,
  type ProviderCostLineItemInput,
  type WorkshopCostScenario,
} from "./costs";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "./provider-credential";
import { invokeProviderOperation } from "./provider-service";

export type WorkshopCostForecastTrigger =
  | "session_created"
  | "roster_changed"
  | "schedule_changed"
  | "provider_changed"
  | "price_changed"
  | "lobby_refresh"
  | "admin_refresh";

export interface StoredWorkshopCostForecast {
  id: string;
  version: number;
  sessionId: string;
  providerKind: "hetzner_cloud" | "gcp_compute";
  connectionId: string;
  currency: string;
  participantCount: number;
  trigger: string;
  expected: WorkshopCostScenario;
  leaseCeiling: WorkshopCostScenario;
  oneRestore: WorkshopCostScenario;
  exceedsBudgetCeiling: boolean;
  assumptions: string[];
  exclusions: string[];
  observedAt: number;
  expiresAt: number;
  createdAt: number;
}

export interface WorkshopLiveCostProjection {
  currency: string;
  accruedCostNanos: number;
  scheduledEndCostNanos: number;
  leaseCeilingCostNanos: number;
  forecastVarianceNanos: number;
  cleanupPendingResources: number;
  accumulatingResources: number;
  budgetCeilingNanos: number | null;
  budgetUsageNanos: number;
  overBudgetCeiling: boolean;
}

export interface DirectCloudPriceObservationContext {
  organizationId: string;
  providerKind: "hetzner_cloud" | "gcp_compute";
  connectionId: string;
  runtimeProfileId: string;
}

interface ResolvedDirectCloudPriceObservationContext
  extends DirectCloudPriceObservationContext {
  machineType: string;
  systemImage: string;
  resolvedImageId: string;
  rootDiskType: string | null;
  diskMib: number;
  locations: string[];
}

export interface StoredPriceObservation {
  id: string;
  currency: string;
  availableLocations: string[];
  lineItems: Array<ProviderCostLineItemInput & { id: string }>;
  observedAt: number;
  expiresAt: number;
}

/**
 * Return an unexpired quote for one exact connection/profile pair, creating an
 * immutable observation when none exists. Certification uses this directly so
 * it never has to synthesize a workshop session or cost forecast.
 */
export async function ensureDirectCloudPriceObservation(
  input: DirectCloudPriceObservationContext & {
    forceRefresh?: boolean;
    now?: number;
  },
): Promise<StoredPriceObservation> {
  const { forceRefresh = false, now = Date.now(), ...identity } = input;
  const context = await loadDirectCloudPriceObservationContext(identity);
  return loadOrRefreshPriceObservation({ context, forceRefresh, now });
}

export function rootDiskGibForPriceQuote(diskMib: number): number {
  if (!Number.isSafeInteger(diskMib) || diskMib <= 0) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile has an invalid disk requirement",
    );
  }
  return Math.ceil(diskMib / 1024);
}

export async function createWorkshopCostForecast(input: {
  sessionId: string;
  trigger: WorkshopCostForecastTrigger;
  actorUserId?: string | null;
  now?: number;
}): Promise<StoredWorkshopCostForecast | null> {
  const now = input.now ?? Date.now();
  const context = await loadCostContext(input.sessionId);
  if (context.providerKind === "agent_kvm") return null;
  if (!context.connectionId) {
    throw appError(
      409,
      "workshop_cost_unavailable",
      "cloud pricing is unavailable",
    );
  }
  const observation = await ensureDirectCloudPriceObservation({
    organizationId: context.organizationId,
    providerKind: context.providerKind,
    connectionId: context.connectionId,
    runtimeProfileId: context.runtimeProfileId,
    forceRefresh:
      input.trigger === "session_created" ||
      input.trigger === "price_changed" ||
      input.trigger === "lobby_refresh" ||
      input.trigger === "admin_refresh",
    now,
  });
  const participantRows = await drizzle(env.DB)
    .select({ value: count() })
    .from(workshopSessionMembers)
    .where(
      and(
        eq(workshopSessionMembers.sessionId, input.sessionId),
        eq(workshopSessionMembers.workspaceEnabled, true),
      ),
    );
  const participantCount = participantRows[0]?.value ?? 0;
  const scheduledEndsAt =
    context.scheduledStartAt + context.durationMinutes * 60_000;
  const calculation = calculateWorkshopCostForecast({
    providerKind: context.providerKind,
    participantCount,
    provisioningStartsAt: context.lobbyOpensAt,
    scheduledEndsAt,
    leaseGraceMinutes: context.leaseGraceMinutes,
    approvedLocations: context.locations,
    availableLocations: observation.availableLocations,
    currency: observation.currency,
    lineItems: observation.lineItems,
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
  });
  const budgetCeilingNanos = await loadBudgetCeiling(context);
  const exceedsBudgetCeiling =
    budgetCeilingNanos !== null &&
    calculation.leaseCeiling.totalCostNanos > budgetCeilingNanos;
  const db = drizzle(env.DB);
  const prior = await db
    .select({ version: max(workshopSessionCostForecasts.version) })
    .from(workshopSessionCostForecasts)
    .where(eq(workshopSessionCostForecasts.sessionId, input.sessionId));
  const version = (prior[0]?.version ?? 0) + 1;
  const id = createAppId();
  const forecast = {
    id,
    sessionId: input.sessionId,
    version,
    priceObservationId: observation.id,
    providerKind: context.providerKind,
    currency: calculation.currency,
    participantCount,
    trigger: input.trigger,
    expectedCostNanos: calculation.expected.totalCostNanos,
    leaseCeilingCostNanos: calculation.leaseCeiling.totalCostNanos,
    oneRestoreCostNanos: calculation.oneRestore.totalCostNanos,
    exceedsBudgetCeiling,
    assumptionsJson: calculation.assumptions,
    exclusionsJson: calculation.exclusions,
    expiresAt: calculation.expiresAt,
    createdBy: input.actorUserId ?? null,
    createdAt: now,
  } satisfies typeof workshopSessionCostForecasts.$inferInsert;
  const scenarioRows = [
    ...forecastLineRows(id, "expected", calculation.expected, observation),
    ...forecastLineRows(
      id,
      "lease_ceiling",
      calculation.leaseCeiling,
      observation,
    ),
    ...forecastLineRows(id, "one_restore", calculation.oneRestore, observation),
  ];
  try {
    await db.batch([
      db.insert(workshopSessionCostForecasts).values(forecast),
      ...scenarioRows.map((row) =>
        db.insert(workshopSessionCostForecastLineItems).values(row),
      ),
    ]);
  } catch (error) {
    if (
      errorChainMatches(
        error,
        /workshop_session_cost_forecasts_version_uidx|UNIQUE constraint failed: workshop_session_cost_forecasts\.session_id, workshop_session_cost_forecasts\.version/u,
      )
    ) {
      throw appError(
        409,
        "workshop_cost_refresh_conflict",
        "the workshop cost forecast changed; retry the refresh",
      );
    }
    throw error;
  }
  return {
    id,
    version,
    sessionId: input.sessionId,
    providerKind: context.providerKind,
    connectionId: context.connectionId!,
    currency: calculation.currency,
    participantCount,
    trigger: input.trigger,
    expected: calculation.expected,
    leaseCeiling: calculation.leaseCeiling,
    oneRestore: calculation.oneRestore,
    exceedsBudgetCeiling,
    assumptions: calculation.assumptions,
    exclusions: calculation.exclusions,
    observedAt: observation.observedAt,
    expiresAt: calculation.expiresAt,
    createdAt: now,
  };
}

export async function loadLatestWorkshopCostForecast(
  sessionId: string,
): Promise<StoredWorkshopCostForecast | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      forecast: workshopSessionCostForecasts,
      observation: providerPriceObservations,
      selection: workshopSessionRuntimeSelections,
    })
    .from(workshopSessionCostForecasts)
    .innerJoin(
      providerPriceObservations,
      eq(
        providerPriceObservations.id,
        workshopSessionCostForecasts.priceObservationId,
      ),
    )
    .innerJoin(
      workshopSessionRuntimeSelections,
      eq(
        workshopSessionRuntimeSelections.sessionId,
        workshopSessionCostForecasts.sessionId,
      ),
    )
    .where(eq(workshopSessionCostForecasts.sessionId, sessionId))
    .orderBy(desc(workshopSessionCostForecasts.version))
    .limit(1);
  const row = rows[0];
  if (!row || row.forecast.providerKind === "agent_kvm" || !row.selection.connectionId) {
    return null;
  }
  const lineRows = await db
    .select({
      scenario: workshopSessionCostForecastLineItems.scenario,
      calculation: workshopSessionCostForecastLineItems.calculationJson,
    })
    .from(workshopSessionCostForecastLineItems)
    .where(
      eq(workshopSessionCostForecastLineItems.forecastId, row.forecast.id),
    );
  const scenario = (name: "expected" | "lease_ceiling" | "one_restore") => {
    const found = lineRows.find((entry) => entry.scenario === name);
    const value = found?.calculation.scenario;
    if (!isWorkshopCostScenario(value)) {
      throw appError(
        500,
        "workshop_cost_forecast_corrupt",
        "the stored workshop cost forecast is invalid",
      );
    }
    return value;
  };
  return {
    id: row.forecast.id,
    version: row.forecast.version,
    sessionId,
    providerKind: row.forecast.providerKind,
    connectionId: row.selection.connectionId,
    currency: row.forecast.currency,
    participantCount: row.forecast.participantCount,
    trigger: row.forecast.trigger,
    expected: scenario("expected"),
    leaseCeiling: scenario("lease_ceiling"),
    oneRestore: scenario("one_restore"),
    exceedsBudgetCeiling: row.forecast.exceedsBudgetCeiling,
    assumptions: row.forecast.assumptionsJson,
    exclusions: row.forecast.exclusionsJson,
    observedAt: row.observation.observedAt,
    expiresAt: row.forecast.expiresAt,
    createdAt: row.forecast.createdAt,
  };
}

export async function getWorkshopCostProjection(input: {
  sessionId: string;
  now?: number;
}): Promise<{
  label: "estimated Hetzner cost" | "estimated GCP list cost (USD)" | null;
  latestForecast: StoredWorkshopCostForecast | null;
  live: WorkshopLiveCostProjection | null;
  final: {
    currency: string;
    costNanos: number;
    varianceNanos: number;
    generationCount: number;
    restoreCount: number;
    manualCleanupUnverified: boolean;
    finalizedAt: number;
  } | null;
}> {
  const now = input.now ?? Date.now();
  const context = await loadCostContext(input.sessionId);
  if (context.providerKind === "agent_kvm") {
    return { label: null, latestForecast: null, live: null, final: null };
  }
  const latestForecast = await loadLatestWorkshopCostForecast(input.sessionId);
  const ledger = await loadLedger(input.sessionId);
  const scheduledEndAt =
    context.scheduledStartAt + context.durationMinutes * 60_000 + 10 * 60_000;
  const leaseCeilingAt =
    context.scheduledStartAt +
    (context.durationMinutes + context.leaseGraceMinutes) * 60_000;
  const budgetCeilingNanos = await loadBudgetCeiling(context);
  const live = latestForecast
    ? projectLedger({
        rows: ledger,
        currency: latestForecast.currency,
        now,
        scheduledEndAt,
        leaseCeilingAt,
        forecast: latestForecast,
        budgetCeilingNanos,
      })
    : null;
  const finalRows = await drizzle(env.DB)
    .select()
    .from(workshopSessionCostSummaries)
    .where(eq(workshopSessionCostSummaries.sessionId, input.sessionId))
    .limit(1);
  const final = finalRows[0];
  return {
    label:
      context.providerKind === "hetzner_cloud"
        ? "estimated Hetzner cost"
        : "estimated GCP list cost (USD)",
    latestForecast,
    live,
    final:
      final?.finalizedAt != null && final.finalCostNanos != null
        ? {
            currency: final.currency,
            costNanos: final.finalCostNanos,
            varianceNanos: final.forecastVarianceNanos ?? 0,
            generationCount: final.generationCount,
            restoreCount: final.restoreCount,
            manualCleanupUnverified: final.manualCleanupUnverified,
            finalizedAt: final.finalizedAt,
          }
        : null,
  };
}

export async function finalizeWorkshopCostSummary(input: {
  sessionId: string;
  now?: number;
}): Promise<{ finalized: boolean }> {
  const now = input.now ?? Date.now();
  const context = await loadCostContext(input.sessionId);
  if (context.providerKind === "agent_kvm") return { finalized: false };
  if (context.state !== "ended" && context.state !== "cancelled") {
    return { finalized: false };
  }
  const forecast = await loadLatestWorkshopCostForecast(input.sessionId);
  if (!forecast) return { finalized: false };
  const rows = await loadLedger(input.sessionId);
  if (rows.length === 0) {
    return { finalized: false };
  }
  const cleanup = await loadCleanupVerification(context);
  const cleanupPendingCount = rows.filter(
    (row) =>
      row.deletion_confirmed_at === null ||
      row.allocation_state === "cleanup_pending",
  ).length;
  if (
    (cleanupPendingCount > 0 || cleanup.connectionCleanupPending) &&
    !cleanup.acknowledged
  ) {
    return { finalized: false };
  }
  const manualCleanupUnverified =
    cleanup.acknowledged ||
    cleanupPendingCount > 0 ||
    cleanup.connectionCleanupPending;
  const costNanos = canonicalLedgerCost(rows, now);
  const executions = new Set(rows.map((row) => row.execution_id));
  const workspaces = new Set(rows.map((row) => row.workspace_id));
  const generationCount = executions.size;
  const restoreCount = Math.max(0, generationCount - workspaces.size);
  await drizzle(env.DB)
    .insert(workshopSessionCostSummaries)
    .values({
      sessionId: input.sessionId,
      currency: forecast.currency,
      finalCostNanos: costNanos,
      forecastVarianceNanos: costNanos - forecast.expected.totalCostNanos,
      generationCount,
      restoreCount,
      cleanupPendingCount,
      manualCleanupUnverified,
      finalizedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workshopSessionCostSummaries.sessionId,
      set: {
        finalCostNanos: costNanos,
        forecastVarianceNanos: costNanos - forecast.expected.totalCostNanos,
        generationCount,
        restoreCount,
        cleanupPendingCount,
        manualCleanupUnverified,
        finalizedAt: now,
        updatedAt: now,
      },
    });
  return { finalized: true };
}

async function loadCleanupVerification(context: CostContext): Promise<{
  acknowledged: boolean;
  connectionCleanupPending: boolean;
}> {
  if (!context.connectionId || context.providerKind === "agent_kvm") {
    return { acknowledged: false, connectionCleanupPending: false };
  }
  const db = drizzle(env.DB);
  const connectionRows = await db
    .select({ state: providerConnections.state })
    .from(providerConnections)
    .where(eq(providerConnections.id, context.connectionId))
    .limit(1);
  const detailRows =
    context.providerKind === "hetzner_cloud"
      ? await db
          .select({ at: hetznerConnectionDetails.cleanupAcknowledgedAt })
          .from(hetznerConnectionDetails)
          .where(eq(hetznerConnectionDetails.connectionId, context.connectionId))
          .limit(1)
      : await db
          .select({ at: gcpConnectionDetails.cleanupAcknowledgedAt })
          .from(gcpConnectionDetails)
          .where(eq(gcpConnectionDetails.connectionId, context.connectionId))
          .limit(1);
  return {
    acknowledged: detailRows[0]?.at != null,
    connectionCleanupPending: connectionRows[0]?.state === "cleanup_pending",
  };
}

interface CostContext {
  organizationId: string;
  sessionId: string;
  state: "draft" | "lobby" | "live" | "ended" | "cancelled";
  scheduledStartAt: number;
  lobbyOpensAt: number;
  durationMinutes: number;
  leaseGraceMinutes: number;
  providerKind: "agent_kvm" | "hetzner_cloud" | "gcp_compute";
  connectionId: string | null;
  runtimeProfileId: string;
  machineType: string | null;
  systemImage: string;
  rootDiskType: string | null;
  diskMib: number;
  locations: string[];
}

async function loadCostContext(sessionId: string): Promise<CostContext> {
  const rows = await drizzle(env.DB)
    .select({
      organizationId: workshopSessions.organizationId,
      sessionId: workshopSessions.id,
      state: workshopSessions.state,
      scheduledStartAt: workshopSessions.scheduledStartAt,
      lobbyOpensAt: workshopSessions.lobbyOpensAt,
      manifest: workshopTemplateRevisions.manifestJson,
      selection: workshopSessionRuntimeSelections,
      profile: workshopRuntimeProfiles,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopTemplateRevisions.id, workshopSessions.templateRevisionId),
    )
    .innerJoin(
      workshopSessionRuntimeSelections,
      eq(workshopSessionRuntimeSelections.sessionId, workshopSessions.id),
    )
    .innerJoin(
      workshopRuntimeProfiles,
      eq(
        workshopRuntimeProfiles.id,
        workshopSessionRuntimeSelections.runtimeProfileId,
      ),
    )
    .where(eq(workshopSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) throw appError(404, "workshop_session_not_found", "workshop session not found");
  return {
    organizationId: row.organizationId,
    sessionId: row.sessionId,
    state: row.state,
    scheduledStartAt: row.scheduledStartAt,
    lobbyOpensAt: row.lobbyOpensAt,
    durationMinutes: row.manifest.durationMinutes,
    leaseGraceMinutes: row.manifest.workspace.leaseGraceMinutes,
    providerKind: row.selection.providerKind,
    connectionId: row.selection.connectionId,
    runtimeProfileId: row.profile.id,
    machineType: row.profile.machineType,
    systemImage: row.profile.systemImage,
    rootDiskType: row.profile.rootDiskType,
    diskMib: row.profile.diskMib,
    locations: row.profile.locationsJson,
  };
}

async function loadDirectCloudPriceObservationContext(
  identity: DirectCloudPriceObservationContext,
): Promise<ResolvedDirectCloudPriceObservationContext> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({ profile: workshopRuntimeProfiles })
    .from(workshopRuntimeProfiles)
    .innerJoin(
      workshopTemplateRevisions,
      eq(
        workshopTemplateRevisions.id,
        workshopRuntimeProfiles.templateRevisionId,
      ),
    )
    .innerJoin(
      workshopTemplates,
      and(
        eq(workshopTemplates.id, workshopTemplateRevisions.templateId),
        eq(workshopTemplates.organizationId, identity.organizationId),
      ),
    )
    .innerJoin(
      providerConnections,
      and(
        eq(providerConnections.id, identity.connectionId),
        eq(providerConnections.organizationId, identity.organizationId),
        eq(providerConnections.providerKind, identity.providerKind),
      ),
    )
    .where(
      and(
        eq(workshopRuntimeProfiles.id, identity.runtimeProfileId),
        eq(workshopRuntimeProfiles.providerKind, identity.providerKind),
      ),
    )
    .limit(1);
  const profile = rows[0]?.profile;
  if (
    !profile?.machineType ||
    !profile.resolvedImageId ||
    profile.architecture !== "x86_64" ||
    (identity.providerKind === "gcp_compute" && !profile.rootDiskType)
  ) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile is incomplete",
    );
  }
  const approvedLocations =
    identity.providerKind === "hetzner_cloud"
      ? (
          await db
            .select({ values: hetznerConnectionDetails.approvedLocationsJson })
            .from(hetznerConnectionDetails)
            .where(
              eq(hetznerConnectionDetails.connectionId, identity.connectionId),
            )
            .limit(1)
        )[0]?.values
      : (
          await db
            .select({ values: gcpConnectionDetails.approvedZonesJson })
            .from(gcpConnectionDetails)
            .where(
              eq(gcpConnectionDetails.connectionId, identity.connectionId),
            )
            .limit(1)
        )[0]?.values;
  const approved = new Set(approvedLocations ?? []);
  const locations = profile.locationsJson.filter((location) =>
    approved.has(location),
  );
  if (locations.length === 0) {
    throw appError(
      409,
      "provider_location_unavailable",
      "the runtime profile has no location approved by its provider connection",
    );
  }
  return {
    ...identity,
    machineType: profile.machineType,
    systemImage: profile.systemImage,
    resolvedImageId: profile.resolvedImageId,
    rootDiskType: profile.rootDiskType,
    diskMib: profile.diskMib,
    locations,
  };
}

async function loadOrRefreshPriceObservation(input: {
  context: ResolvedDirectCloudPriceObservationContext;
  forceRefresh: boolean;
  now: number;
}): Promise<StoredPriceObservation> {
  if (!input.forceRefresh) {
    const existing = await loadLatestPriceObservation(input.context, input.now);
    if (existing) return existing;
  }
  return refreshPriceObservation(input.context, input.now);
}

async function loadLatestPriceObservation(
  context: ResolvedDirectCloudPriceObservationContext,
  now: number,
): Promise<StoredPriceObservation | null> {
  const db = drizzle(env.DB);
  const rows = await db
    .select()
    .from(providerPriceObservations)
    .where(
      and(
        eq(providerPriceObservations.runtimeProfileId, context.runtimeProfileId),
        eq(providerPriceObservations.providerKind, context.providerKind),
        eq(providerPriceObservations.connectionId, context.connectionId),
      ),
    )
    .orderBy(desc(providerPriceObservations.observedAt))
    .limit(1);
  const observation = rows[0];
  if (!observation || observation.expiresAt <= now) return null;
  const hydrated = await hydrateObservation(observation);
  const pricedLocations = new Set(
    hydrated.lineItems.map((line) => line.location),
  );
  const expectedLocations = new Set(context.locations);
  if (
    pricedLocations.size !== expectedLocations.size ||
    context.locations.some((location) => !pricedLocations.has(location))
  ) {
    return null;
  }
  return hydrated;
}

async function refreshPriceObservation(
  context: ResolvedDirectCloudPriceObservationContext,
  now: number,
): Promise<StoredPriceObservation> {
  const db = drizzle(env.DB);
  const connectionRows = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, context.connectionId),
        eq(providerConnections.organizationId, context.organizationId),
        eq(providerConnections.providerKind, context.providerKind),
      ),
    )
    .limit(1);
  const connection = connectionRows[0];
  if (!connection?.activeCredentialVersionId || connection.state !== "active") {
    throw appError(409, "provider_connection_inactive", "provider connection is inactive");
  }
  const credentialRows = await db
    .select()
    .from(providerCredentialVersions)
    .where(eq(providerCredentialVersions.id, connection.activeCredentialVersionId))
    .limit(1);
  const credential = credentialRows[0];
  if (!credential) throw appError(409, "provider_credential_missing", "provider credential is missing");
  const credentialContext = providerCredentialContext({
    organizationId: context.organizationId,
    connection,
    credential,
  });
  const request = {
    requestId: createAppId(),
    connectionId: connection.id,
    credentialContext,
    credential: providerCredentialEnvelope(credential),
    ...(context.providerKind === "gcp_compute"
      ? { projectId: connection.externalProjectId }
      : {}),
    operation:
      context.providerKind === "hetzner_cloud"
        ? {
            kind: "catalog",
            requiredServerTypes: [context.machineType],
            permittedLocations: context.locations,
            systemImage: context.systemImage,
          }
        : {
            kind: "quote",
            machineType: context.machineType,
            zones: context.locations,
            rootDiskType: context.rootDiskType,
            rootDiskGib: rootDiskGibForPriceQuote(context.diskMib),
          },
  };
  const result = await invokeProviderOperation(
    context.providerKind,
    (binding) => binding.runOperation(request),
  );
  const quote =
    context.providerKind === "hetzner_cloud"
      ? normalizeHetznerQuote(context, result, now)
      : normalizeGcpQuote(context, result, now);
  const observationId = createAppId();
  const observation = {
    id: observationId,
    providerKind: context.providerKind,
    connectionId: context.connectionId,
    runtimeProfileId: context.runtimeProfileId,
    currency: quote.currency,
    source: quote.source,
    rawObservationJson: providerObservationToJson(quote.raw) as Record<string, unknown>,
    observedAt: quote.observedAt,
    expiresAt: quote.expiresAt,
    createdAt: now,
  } satisfies typeof providerPriceObservations.$inferInsert;
  const lines = quote.lines.map((line) => ({
    id: createAppId(),
    observationId,
    sku: line.sku,
    resourceKind: line.resourceKind,
    location: line.location,
    rawPrice: line.rawPrice,
    priceNanos: line.priceNanos,
    unit: line.unit,
    quantityNanos: line.quantityNanos,
    billingIncrementSeconds: line.billingIncrementSeconds,
    minimumDurationSeconds: line.minimumDurationSeconds,
    capPriceNanos: line.capPriceNanos,
    taxTreatment: line.taxTreatment,
    metadataJson: {},
  } satisfies typeof providerPriceLineItems.$inferInsert));
  await db.batch([
    db.insert(providerPriceObservations).values(observation),
    ...lines.map((line) => db.insert(providerPriceLineItems).values(line)),
  ]);
  return {
    id: observationId,
    currency: quote.currency,
    availableLocations: quote.availableLocations,
    lineItems: lines.map((line) => ({
      ...line,
      currency: quote.currency,
      capPriceNanos: line.capPriceNanos ?? null,
      unit: line.unit as ProviderCostLineItemInput["unit"],
      taxTreatment: line.taxTreatment as CostTaxTreatment,
    })),
    observedAt: quote.observedAt,
    expiresAt: quote.expiresAt,
  };
}

async function hydrateObservation(
  observation: typeof providerPriceObservations.$inferSelect,
): Promise<StoredPriceObservation> {
  const lines = await drizzle(env.DB)
    .select()
    .from(providerPriceLineItems)
    .where(eq(providerPriceLineItems.observationId, observation.id));
  const available = record(observation.rawObservationJson)?.availableLocations;
  return {
    id: observation.id,
    currency: observation.currency,
    availableLocations: Array.isArray(available)
      ? available.filter((entry): entry is string => typeof entry === "string")
      : [...new Set(lines.map((line) => line.location))],
    lineItems: lines.map((line) => ({
      id: line.id,
      sku: line.sku,
      resourceKind: line.resourceKind,
      location: line.location,
      currency: observation.currency,
      rawPrice: line.rawPrice,
      priceNanos: line.priceNanos,
      unit: line.unit as ProviderCostLineItemInput["unit"],
      quantityNanos: line.quantityNanos,
      billingIncrementSeconds: line.billingIncrementSeconds,
      minimumDurationSeconds: line.minimumDurationSeconds,
      capPriceNanos: line.capPriceNanos,
      taxTreatment: line.taxTreatment as CostTaxTreatment,
    })),
    observedAt: observation.observedAt,
    expiresAt: observation.expiresAt,
  };
}

interface NormalizedQuote {
  currency: string;
  source: string;
  raw: Record<string, unknown>;
  availableLocations: string[];
  lines: ProviderCostLineItemInput[];
  observedAt: number;
  expiresAt: number;
}

function normalizeHetznerQuote(
  context: ResolvedDirectCloudPriceObservationContext,
  result: ProviderOperationResult,
  now: number,
): NormalizedQuote {
  const data = requiredRecord(result.data, "Hetzner catalog");
  const pricing = requiredRecord(data.pricing, "Hetzner pricing");
  const currency = requiredString(pricing.currency, "Hetzner currency").toUpperCase();
  const serverTypes = array(data.serverTypes).map(record).filter(nonNull);
  const serverType = serverTypes.find((entry) => entry.name === context.machineType);
  const availability = array(serverType?.locations)
    .map(record)
    .filter(nonNull)
    .filter((entry) => entry.available === true && entry.deprecation == null)
    .map((entry) => requiredString(entry.name, "Hetzner location"));
  const serverPricing = array(pricing.server_types)
    .map(record)
    .filter(nonNull)
    .find((entry) => entry.name === context.machineType);
  const ipv4Pricing = array(pricing.primary_ips)
    .map(record)
    .filter(nonNull)
    .find((entry) => entry.type === "ipv4");
  if (!serverPricing || !ipv4Pricing) throw invalidQuote();
  const lines: ProviderCostLineItemInput[] = [];
  for (const location of context.locations) {
    const server = priceForLocation(serverPricing, location);
    const ipv4 = priceForLocation(ipv4Pricing, location);
    for (const [resourceKind, sku, price] of [
      ["instance", `server:${context.machineType}`, server],
      ["ipv4", "primary-ipv4", ipv4],
    ] as const) {
      const hourly = requiredRecord(price.price_hourly, "Hetzner hourly price");
      const monthly = record(price.price_monthly);
      lines.push(
        hetznerLine(resourceKind, sku, location, currency, "provider_net", hourly.net, monthly?.net),
        hetznerLine(resourceKind, sku, location, currency, "provider_gross", hourly.gross, monthly?.gross),
      );
    }
  }
  const observedAt = parseTimestamp(data.observedAt, now);
  return {
    currency,
    source: "hetzner-cloud-pricing-api",
    raw: { ...data, availableLocations: availability },
    availableLocations: availability,
    lines,
    observedAt,
    expiresAt: observedAt + 24 * 60 * 60 * 1_000,
  };
}

function hetznerLine(
  resourceKind: string,
  sku: string,
  location: string,
  currency: string,
  taxTreatment: "provider_net" | "provider_gross",
  rawHourly: unknown,
  rawMonthly: unknown,
): ProviderCostLineItemInput {
  const rawPrice = requiredString(rawHourly, "Hetzner hourly price");
  return {
    sku,
    resourceKind,
    location,
    currency,
    rawPrice,
    priceNanos: decimalCurrencyToNanos(rawPrice),
    unit: "hour",
    quantityNanos: CURRENCY_NANOS,
    billingIncrementSeconds: 3_600,
    minimumDurationSeconds: 3_600,
    capPriceNanos:
      typeof rawMonthly === "string"
        ? decimalCurrencyToNanos(rawMonthly)
        : null,
    taxTreatment,
  };
}

function normalizeGcpQuote(
  context: ResolvedDirectCloudPriceObservationContext,
  result: ProviderOperationResult,
  now: number,
): NormalizedQuote {
  const sourceLines = array(result.data).map((value) =>
    requiredRecord(value, "GCP price line"),
  );
  if (sourceLines.length === 0) throw invalidQuote();
  const firstObservedAt = parseTimestamp(sourceLines[0]?.observedAt, now);
  const lines: ProviderCostLineItemInput[] = [];
  for (const location of context.locations) {
    for (const source of sourceLines) {
      const unit = requiredString(source.unit, "GCP price unit");
      if (!isCostUnit(unit)) throw invalidQuote();
      const taxTreatment = requiredString(
        source.taxTreatment,
        "GCP tax treatment",
      );
      if (taxTreatment !== "tax_excluded_public_list") throw invalidQuote();
      const quantity = requiredNumber(source.quantity, "GCP quantity");
      lines.push({
        sku: requiredString(source.sku, "GCP SKU"),
        resourceKind: requiredString(source.resourceKind, "GCP resource kind"),
        location,
        currency: "USD",
        rawPrice: requiredString(source.rawUnitPrice, "GCP raw price"),
        priceNanos: bigintNumber(source.unitPriceNanos),
        unit,
        quantityNanos: safeProduct(quantity, CURRENCY_NANOS),
        billingIncrementSeconds: requiredNumber(
          source.billingGranularitySeconds,
          "GCP billing granularity",
        ),
        minimumDurationSeconds: requiredNumber(
          source.minimumDurationSeconds,
          "GCP minimum duration",
        ),
        capPriceNanos:
          source.capNanos == null ? null : bigintNumber(source.capNanos),
        taxTreatment,
      });
    }
  }
  return {
    currency: "USD",
    source: "gcp-cloud-billing-catalog-public-list",
    raw: { lines: sourceLines, availableLocations: context.locations },
    availableLocations: context.locations,
    lines,
    observedAt: firstObservedAt,
    expiresAt: firstObservedAt + 24 * 60 * 60 * 1_000,
  };
}

function forecastLineRows(
  forecastId: string,
  name: "expected" | "lease_ceiling" | "one_restore",
  scenario: WorkshopCostScenario,
  observation: StoredPriceObservation,
) {
  return scenario.lineItems.map((calculation, index) => {
    const price = observation.lineItems.find(
      (line) =>
        line.location === scenario.location &&
        line.sku === calculation.sku &&
        line.taxTreatment === calculation.taxTreatment,
    );
    if (!price) throw invalidQuote();
    return {
      id: createAppId(),
      forecastId,
      priceLineItemId: price.id,
      scenario: name,
      participantCount: scenario.participantCount,
      generationCount: scenario.generationLifetimeSeconds.length,
      lifetimeSeconds: scenario.generationLifetimeSeconds.reduce(
        (sum, seconds) => sum + seconds,
        0,
      ),
      billedQuantityNanos: safeProduct(
        calculation.billedQuantityNanos,
        scenario.participantCount,
      ),
      calculatedCostNanos: safeProduct(
        calculation.totalCostNanos,
        scenario.participantCount,
      ),
      calculationJson: {
        lineIndex: index,
        calculation,
        scenario,
      },
    } satisfies typeof workshopSessionCostForecastLineItems.$inferInsert;
  });
}

async function loadBudgetCeiling(context: CostContext): Promise<number | null> {
  if (!context.connectionId || context.providerKind === "agent_kvm") return null;
  const db = drizzle(env.DB);
  if (context.providerKind === "hetzner_cloud") {
    const rows = await db
      .select({ value: hetznerConnectionDetails.maxSessionCostNanos })
      .from(hetznerConnectionDetails)
      .where(eq(hetznerConnectionDetails.connectionId, context.connectionId))
      .limit(1);
    return rows[0]?.value ?? null;
  }
  const rows = await db
    .select({ value: gcpConnectionDetails.maxSessionCostNanos })
    .from(gcpConnectionDetails)
    .where(eq(gcpConnectionDetails.connectionId, context.connectionId))
    .limit(1);
  return rows[0]?.value ?? null;
}

interface LedgerRow {
  id: string;
  execution_id: string;
  provider_resource_id: string;
  currency: string;
  raw_price: string;
  price_nanos: number;
  unit: ProviderCostLineItemInput["unit"];
  quantity_nanos: number;
  billing_increment_seconds: number;
  minimum_duration_seconds: number;
  cap_price_nanos: number | null;
  tax_treatment: CostTaxTreatment;
  provider_created_at: number;
  deletion_confirmed_at: number | null;
  allocation_state: string;
  workspace_id: string;
  sku: string;
  resource_kind: string;
  location: string;
}

async function loadLedger(sessionId: string): Promise<LedgerRow[]> {
  const rows = await drizzle(env.DB)
    .select({
      id: runtimeProviderCostLedger.id,
      executionId: runtimeProviderCostLedger.executionId,
      providerResourceId: runtimeProviderCostLedger.providerResourceId,
      currency: runtimeProviderCostLedger.currency,
      rawPrice: runtimeProviderCostLedger.rawPrice,
      priceNanos: runtimeProviderCostLedger.priceNanos,
      unit: runtimeProviderCostLedger.unit,
      quantityNanos: runtimeProviderCostLedger.quantityNanos,
      billingIncrementSeconds:
        runtimeProviderCostLedger.billingIncrementSeconds,
      minimumDurationSeconds:
        runtimeProviderCostLedger.minimumDurationSeconds,
      capPriceNanos: runtimeProviderCostLedger.capPriceNanos,
      taxTreatment: runtimeProviderCostLedger.taxTreatment,
      providerCreatedAt: runtimeProviderCostLedger.providerCreatedAt,
      deletionConfirmedAt: runtimeProviderCostLedger.deletionConfirmedAt,
      allocationState: runtimeProviderAllocations.state,
      workspaceId: runtimeExecutions.domainId,
      sku: runtimeProviderCostLedger.sku,
      resourceKind: runtimeProviderCostLedger.resourceKind,
      location: runtimeProviderCostLedger.location,
    })
    .from(runtimeProviderCostLedger)
    .innerJoin(
      runtimeProviderAllocations,
      eq(runtimeProviderAllocations.id, runtimeProviderCostLedger.allocationId),
    )
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeProviderCostLedger.executionId),
    )
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, runtimeExecutions.domainId),
    )
    .where(
      and(
        eq(runtimeExecutions.domainKind, "workshop"),
        eq(workshopWorkspaces.sessionId, sessionId),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    execution_id: row.executionId,
    provider_resource_id: row.providerResourceId,
    currency: row.currency,
    raw_price: row.rawPrice,
    price_nanos: row.priceNanos,
    unit: row.unit as ProviderCostLineItemInput["unit"],
    quantity_nanos: row.quantityNanos,
    billing_increment_seconds: row.billingIncrementSeconds,
    minimum_duration_seconds: row.minimumDurationSeconds,
    cap_price_nanos: row.capPriceNanos,
    tax_treatment: row.taxTreatment as CostTaxTreatment,
    provider_created_at: row.providerCreatedAt,
    deletion_confirmed_at: row.deletionConfirmedAt,
    allocation_state: row.allocationState,
    workspace_id: row.workspaceId,
    sku: row.sku,
    resource_kind: row.resourceKind,
    location: row.location,
  }));
}

function projectLedger(input: {
  rows: LedgerRow[];
  currency: string;
  now: number;
  scheduledEndAt: number;
  leaseCeilingAt: number;
  forecast: StoredWorkshopCostForecast;
  budgetCeilingNanos: number | null;
}): WorkshopLiveCostProjection {
  for (const row of input.rows) {
    if (row.currency !== input.currency) {
      throw appError(409, "provider_ledger_currency_mismatch", "provider ledger contains mixed currencies");
    }
  }
  const accruedCostNanos = canonicalLedgerCost(input.rows, input.now);
  const scheduledEndCostNanos = canonicalLedgerCost(
    input.rows,
    Math.max(input.now, input.scheduledEndAt),
  );
  const leaseCeilingCostNanos = canonicalLedgerCost(
    input.rows,
    Math.max(input.now, input.leaseCeilingAt),
  );
  const budgetUsageNanos = Math.max(
    accruedCostNanos,
    scheduledEndCostNanos,
    leaseCeilingCostNanos,
    input.forecast.leaseCeiling.totalCostNanos,
  );
  return {
    currency: input.currency,
    accruedCostNanos,
    scheduledEndCostNanos,
    leaseCeilingCostNanos,
    forecastVarianceNanos:
      scheduledEndCostNanos - input.forecast.expected.totalCostNanos,
    cleanupPendingResources: input.rows.filter(
      (row) => row.deletion_confirmed_at === null && row.allocation_state === "cleanup_pending",
    ).length,
    accumulatingResources: input.rows.filter(
      (row) => row.deletion_confirmed_at === null,
    ).length,
    budgetCeilingNanos: input.budgetCeilingNanos,
    budgetUsageNanos,
    overBudgetCeiling:
      input.budgetCeilingNanos !== null &&
      budgetUsageNanos > input.budgetCeilingNanos,
  };
}

function canonicalLedgerCost(rows: LedgerRow[], targetAt: number): number {
  const resources = new Map<string, Map<CostTaxTreatment, number>>();
  for (const row of rows) {
    const estimate = estimateLedgerLineItem({
      lineItem: ledgerLine(row),
      createdAt: row.provider_created_at,
      deletionConfirmedAt: row.deletion_confirmed_at,
      now: targetAt,
    });
    const treatments = resources.get(row.provider_resource_id) ?? new Map();
    treatments.set(
      row.tax_treatment,
      safeSum(treatments.get(row.tax_treatment) ?? 0, estimate.costNanos),
    );
    resources.set(row.provider_resource_id, treatments);
  }
  let total = 0;
  for (const treatments of resources.values()) {
    total = safeSum(
      total,
      treatments.get("provider_gross") ??
        treatments.get("tax_excluded_public_list") ??
        treatments.get("provider_net") ??
        0,
    );
  }
  return total;
}

function ledgerLine(row: LedgerRow): ProviderCostLineItemInput {
  return {
    sku: row.sku,
    resourceKind: row.resource_kind,
    location: row.location,
    currency: row.currency,
    rawPrice: row.raw_price,
    priceNanos: row.price_nanos,
    unit: row.unit,
    quantityNanos: row.quantity_nanos,
    billingIncrementSeconds: row.billing_increment_seconds,
    minimumDurationSeconds: row.minimum_duration_seconds,
    capPriceNanos: row.cap_price_nanos,
    taxTreatment: row.tax_treatment,
  };
}

function priceForLocation(value: Record<string, unknown>, location: string) {
  const price = array(value.prices)
    .map(record)
    .filter(nonNull)
    .find((entry) => entry.location === location);
  if (!price) throw invalidQuote();
  return price;
}

function isWorkshopCostScenario(value: unknown): value is WorkshopCostScenario {
  const object = record(value);
  return Boolean(
    object &&
      typeof object.location === "string" &&
      typeof object.totalCostNanos === "number" &&
      Array.isArray(object.lineItems),
  );
}

function isCostUnit(value: string): value is ProviderCostLineItemInput["unit"] {
  return ["second", "hour", "gib_second", "gib_hour", "gib_month"].includes(value);
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function bigintNumber(value: unknown): number {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidQuote();
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = BigInt(value);
    if (parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed);
  }
  throw invalidQuote();
}

function safeProduct(left: number, right: number): number {
  const value = BigInt(left) * BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidQuote();
  return Number(value);
}

function safeSum(left: number, right: number): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(409, "provider_cost_too_large", "provider cost is too large");
  }
  return Number(value);
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  const result = record(value);
  if (!result) throw appError(502, "provider_quote_invalid", `${label} is invalid`);
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonNull<T>(value: T | null): value is T {
  return value !== null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw appError(502, "provider_quote_invalid", `${label} is invalid`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw appError(502, "provider_quote_invalid", `${label} is invalid`);
  }
  return value;
}

function invalidQuote() {
  return appError(502, "provider_quote_invalid", "provider returned an invalid quote");
}
