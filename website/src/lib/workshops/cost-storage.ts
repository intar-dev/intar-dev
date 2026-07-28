import { env } from "cloudflare:workers";
import { and, count, desc, eq, max, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  organizationProviderConnections,
  workshopSessionCostForecasts,
  workshopSessionCostSummaries,
  workshopSessionMembers,
  workshopSessionRuntimeProviders,
  workshopSessions,
  workshopTemplateRevisions,
  type ProviderPriceObservation,
  type WorkshopCostScenarioJson,
} from "@/db/schema";
import { appError, errorChainMatches } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { calculateWorkshopCostForecast, estimateLedgerResource } from "./costs";

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
  connectionId: string;
  currency: string;
  participantCount: number;
  preferredLocation: string;
  trigger: string;
  priceObservation: ProviderPriceObservation;
  expected: WorkshopCostScenarioJson;
  leaseCeiling: WorkshopCostScenarioJson;
  oneRestore: WorkshopCostScenarioJson;
  exceedsGrossCeiling: boolean;
  assumptions: string[];
  exclusions: string[];
  expiresAt: number;
  createdAt: number;
}

export interface WorkshopLiveCostProjection {
  currency: string;
  accruedNetMicros: number;
  accruedGrossMicros: number;
  scheduledEndNetMicros: number;
  scheduledEndGrossMicros: number;
  leaseCeilingNetMicros: number;
  leaseCeilingGrossMicros: number;
  forecastNetVarianceMicros: number;
  forecastGrossVarianceMicros: number;
  cleanupPendingResources: number;
  accumulatingResources: number;
  grossCeilingMicros: number | null;
  grossCeilingUsageMicros: number;
  overGrossCeiling: boolean;
}

