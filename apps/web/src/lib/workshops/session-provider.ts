import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ProviderOperationResult } from "@intar/provider-contracts";
import type {
  RuntimeHardwareShape,
  RuntimeProviderKind,
  RuntimeProviderSelection,
} from "@intar/workshop-contracts";
import {
  providerConnections,
  providerCredentialVersions,
  workshopEvents,
  workshopRuntimeProfileCertifications,
  workshopRuntimeProfiles,
  workshopSessionRuntimeSelections,
  workshopSessions,
  type StoredResolvedRuntimeProfile,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import { createWorkshopCostForecast } from "./cost-storage";
import {
  assertSelectionCompatible,
  type ProviderConnectionRef,
  type ProviderPreflightResult,
  type ProviderQuote,
  type ResolvedRuntimeProfile,
  type RuntimeProviderAdapter,
} from "./runtime-provider";
import { requireProductionRuntimeProviderAdapter } from "./provider-runtime";
import { invokeProviderOperation } from "./provider-service";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "./provider-credential";
import {
  countWorkshopRequestedSeats,
  persistWorkshopProviderPreflight,
} from "./provider-preflight-state";

export interface PreparedWorkshopSessionProvider {
  runtimeProfileId: string;
  profileId: string;
  providerKind: RuntimeProviderKind;
  connectionId: string | null;
  resolvedProfile: StoredResolvedRuntimeProfile;
}

/**
 * Resolve one exact, certified profile for a new session. There is no default
 * profile and no provider/type/location substitution.
 */
export async function prepareWorkshopSessionProvider(input: {
  organizationId: string;
  templateRevisionId: string;
  runtimeProvider: RuntimeProviderSelection;
}): Promise<PreparedWorkshopSessionProvider> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      profile: workshopRuntimeProfiles,
      certificationState: workshopRuntimeProfileCertifications.state,
      certificationConnectionId:
        workshopRuntimeProfileCertifications.connectionId,
      deletionConfirmedAt:
        workshopRuntimeProfileCertifications.deletionConfirmedAt,
    })
    .from(workshopRuntimeProfiles)
    .innerJoin(
      workshopRuntimeProfileCertifications,
      eq(
        workshopRuntimeProfileCertifications.runtimeProfileId,
        workshopRuntimeProfiles.id,
      ),
    )
    .where(
      and(
        eq(
          workshopRuntimeProfiles.templateRevisionId,
          input.templateRevisionId,
        ),
        eq(workshopRuntimeProfiles.profileId, input.runtimeProvider.profileId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw appError(
      404,
      "workshop_runtime_profile_not_found",
      "the selected workshop runtime profile does not exist",
    );
  }
  if (
    row.certificationState !== "verified" ||
    row.deletionConfirmedAt === null
  ) {
    throw appError(
      409,
      "workshop_runtime_profile_not_certified",
      "the selected workshop runtime profile has not passed certification and cleanup",
    );
  }

  const resolvedProfile = storedProfile(row.profile);
  let connection: ProviderConnectionRef | null = null;
  if (row.profile.providerKind !== "agent_kvm") {
    const connectionId = input.runtimeProvider.connectionId;
    if (!connectionId) {
      throw appError(
        400,
        "workshop_runtime_connection_required",
        "direct-cloud workshop profiles require a provider connection",
      );
    }
    const connections = await db
      .select()
      .from(providerConnections)
      .where(
        and(
          eq(providerConnections.id, connectionId),
          eq(providerConnections.organizationId, input.organizationId),
          eq(providerConnections.providerKind, row.profile.providerKind),
        ),
      )
      .limit(1);
    const selected = connections[0];
    if (!selected) {
      throw appError(
        404,
        "provider_connection_not_found",
        "the selected provider connection does not exist",
      );
    }
    if (selected.state !== "active" || !selected.activeCredentialVersionId) {
      throw appError(
        409,
        "provider_connection_inactive",
        "the selected provider connection is not active",
      );
    }
    if (
      row.certificationConnectionId !== null &&
      row.certificationConnectionId !== selected.id
    ) {
      throw appError(
        409,
        "workshop_runtime_profile_connection_uncertified",
        "the selected provider connection did not certify this runtime profile",
      );
    }
    connection = {
      id: selected.id,
      providerKind: selected.providerKind,
    };
    await assertPinnedProfileStillAvailable({
      organizationId: input.organizationId,
      connection: selected,
      profile: row.profile,
    });
  }

  try {
    assertSelectionCompatible({
      selection: input.runtimeProvider,
      profile: resolvedProfileForContract(row.profile),
      connection,
    });
  } catch (error) {
    throw appError(
      400,
      "workshop_runtime_provider_invalid",
      error instanceof Error ? error.message : "invalid runtime provider",
    );
  }

  return {
    runtimeProfileId: row.profile.id,
    profileId: row.profile.profileId,
    providerKind: row.profile.providerKind,
    connectionId: connection?.id ?? null,
    resolvedProfile,
  };
}

export function workshopSessionProviderInsert(
  sessionId: string,
  prepared: PreparedWorkshopSessionProvider,
  now: number,
) {
  return {
    sessionId,
    runtimeProfileId: prepared.runtimeProfileId,
    profileId: prepared.profileId,
    providerKind: prepared.providerKind,
    connectionId: prepared.connectionId,
    resolvedProfileJson: prepared.resolvedProfile,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof workshopSessionRuntimeSelections.$inferInsert;
}

export async function loadWorkshopSessionProvider(
  sessionId: string,
): Promise<PreparedWorkshopSessionProvider> {
  const rows = await drizzle(env.DB)
    .select()
    .from(workshopSessionRuntimeSelections)
    .where(eq(workshopSessionRuntimeSelections.sessionId, sessionId))
    .limit(1);
  const selected = rows[0];
  if (!selected) {
    throw appError(
      409,
      "workshop_runtime_provider_missing",
      "the workshop session has no runtime provider selection",
    );
  }
  return {
    runtimeProfileId: selected.runtimeProfileId,
    profileId: selected.profileId,
    providerKind: selected.providerKind,
    connectionId: selected.connectionId,
    resolvedProfile: selected.resolvedProfileJson,
  };
}

export async function refreshWorkshopSessionProviderPreflight(input: {
  sessionId: string;
  actorUserId?: string | null;
  trigger: "lobby_refresh" | "admin_refresh" | "price_changed";
}): Promise<{
  kind: RuntimeProviderKind;
  requestedSeats: number;
  availableSeats: number;
  preferredLocation: string | null;
  reasons: readonly string[];
}> {
  const db = drizzle(env.DB);
  const sessionRows = await db
    .select({
      organizationId: workshopSessions.organizationId,
      templateRevisionId: workshopSessions.templateRevisionId,
      profileId: workshopSessionRuntimeSelections.profileId,
      connectionId: workshopSessionRuntimeSelections.connectionId,
    })
    .from(workshopSessions)
    .innerJoin(
      workshopSessionRuntimeSelections,
      eq(
        workshopSessionRuntimeSelections.sessionId,
        workshopSessions.id,
      ),
    )
    .where(eq(workshopSessions.id, input.sessionId))
    .limit(1);
  const session = sessionRows[0];
  if (!session) {
    throw appError(404, "workshop_session_not_found", "workshop session not found");
  }
  const prepared = await prepareWorkshopSessionProvider({
    organizationId: session.organizationId,
    templateRevisionId: session.templateRevisionId,
    runtimeProvider: {
      profileId: session.profileId,
      ...(session.connectionId === null
        ? {}
        : { connectionId: session.connectionId }),
    },
  });
  const forecast = await createWorkshopCostForecast({
    sessionId: input.sessionId,
    trigger: input.trigger,
    ...(input.actorUserId == null ? {} : { actorUserId: input.actorUserId }),
  });
  const checkedAt = Date.now();
  const requestedSeats = await countWorkshopRequestedSeats(input.sessionId);
  let result: ProviderPreflightResult;
  try {
    result = await executeWorkshopProviderPreflight({
      adapter: requireProductionRuntimeProviderAdapter(prepared.providerKind),
      organizationId: session.organizationId,
      sessionId: input.sessionId,
      prepared,
      requestedSeats,
      quote: forecast
        ? {
            currency: forecast.currency,
            observedAt: forecast.observedAt,
            expiresAt: forecast.expiresAt,
            lineItems: [],
          }
        : {
            currency: "",
            observedAt: checkedAt,
            expiresAt: checkedAt,
            lineItems: [],
          },
      now: checkedAt,
    });
  } catch (error) {
    const failed = {
      ok: false,
      availableSeats: 0,
      preferredLocation: null,
      reasons: [
        error instanceof Error
          ? error.message
          : "provider capacity inspection failed",
      ],
    } satisfies ProviderPreflightResult;
    await persistWorkshopProviderPreflight({
      sessionId: input.sessionId,
      requestedSeats,
      result: failed,
      checkedAt,
    });
    await appendProviderPreflightEvent({
      db,
      input,
      organizationId: session.organizationId,
      prepared,
      requestedSeats,
      result: failed,
      checkedAt,
    });
    throw error;
  }
  await persistWorkshopProviderPreflight({
    sessionId: input.sessionId,
    requestedSeats,
    result,
    checkedAt,
  });
  await appendProviderPreflightEvent({
    db,
    input,
    organizationId: session.organizationId,
    prepared,
    requestedSeats,
    result,
    checkedAt,
  });
  if (!result.ok) {
    throw appError(
      409,
      "workshop_provider_capacity_insufficient",
      result.reasons[0] ??
        "the provider cannot provision the full Workshop roster",
    );
  }
  return {
    kind: prepared.providerKind,
    requestedSeats,
    availableSeats: result.availableSeats,
    preferredLocation: result.preferredLocation,
    reasons: result.reasons,
  };
}

export async function executeWorkshopProviderPreflight(input: {
  adapter: RuntimeProviderAdapter;
  organizationId: string;
  sessionId: string;
  prepared: PreparedWorkshopSessionProvider;
  requestedSeats: number;
  quote: ProviderQuote;
  now: number;
}): Promise<ProviderPreflightResult> {
  const profile: ResolvedRuntimeProfile = {
    id: input.prepared.profileId,
    providerKind: input.prepared.providerKind,
    vmId: input.prepared.resolvedProfile.vmId,
    machineType: input.prepared.resolvedProfile.machineType,
    systemImage: input.prepared.resolvedProfile.systemImage,
    resolvedImageId: input.prepared.resolvedProfile.resolvedImageId,
    rootDiskType: input.prepared.resolvedProfile.rootDiskType,
    locations: input.prepared.resolvedProfile.locations,
    hardware: input.prepared.resolvedProfile.hardware,
    configuration: input.prepared.resolvedProfile.configuration,
  };
  const connection: ProviderConnectionRef | null =
    input.prepared.connectionId === null ||
    input.prepared.providerKind === "agent_kvm"
      ? null
      : {
          id: input.prepared.connectionId,
          providerKind: input.prepared.providerKind,
        };
  const preparation = await input.adapter.prepareSession({
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    profile,
    connection,
    now: input.now,
  });
  return input.adapter.preflight({
    organizationId: input.organizationId,
    sessionId: input.sessionId,
    preparation,
    quote: input.quote,
    requestedSeats: input.requestedSeats,
    now: input.now,
  });
}

async function appendProviderPreflightEvent(input: {
  db: ReturnType<typeof drizzle>;
  input: {
    sessionId: string;
    actorUserId?: string | null;
    trigger: "lobby_refresh" | "admin_refresh" | "price_changed";
  };
  organizationId: string;
  prepared: PreparedWorkshopSessionProvider;
  requestedSeats: number;
  result: ProviderPreflightResult;
  checkedAt: number;
}): Promise<void> {
  await input.db.insert(workshopEvents).values({
    id: createAppId(),
    organizationId: input.organizationId,
    sessionId: input.input.sessionId,
    actorUserId: input.input.actorUserId ?? null,
    type: "runtime_provider.preflight_refreshed",
    payloadJson: {
      profileId: input.prepared.profileId,
      providerKind: input.prepared.providerKind,
      connectionId: input.prepared.connectionId,
      requestedSeats: input.requestedSeats,
      availableSeats: input.result.availableSeats,
      ok: input.result.ok,
      preferredLocation: input.result.preferredLocation,
      reasons: [...input.result.reasons],
      trigger: input.input.trigger,
    },
    createdAt: input.checkedAt,
  });
}

export async function createInitialWorkshopSessionForecast(input: {
  sessionId: string;
  prepared: PreparedWorkshopSessionProvider;
  actorUserId: string;
}): Promise<void> {
  await createWorkshopCostForecast({
    sessionId: input.sessionId,
    actorUserId: input.actorUserId,
    trigger: "session_created",
  });
}

export async function createWorkshopSessionForecastFromPinnedPrice(input: {
  sessionId: string;
  actorUserId: string;
  trigger: "roster_changed" | "schedule_changed";
}): Promise<void> {
  await createWorkshopCostForecast(input);
}

async function assertPinnedProfileStillAvailable(input: {
  organizationId: string;
  connection: typeof providerConnections.$inferSelect;
  profile: typeof workshopRuntimeProfiles.$inferSelect;
}): Promise<void> {
  if (!input.profile.machineType || !input.profile.resolvedImageId) {
    throw appError(
      409,
      "workshop_runtime_profile_incomplete",
      "the selected direct-cloud runtime profile is incomplete",
    );
  }
  const credentialRows = await drizzle(env.DB)
    .select()
    .from(providerCredentialVersions)
    .where(
      eq(
        providerCredentialVersions.id,
        input.connection.activeCredentialVersionId!,
      ),
    )
    .limit(1);
  const credential = credentialRows[0];
  if (!credential || credential.connectionId !== input.connection.id) {
    throw appError(
      409,
      "provider_credential_missing",
      "the active provider credential is unavailable",
    );
  }
  const credentialContext = providerCredentialContext({
    organizationId: input.organizationId,
    connection: input.connection,
    credential,
  });
  const requestId = createAppId();
  const providerKind = input.profile.providerKind;
  if (providerKind === "agent_kvm") {
    throw new TypeError("agent_kvm does not use provider catalog services");
  }
  const operation =
    providerKind === "hetzner_cloud"
      ? {
          kind: "catalog",
          requiredServerTypes: [input.profile.machineType],
          permittedLocations: input.profile.locationsJson,
          systemImage: input.profile.systemImage,
        }
      : {
          kind: "resolve_profile",
          machineType: input.profile.machineType,
          zones: input.profile.locationsJson,
          imageFamily: input.profile.systemImage,
        };
  const request = {
    requestId,
    connectionId: input.connection.id,
    credentialContext,
    credential: providerCredentialEnvelope(credential),
    ...(providerKind === "gcp_compute"
      ? { projectId: input.connection.externalProjectId }
      : {}),
    operation,
  };
  const result = await invokeProviderOperation(
    providerKind,
    (binding) => binding.runOperation(request),
  );
  assertObservedProfileUnchanged(input.profile, result);
}

function assertObservedProfileUnchanged(
  profile: typeof workshopRuntimeProfiles.$inferSelect,
  result: ProviderOperationResult,
): void {
  const data = record(result.data);
  if (profile.providerKind === "hetzner_cloud") {
    const types = array(data?.serverTypes);
    const observed = types
      .map(record)
      .find((entry) => entry?.name === profile.machineType);
    const images = array(data?.systemImages).map(record);
    const image = images.find(
      (entry) =>
        entry?.name === profile.systemImage &&
        String(entry.id) === profile.resolvedImageId &&
        entry?.architecture === "x86" &&
        entry?.status === "available" &&
        entry?.deprecated == null,
    );
    const cores = positiveNumber(observed?.cores);
    const memoryMib = positiveNumber(observed?.memory) * 1024;
    const diskMib = positiveNumber(observed?.disk) * 1024;
    if (
      !observed ||
      !image ||
      observed.architecture !== "x86" ||
      observed.deprecated === true ||
      observed.deprecation != null ||
      cores * 1000 !== profile.cpuMillis ||
      memoryMib !== profile.memoryMib ||
      diskMib !== profile.diskMib
    ) {
      throw profileChanged();
    }
    return;
  }
  const machineTypes = array(data?.machineTypes).map(record);
  const observed = machineTypes.find(
    (entry) => entry?.name === profile.machineType,
  );
  const image = record(data?.resolvedImage);
  if (
    !observed ||
    observed.architecture !== "X86_64" ||
    observed.deprecated != null ||
    positiveNumber(observed.guestCpus) * 1000 !== profile.cpuMillis ||
    positiveNumber(observed.memoryMib) !== profile.memoryMib ||
    !image ||
    image.architecture !== "X86_64" ||
    image.status !== "READY" ||
    image.selfLink !== profile.resolvedImageId
  ) {
    throw profileChanged();
  }
}

function profileChanged() {
  return appError(
    409,
    "workshop_runtime_profile_changed",
    "the exact pinned runtime profile is unavailable or materially changed",
  );
}

function storedProfile(
  row: typeof workshopRuntimeProfiles.$inferSelect,
): StoredResolvedRuntimeProfile {
  return {
    providerKind: row.providerKind,
    vmId: row.vmId,
    machineType: row.machineType,
    systemImage: row.systemImage,
    resolvedImageId: row.resolvedImageId,
    rootDiskType: row.rootDiskType,
    locations: row.locationsJson,
    hardware: runtimeHardware(row),
    configuration: row.configurationJson,
  };
}

function resolvedProfileForContract(
  row: typeof workshopRuntimeProfiles.$inferSelect,
): ResolvedRuntimeProfile {
  return {
    id: row.profileId,
    providerKind: row.providerKind,
    vmId: row.vmId,
    machineType: row.machineType,
    systemImage: row.systemImage,
    resolvedImageId: row.resolvedImageId,
    rootDiskType: row.rootDiskType,
    locations: row.locationsJson,
    hardware: runtimeHardware(row),
    configuration: row.configurationJson,
  };
}

function runtimeHardware(
  row: typeof workshopRuntimeProfiles.$inferSelect,
): RuntimeHardwareShape {
  return {
    architecture: "x86_64",
    cpuMillis: row.cpuMillis,
    memoryMib: row.memoryMib,
    diskMib: row.diskMib,
    providerCpuCount: row.cpuMillis / 1000,
    providerMemoryMib: row.memoryMib,
    providerDiskMib: row.diskMib,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Number.NaN;
}
