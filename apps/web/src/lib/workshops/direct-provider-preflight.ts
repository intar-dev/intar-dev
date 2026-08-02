import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type {
  ProviderCapacityObservation,
  ProviderOperationResult,
} from "@intar/provider-contracts";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerConnections,
  providerCredentialVersions,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "./provider-credential";
import { invokeProviderOperation } from "./provider-service";
import type {
  ProviderPreflightRequest,
  ProviderPreflightResult,
} from "./runtime-provider";

type DirectCloudKind = "hetzner_cloud" | "gcp_compute";

/**
 * Re-inspects provider capacity without mutating cloud state, then combines
 * the observation with the organization connection's canonical D1 guardrail.
 */
export async function preflightDirectCloudProvider(
  input: ProviderPreflightRequest,
): Promise<ProviderPreflightResult> {
  const kind = input.preparation.profile.providerKind;
  if (kind === "agent_kvm" || !input.preparation.connectionId) {
    throw appError(
      409,
      "runtime_provider_preflight_context_invalid",
      "direct-cloud capacity preflight requires a provider connection",
    );
  }
  const requestedSeats = nonNegativeSeats(input.requestedSeats);
  if (requestedSeats === 0) {
    return {
      ok: true,
      availableSeats: 0,
      preferredLocation: input.preparation.permittedLocations[0] ?? null,
      reasons: [],
    };
  }

  const context = await loadConnectionContext({
    organizationId: input.organizationId,
    connectionId: input.preparation.connectionId,
    kind,
  });
  const allocationCounts = await loadAllocationCounts({
    connectionId: context.connection.id,
    sessionId: input.sessionId,
  });
  const sessionActiveSeats = Math.min(
    requestedSeats,
    allocationCounts.sessionActiveSeats,
  );
  const additionalRequestedSeats = Math.max(
    0,
    requestedSeats - sessionActiveSeats,
  );
  const observed =
    additionalRequestedSeats === 0
      ? emptyObservation(input.preparation.permittedLocations)
      : await observeProviderCapacity({
          kind,
          input,
          additionalRequestedSeats,
          connection: context.connection,
          credential: context.credential,
        });
  return combineDirectProviderCapacity({
    requestedSeats,
    sessionActiveSeats,
    activeAllocations: allocationCounts.activeAllocations,
    maxConcurrentAllocations: context.maxConcurrentAllocations,
    observed,
    fallbackLocation: input.preparation.permittedLocations[0] ?? null,
  });
}

export function combineDirectProviderCapacity(input: {
  requestedSeats: number;
  sessionActiveSeats: number;
  activeAllocations: number;
  maxConcurrentAllocations: number;
  observed: ProviderCapacityObservation;
  fallbackLocation: string | null;
}): ProviderPreflightResult {
  const additionalRequestedSeats = Math.max(
    0,
    input.requestedSeats - input.sessionActiveSeats,
  );
  const remainingConnectionSeats = Math.max(
    0,
    input.maxConcurrentAllocations - input.activeAllocations,
  );
  const additionalAvailableSeats = Math.min(
    additionalRequestedSeats,
    input.observed.availableSeats,
    remainingConnectionSeats,
  );
  const availableSeats = Math.min(
    input.requestedSeats,
    input.sessionActiveSeats + additionalAvailableSeats,
  );
  const reasons = [...input.observed.reasons];
  if (remainingConnectionSeats < additionalRequestedSeats) {
    reasons.push(
      `connection guardrail has ${remainingConnectionSeats} seat(s) remaining after ${input.activeAllocations} active allocation(s)`,
    );
  }
  if (availableSeats < input.requestedSeats && reasons.length === 0) {
    reasons.push("the provider could not establish capacity for the full Workshop roster");
  }
  return {
    ok: availableSeats >= input.requestedSeats,
    availableSeats,
    preferredLocation:
      input.observed.preferredLocation ?? input.fallbackLocation,
    reasons,
  };
}

async function loadConnectionContext(input: {
  organizationId: string;
  connectionId: string;
  kind: DirectCloudKind;
}) {
  const db = drizzle(env.DB);
  const connectionRows = await db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, input.connectionId),
        eq(providerConnections.organizationId, input.organizationId),
        eq(providerConnections.providerKind, input.kind),
      ),
    )
    .limit(1);
  const connection = connectionRows[0];
  if (
    !connection ||
    connection.state !== "active" ||
    !connection.activeCredentialVersionId
  ) {
    throw appError(
      409,
      "provider_connection_inactive",
      "the selected provider connection is not active",
    );
  }
  const credentialRows = await db
    .select()
    .from(providerCredentialVersions)
    .where(
      and(
        eq(
          providerCredentialVersions.id,
          connection.activeCredentialVersionId,
        ),
        eq(providerCredentialVersions.connectionId, connection.id),
      ),
    )
    .limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.revokedAt !== null) {
    throw appError(
      409,
      "provider_credential_missing",
      "the active provider credential is unavailable",
    );
  }
  const detailRows =
    input.kind === "hetzner_cloud"
      ? await db
          .select({ value: hetznerConnectionDetails.maxConcurrentAllocations })
          .from(hetznerConnectionDetails)
          .where(eq(hetznerConnectionDetails.connectionId, connection.id))
          .limit(1)
      : await db
          .select({ value: gcpConnectionDetails.maxConcurrentAllocations })
          .from(gcpConnectionDetails)
          .where(eq(gcpConnectionDetails.connectionId, connection.id))
          .limit(1);
  const maxConcurrentAllocations = detailRows[0]?.value;
  if (!maxConcurrentAllocations) {
    throw appError(
      409,
      "provider_connection_incomplete",
      "provider connection guardrails are unavailable",
    );
  }
  return { connection, credential, maxConcurrentAllocations };
}