export async function createWorkshopCostForecast(input: {
  sessionId: string;
  priceObservation: ProviderPriceObservation;
  trigger: WorkshopCostForecastTrigger;
  actorUserId?: string | null;
  now?: number;
}): Promise<StoredWorkshopCostForecast> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      sessionId: workshopSessions.id,
      scheduledStartAt: workshopSessions.scheduledStartAt,
      lobbyOpensAt: workshopSessions.lobbyOpensAt,
      manifest: workshopTemplateRevisions.manifestJson,
      providerKind: workshopSessionRuntimeProviders.providerKind,
      connectionId: workshopSessionRuntimeProviders.connectionId,
      serverType: workshopSessionRuntimeProviders.serverType,
      permittedLocations:
        workshopSessionRuntimeProviders.permittedLocationsJson,
      maxSessionGrossMicros:
        organizationProviderConnections.maxSessionGrossMicros,
      connectionCurrency: organizationProviderConnections.currency,
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
  if (
    row.providerKind !== "hetzner_cloud" ||
    !row.connectionId ||
    !row.serverType
  ) {
    throw appError(
      409,
      "workshop_cost_unavailable",
      "cost forecasts are available only for Hetzner workshop sessions",
    );
  }
  if (
    input.priceObservation.serverType !== row.serverType ||
    input.priceObservation.currency.toUpperCase() !==
      row.connectionCurrency?.toUpperCase()
  ) {
    throw appError(
      409,
      "workshop_price_identity_changed",
      "provider price observation does not match the session-pinned type and currency",
    );
  }
  const participantRows = await db
    .select({ value: count() })
    .from(workshopSessionMembers)
    .where(
      and(
        eq(workshopSessionMembers.sessionId, input.sessionId),
        eq(workshopSessionMembers.role, "participant"),
      ),
    );
  const participantCount = participantRows[0]?.value ?? 0;
  const scheduledEndsAt =
    row.scheduledStartAt + row.manifest.durationMinutes * 60_000;
  const calculation = calculateWorkshopCostForecast({
    participantCount,
    provisioningStartsAt: row.lobbyOpensAt,
    scheduledEndsAt,
    leaseGraceMinutes: row.manifest.workspace.leaseGraceMinutes,
    approvedLocations: row.permittedLocations,
    prices: input.priceObservation,
  });
  const exceedsGrossCeiling =
    row.maxSessionGrossMicros !== null &&
    calculation.leaseCeiling.totalGrossMicros > row.maxSessionGrossMicros;
  const id = createAppId();
  const prior = await db
    .select({ version: max(workshopSessionCostForecasts.version) })
    .from(workshopSessionCostForecasts)
    .where(eq(workshopSessionCostForecasts.sessionId, input.sessionId));
  const version = (prior[0]?.version ?? 0) + 1;
  try {
    await db.insert(workshopSessionCostForecasts).values({
      id,
      sessionId: input.sessionId,
      version,
      connectionId: row.connectionId,
      currency: calculation.currency,
      participantCount,
      preferredLocation: calculation.preferredLocation,
      trigger: input.trigger,
      priceObservationJson: input.priceObservation,
      expectedJson: calculation.expected,
      leaseCeilingJson: calculation.leaseCeiling,
      oneRestoreJson: calculation.oneRestore,
      expectedNetMicros: calculation.expected.totalNetMicros,
      expectedGrossMicros: calculation.expected.totalGrossMicros,
      leaseCeilingNetMicros: calculation.leaseCeiling.totalNetMicros,
      leaseCeilingGrossMicros: calculation.leaseCeiling.totalGrossMicros,
      oneRestoreNetMicros: calculation.oneRestore.totalNetMicros,
      oneRestoreGrossMicros: calculation.oneRestore.totalGrossMicros,
      exceedsGrossCeiling,
      assumptionsJson: calculation.assumptions,
      exclusionsJson: calculation.exclusions,
      expiresAt: calculation.expiresAt,
      createdBy: input.actorUserId ?? null,
      createdAt: now,
    });
  } catch (error) {
    if (
      errorChainMatches(
        error,
        /workshop_session_cost_forecasts_version_uidx|UNIQUE constraint failed: workshop_session_cost_forecasts\.session_id, workshop_session_cost_forecasts\.version/,
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
    connectionId: row.connectionId,
    currency: calculation.currency,
    participantCount,
    preferredLocation: calculation.preferredLocation,
    trigger: input.trigger,
    priceObservation: input.priceObservation,
    expected: calculation.expected,
    leaseCeiling: calculation.leaseCeiling,
    oneRestore: calculation.oneRestore,
    exceedsGrossCeiling,
    assumptions: calculation.assumptions,
    exclusions: calculation.exclusions,
    expiresAt: calculation.expiresAt,
    createdAt: now,
  };
}

export async function loadLatestWorkshopCostForecast(
  sessionId: string,
): Promise<StoredWorkshopCostForecast | null> {
  const rows = await drizzle(env.DB)
    .select()
    .from(workshopSessionCostForecasts)
    .where(eq(workshopSessionCostForecasts.sessionId, sessionId))
    .orderBy(desc(workshopSessionCostForecasts.version))
    .limit(1);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        version: row.version,
        sessionId: row.sessionId,
        connectionId: row.connectionId,
        currency: row.currency,
        participantCount: row.participantCount,
        preferredLocation: row.preferredLocation,
        trigger: row.trigger,
        priceObservation: row.priceObservationJson,
        expected: row.expectedJson,
        leaseCeiling: row.leaseCeilingJson,
        oneRestore: row.oneRestoreJson,
        exceedsGrossCeiling: row.exceedsGrossCeiling,
        assumptions: row.assumptionsJson,
        exclusions: row.exclusionsJson,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      }
    : null;
}

export async function getWorkshopCostProjection(input: {
  sessionId: string;
  now?: number;
}): Promise<{
  label: "estimated Hetzner cost";
  latestForecast: StoredWorkshopCostForecast | null;
  live: WorkshopLiveCostProjection | null;
  final: {
    currency: string;
    netMicros: number;
    grossMicros: number;
    netVarianceMicros: number;
    grossVarianceMicros: number;
    generationCount: number;
    restoreCount: number;
    manualCleanupUnverified: boolean;
    finalizedAt: number;
  } | null;
}> {
  const now = input.now ?? Date.now();
  const db = drizzle(env.DB);
  const latestForecast = await loadLatestWorkshopCostForecast(input.sessionId);
  const sessionRows = await db
    .select({
      scheduledStartAt: workshopSessions.scheduledStartAt,
      durationMinutes: sql<number>`json_extract(${workshopTemplateRevisions.manifestJson}, '$.durationMinutes')`,
      graceMinutes: sql<number>`json_extract(${workshopTemplateRevisions.manifestJson}, '$.workspace.leaseGraceMinutes')`,
      grossCeilingMicros: organizationProviderConnections.maxSessionGrossMicros,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopTemplateRevisions,
      eq(workshopTemplateRevisions.id, workshopSessions.templateRevisionId),
    )
    .leftJoin(
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
  const session = sessionRows[0];
  if (!session) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  const ledger = await env.DB.prepare(
    `SELECT ledger.*, allocation.state AS allocation_state,
            execution.domain_id AS workspace_id
     FROM runtime_provider_cost_ledger ledger
     INNER JOIN hetzner_allocations allocation
       ON allocation.id = ledger.allocation_id
     INNER JOIN runtime_executions execution ON execution.id = ledger.execution_id
     INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id
     WHERE execution.domain_kind = 'workshop' AND workspace.session_id = ?
     ORDER BY ledger.provider_created_at ASC, ledger.id ASC`,
  )
    .bind(input.sessionId)
    .all<LedgerRow>();
  const scheduledEndAt =
    session.scheduledStartAt + session.durationMinutes * 60_000 + 10 * 60_000;
  const leaseCeilingAt =
    session.scheduledStartAt +
    (session.durationMinutes + session.graceMinutes) * 60_000;
  const live = latestForecast
    ? projectLedger({
        rows: ledger.results,
        currency: latestForecast.currency,
        now,
        scheduledEndAt,
        leaseCeilingAt,
        forecast: latestForecast,
        grossCeilingMicros: session.grossCeilingMicros,
      })
    : null;
  const finalRows = await db
    .select()
    .from(workshopSessionCostSummaries)
    .where(eq(workshopSessionCostSummaries.sessionId, input.sessionId))
    .limit(1);
  const final = finalRows[0];
  return {
    label: "estimated Hetzner cost",
    latestForecast,
    live,
    final:
      final !== undefined &&
      final.finalizedAt !== null &&
      final.finalNetMicros !== null &&
      final.finalGrossMicros !== null
        ? {
            currency: final.currency,
            netMicros: final.finalNetMicros,
            grossMicros: final.finalGrossMicros,
            netVarianceMicros: final.forecastNetVarianceMicros ?? 0,
            grossVarianceMicros: final.forecastGrossVarianceMicros ?? 0,
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
  const session = await drizzle(env.DB)
    .select({ state: workshopSessions.state })
    .from(workshopSessions)
    .where(eq(workshopSessions.id, input.sessionId))
    .limit(1);
  if (!session[0]) {
    throw appError(
      404,
      "workshop_session_not_found",
      "workshop session not found",
    );
  }
  // A restore deliberately has a short interval with no billable resources.
  // Do not turn that interval into a stale "final" estimate for a live
  // session; only a terminal session can own a final cost summary.
  if (session[0].state !== "ended" && session[0].state !== "cancelled") {
    return { finalized: false };
  }
  const projection = await getWorkshopCostProjection({
    sessionId: input.sessionId,
    now,
  });
  const forecast = projection.latestForecast;
  if (!forecast) return { finalized: false };
  const ledger = await env.DB.prepare(
    `SELECT ledger.*, allocation.state AS allocation_state,
            execution.domain_id AS workspace_id
     FROM runtime_provider_cost_ledger ledger
     INNER JOIN hetzner_allocations allocation
       ON allocation.id = ledger.allocation_id
     INNER JOIN runtime_executions execution ON execution.id = ledger.execution_id
     INNER JOIN workshop_workspaces workspace ON workspace.id = execution.domain_id
     WHERE execution.domain_kind = 'workshop' AND workspace.session_id = ?`,
  )
    .bind(input.sessionId)
    .all<LedgerRow>();
  if (
    ledger.results.some((row) => row.deletion_confirmed_at === null) ||
    ledger.results.length === 0
  ) {
    return { finalized: false };
  }
  let net = 0;
  let gross = 0;
  const executions = new Set<string>();
  const workspaces = new Set<string>();
  for (const row of ledger.results) {
    const estimate = ledgerEstimate(row, row.deletion_confirmed_at ?? now);
    net = safeTotal(net, estimate.netMicros);
    gross = safeTotal(gross, estimate.grossMicros);
    executions.add(row.execution_id);
    workspaces.add(row.workspace_id);
  }
  const generationCount = executions.size;
  const restoreCount = Math.max(0, generationCount - workspaces.size);
  await drizzle(env.DB)
    .insert(workshopSessionCostSummaries)
    .values({
      sessionId: input.sessionId,
      currency: forecast.currency,
      finalNetMicros: net,
      finalGrossMicros: gross,
      forecastNetVarianceMicros: net - forecast.expected.totalNetMicros,
      forecastGrossVarianceMicros: gross - forecast.expected.totalGrossMicros,
      generationCount,
      restoreCount,
      cleanupPendingCount: 0,
      manualCleanupUnverified: false,
      finalizedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workshopSessionCostSummaries.sessionId,
      set: {
        finalNetMicros: net,
        finalGrossMicros: gross,
        forecastNetVarianceMicros: net - forecast.expected.totalNetMicros,
        forecastGrossVarianceMicros: gross - forecast.expected.totalGrossMicros,
        generationCount,
        restoreCount,
        cleanupPendingCount: 0,
        finalizedAt: now,
        updatedAt: now,
      },
    });
  return { finalized: true };
}

interface LedgerRow {
  id: string;
  execution_id: string;
  currency: string;
  hourly_net_micros: number;
  hourly_gross_micros: number;
  monthly_net_micros: number | null;
  monthly_gross_micros: number | null;
  provider_created_at: number;
  deletion_confirmed_at: number | null;
  allocation_state: string;
  workspace_id: string;
}

function projectLedger(input: {
  rows: LedgerRow[];
  currency: string;
  now: number;
  scheduledEndAt: number;
  leaseCeilingAt: number;
  forecast: StoredWorkshopCostForecast;
  grossCeilingMicros: number | null;
}): WorkshopLiveCostProjection {
  let accruedNetMicros = 0;
  let accruedGrossMicros = 0;
  let scheduledEndNetMicros = 0;
  let scheduledEndGrossMicros = 0;
  let leaseCeilingNetMicros = 0;
  let leaseCeilingGrossMicros = 0;
  let accumulatingResources = 0;
  for (const row of input.rows) {
    if (row.currency !== input.currency) {
      throw appError(
        409,
        "provider_ledger_currency_mismatch",
        "provider ledger contains mixed billing currencies",
      );
    }
    const accrued = ledgerEstimate(row, input.now);
    const scheduled = ledgerEstimate(
      row,
      Math.max(input.now, input.scheduledEndAt),
    );
    const ceiling = ledgerEstimate(
      row,
      Math.max(input.now, input.leaseCeilingAt),
    );
    accruedNetMicros = safeTotal(accruedNetMicros, accrued.netMicros);
    accruedGrossMicros = safeTotal(accruedGrossMicros, accrued.grossMicros);
    scheduledEndNetMicros = safeTotal(
      scheduledEndNetMicros,
      scheduled.netMicros,
    );
    scheduledEndGrossMicros = safeTotal(
      scheduledEndGrossMicros,
      scheduled.grossMicros,
    );
    leaseCeilingNetMicros = safeTotal(leaseCeilingNetMicros, ceiling.netMicros);
    leaseCeilingGrossMicros = safeTotal(
      leaseCeilingGrossMicros,
      ceiling.grossMicros,
    );
    if (row.deletion_confirmed_at === null) accumulatingResources += 1;
  }
  const cleanupPendingResources = input.rows.filter(
    (row) =>
      row.deletion_confirmed_at === null &&
      row.allocation_state === "cleanup_pending",
  ).length;
  const grossCeilingUsageMicros = Math.max(
    accruedGrossMicros,
    scheduledEndGrossMicros,
    leaseCeilingGrossMicros,
    input.forecast.leaseCeiling.totalGrossMicros,
  );
  return {
    currency: input.currency,
    accruedNetMicros,
    accruedGrossMicros,
    scheduledEndNetMicros,
    scheduledEndGrossMicros,
    leaseCeilingNetMicros,
    leaseCeilingGrossMicros,
    forecastNetVarianceMicros:
      scheduledEndNetMicros - input.forecast.expected.totalNetMicros,
    forecastGrossVarianceMicros:
      scheduledEndGrossMicros - input.forecast.expected.totalGrossMicros,
    cleanupPendingResources,
    accumulatingResources,
    grossCeilingMicros: input.grossCeilingMicros,
    grossCeilingUsageMicros,
    overGrossCeiling:
      input.grossCeilingMicros !== null &&
      grossCeilingUsageMicros > input.grossCeilingMicros,
  };
}

function ledgerEstimate(row: LedgerRow, targetAt: number) {
  return estimateLedgerResource({
    createdAt: row.provider_created_at,
    deletionConfirmedAt: row.deletion_confirmed_at,
    now: targetAt,
    hourlyNetMicros: row.hourly_net_micros,
    hourlyGrossMicros: row.hourly_gross_micros,
    monthlyNetMicros: row.monthly_net_micros,
    monthlyGrossMicros: row.monthly_gross_micros,
  });
}

function safeTotal(left: number, right: number): number {
  const value = BigInt(left) + BigInt(right);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw appError(
      409,
      "provider_cost_too_large",
      "provider cost is too large",
    );
  }
  return Number(value);
}