async function loadAllocationCounts(input: {
  connectionId: string;
  sessionId: string;
}): Promise<{ activeAllocations: number; sessionActiveSeats: number }> {
  const row = await env.DB.prepare(
    `SELECT
       (SELECT count(*)
          FROM runtime_provider_allocations allocation
         WHERE allocation.connection_id = ?1
           AND allocation.state != 'deleted') AS active_allocations,
       (SELECT count(DISTINCT workspace.id)
          FROM runtime_provider_allocations allocation
          JOIN runtime_executions execution
            ON execution.id = allocation.execution_id
           AND execution.domain_kind = 'workshop'
          JOIN workshop_workspaces workspace
            ON workspace.id = execution.domain_id
         WHERE allocation.connection_id = ?1
           AND allocation.state != 'deleted'
           AND workspace.session_id = ?2) AS session_active_seats`,
  )
    .bind(input.connectionId, input.sessionId)
    .first<{ active_allocations: number; session_active_seats: number }>();
  return {
    activeAllocations: nonNegativeCount(row?.active_allocations),
    sessionActiveSeats: nonNegativeCount(row?.session_active_seats),
  };
}

async function observeProviderCapacity(input: {
  kind: DirectCloudKind;
  input: ProviderPreflightRequest;
  additionalRequestedSeats: number;
  connection: typeof providerConnections.$inferSelect;
  credential: typeof providerCredentialVersions.$inferSelect;
}): Promise<ProviderCapacityObservation> {
  const profile = input.input.preparation.profile;
  if (!profile.machineType || !profile.resolvedImageId) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile is incomplete",
    );
  }
  const requestId = createAppId();
  const request = {
    requestId,
    connectionId: input.connection.id,
    credentialContext: providerCredentialContext({
      organizationId: input.input.organizationId,
      connection: input.connection,
      credential: input.credential,
    }),
    credential: providerCredentialEnvelope(input.credential),
    ...(input.kind === "gcp_compute"
      ? { projectId: input.connection.externalProjectId }
      : {}),
    operation:
      input.kind === "hetzner_cloud"
        ? {
            kind: "preflight_capacity",
            serverType: profile.machineType,
            permittedLocations: [...input.input.preparation.permittedLocations],
            systemImage: profile.systemImage,
            requestedSeats: input.additionalRequestedSeats,
          }
        : {
            kind: "preflight_capacity",
            machineType: profile.machineType,
            zones: [...input.input.preparation.permittedLocations],
            rootDiskType: profile.rootDiskType,
            rootDiskGib: rootDiskGibForPreflight(profile.hardware.diskMib),
            requestedSeats: input.additionalRequestedSeats,
          },
  };
  const result = await invokeProviderOperation(
    input.kind,
    (binding) => binding.runOperation(request),
  );
  return parseCapacityObservation(
    result,
    input.additionalRequestedSeats,
    input.input.preparation.permittedLocations,
  );
}

export function rootDiskGibForPreflight(diskMib: number): number {
  if (!Number.isSafeInteger(diskMib) || diskMib < 1) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the pinned runtime profile has an invalid root disk requirement",
    );
  }
  return Math.ceil(diskMib / 1024);
}

function parseCapacityObservation(
  result: ProviderOperationResult,
  requestedSeats: number,
  permittedLocations: readonly string[],
): ProviderCapacityObservation {
  const value = record(result.data);
  const observedAt = typeof value?.observedAt === "string" ? value.observedAt : "";
  const observedMillis = Date.parse(observedAt);
  const availableSeats = value?.availableSeats;
  const preferredLocation = value?.preferredLocation;
  const availableLocations = value?.availableLocations;
  const capacityBasis = value?.capacityBasis;
  const reasons = value?.reasons;
  if (
    value?.requestedSeats !== requestedSeats ||
    !Number.isSafeInteger(availableSeats) ||
    Number(availableSeats) < 0 ||
    Number(availableSeats) > requestedSeats ||
    !Number.isFinite(observedMillis) ||
    (preferredLocation !== null &&
      (typeof preferredLocation !== "string" ||
        !permittedLocations.includes(preferredLocation))) ||
    !Array.isArray(availableLocations) ||
    availableLocations.some(
      (location) =>
        typeof location !== "string" || !permittedLocations.includes(location),
    ) ||
    ![
      "quantitative_quota",
      "availability_only",
      "unavailable",
    ].includes(String(capacityBasis)) ||
    !Array.isArray(reasons) ||
    reasons.some(
      (reason) => typeof reason !== "string" || reason.length > 300,
    )
  ) {
    throw appError(
      503,
      "runtime_provider_capacity_invalid",
      "provider capacity response is invalid",
    );
  }
  return {
    observedAt,
    requestedSeats,
    availableSeats: Number(availableSeats),
    preferredLocation: preferredLocation as string | null,
    availableLocations: availableLocations as string[],
    capacityBasis: capacityBasis as ProviderCapacityObservation["capacityBasis"],
    reasons: reasons as string[],
  };
}

function emptyObservation(
  permittedLocations: readonly string[],
): ProviderCapacityObservation {
  return {
    observedAt: new Date().toISOString(),
    requestedSeats: 0,
    availableSeats: 0,
    preferredLocation: permittedLocations[0] ?? null,
    availableLocations: [...permittedLocations],
    capacityBasis: "quantitative_quota",
    reasons: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeSeats(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw appError(
      400,
      "runtime_provider_seat_count_invalid",
      "provider preflight seat count is invalid",
    );
  }
  return value;
}

function nonNegativeCount(value: number | null | undefined): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}
