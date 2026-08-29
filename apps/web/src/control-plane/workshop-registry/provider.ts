import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { ProviderOperationResult } from "@intar/provider-contracts";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import {
  gcpConnectionDetails,
  hetznerConnectionDetails,
  providerConnections,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { createAppId } from "@/lib/id";
import {
  loadActiveCredential,
} from "@/lib/workshops/provider-connections";
import {
  providerCredentialContext,
  providerCredentialEnvelope,
} from "@/lib/workshops/provider-credential";
import { invokeProviderOperation } from "@/lib/workshops/provider-service";
import { requireWorkshopMulticloudRuntimeEnabledForOrganization } from "@/lib/workshops/feature-flag";
import {
  WORKSHOP_RUNTIME_TOOL_FORMAT_VERSION,
  type ValidatedWorkshopSourceBundle,
} from "./archive";

export interface AuthoredRuntimeProfileDeclaration {
  id: string;
  provider: RuntimeProviderKind;
  vmId: string;
  machineType: string | null;
  systemImage: string;
  rootDiskType: string | null;
  locations: string[];
  requirements: {
    cpuMillis: number;
    memoryMib: number;
    diskMib: number;
  };
}

export interface ClaimedRuntimeProfileObservation {
  profile_id: string;
  observation: {
    provider: "hetzner_cloud" | "gcp_compute";
    machine_type: string;
    resolved_system_image: string;
    system_image_is_immutable: true;
    architecture: "x86_64" | "arm64";
    cores: number;
    memory_mib: number;
    disk_mib: number;
    deprecated: boolean;
    available_locations: string[];
  };
}

export interface PublicationProfileResolution {
  declaration: AuthoredRuntimeProfileDeclaration;
  connectionId: string | null;
  claimedObservation: ClaimedRuntimeProfileObservation | null;
}

/**
 * Resolve every authored v2 profile against the publishing organization's
 * exact provider catalog. There is no connection, provider, type, image, or
 * location fallback at this boundary.
 */
export async function resolveWorkshopPublicationProfiles(input: {
  d1: D1Database;
  organizationId: string;
  source: ValidatedWorkshopSourceBundle;
  now?: number;
}): Promise<PublicationProfileResolution[]> {
  const declarations = readRuntimeProfileDeclarations(input.source);
  if (declarations.some((profile) => profile.provider !== "agent_kvm")) {
    await requireWorkshopMulticloudRuntimeEnabledForOrganization(
      input.organizationId,
    );
  }
  const results: PublicationProfileResolution[] = [];
  for (const declaration of declarations) {
    if (declaration.provider === "agent_kvm") {
      results.push({ declaration, connectionId: null, claimedObservation: null });
      continue;
    }
    const connection = await soleActiveConnection(
      input.d1,
      input.organizationId,
      declaration.provider,
    );
    const credential = await loadActiveCredential(connection);
    const locations = await permittedLocations(input.d1, connection.id, declaration);
    const request = {
      requestId: createAppId(),
      connectionId: connection.id,
      credentialContext: providerCredentialContext({
        organizationId: input.organizationId,
        connection,
        credential,
      }),
      credential: providerCredentialEnvelope(credential),
      ...(declaration.provider === "gcp_compute"
        ? { projectId: connection.externalProjectId }
        : {}),
      operation:
        declaration.provider === "hetzner_cloud"
          ? {
              kind: "catalog",
              requiredServerTypes: [requiredMachineType(declaration)],
              permittedLocations: locations,
              systemImage: declaration.systemImage,
            }
          : {
              kind: "resolve_profile",
              machineType: requiredMachineType(declaration),
              zones: locations,
              imageFamily: declaration.systemImage,
            },
    };
    const observed = await invokeProviderOperation(
      declaration.provider,
      (binding) => binding.runOperation(request),
    );
    results.push({
      declaration: { ...declaration, locations },
      connectionId: connection.id,
      claimedObservation:
        declaration.provider === "hetzner_cloud"
          ? normalizeHetznerObservation(declaration, locations, observed)
          : normalizeGcpObservation(declaration, locations, observed),
    });
  }
  return results;
}

export function readRuntimeProfileDeclarations(
  source: ValidatedWorkshopSourceBundle,
): AuthoredRuntimeProfileDeclaration[] {
  const compiled = record(source.compiledManifest, "compiled manifest");
  if (integer(compiled.format_version, "format_version") !== 2) {
    throw appError(400, "workshop_manifest_version_invalid", "only workshop format v2 is accepted");
  }
  if (
    integer(
      compiled.runtime_tool_format_version,
      "runtime_tool_format_version",
    ) !== WORKSHOP_RUNTIME_TOOL_FORMAT_VERSION
  ) {
    throw appError(
      400,
      "workshop_runtime_tool_version_invalid",
      "the workshop runtime tool format is unsupported",
    );
  }
  const manifest = record(compiled.manifest, "manifest");
  const workspace = record(manifest.workspace, "manifest.workspace");
  const vms = array(workspace.vms, "manifest.workspace.vms").map((value) => {
    const vm = record(value, "workspace VM");
    return {
      id: text(vm.id, "workspace VM id"),
      cpuMillis: integer(vm.cpu_millis, "workspace VM cpu_millis"),
      memoryMib: integer(vm.memory_mib, "workspace VM memory_mib"),
      diskMib: integer(vm.disk_mib, "workspace VM disk_mib"),
    };
  });
  const profiles = array(
    workspace.runtime_profiles,
    "manifest.workspace.runtime_profiles",
  );
  if (profiles.length === 0) {
    throw appError(400, "workshop_runtime_profile_missing", "at least one runtime profile is required");
  }
  const ids = new Set<string>();
  return profiles.map((value) => {
    const profile = record(value, "runtime profile");
    const id = text(profile.id, "runtime profile id");
    if (ids.has(id)) throw appError(400, "workshop_runtime_profile_duplicate", `duplicate runtime profile ${id}`);
    ids.add(id);
    const provider = runtimeProviderKind(profile.provider);
    const vmId = text(profile.vm_id, `runtime profile ${id} vm_id`);
    const vm = vms.find((candidate) => candidate.id === vmId);
    if (!vm) throw appError(400, "workshop_runtime_profile_vm_invalid", `runtime profile ${id} references an unknown VM`);
    const machineType = optionalText(profile.machine_type);
    const rootDiskType = optionalText(profile.root_disk_type);
    const locations = optionalTextArray(profile.locations);
    if (provider === "agent_kvm") {
      if (machineType !== null || rootDiskType !== null || locations.length !== 0) {
        throw appError(400, "workshop_runtime_profile_invalid", `agent_kvm profile ${id} contains cloud-only fields`);
      }
    } else if (!machineType) {
      throw appError(400, "workshop_runtime_profile_invalid", `direct-cloud profile ${id} requires machine_type`);
    }
    if (provider === "gcp_compute" && rootDiskType !== "pd-balanced") {
      throw appError(400, "workshop_runtime_profile_invalid", `GCP profile ${id} must use pd-balanced`);
    }
    if (provider !== "gcp_compute" && rootDiskType !== null) {
      throw appError(400, "workshop_runtime_profile_invalid", `runtime profile ${id} has an unsupported root disk type`);
    }
    return {
      id,
      provider,
      vmId,
      machineType,
      systemImage: text(profile.system_image, `runtime profile ${id} system_image`),
      rootDiskType,
      locations,
      requirements: vm,
    };
  });
}

async function soleActiveConnection(
  d1: D1Database,
  organizationId: string,
  providerKind: "hetzner_cloud" | "gcp_compute",
) {
  const rows = await drizzle(d1)
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.organizationId, organizationId),
        eq(providerConnections.providerKind, providerKind),
        eq(providerConnections.state, "active"),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw appError(
      409,
      rows.length === 0
        ? "provider_connection_required"
        : "provider_connection_ambiguous",
      rows.length === 0
        ? `an active ${providerKind} connection is required to publish this workshop`
        : `publication requires exactly one active ${providerKind} connection`,
    );
  }
  return rows[0]!;
}

async function permittedLocations(
  d1: D1Database,
  connectionId: string,
  profile: AuthoredRuntimeProfileDeclaration,
): Promise<string[]> {
  const db = drizzle(d1);
  const configured =
    profile.provider === "hetzner_cloud"
      ? (
          await db
            .select({ values: hetznerConnectionDetails.approvedLocationsJson })
            .from(hetznerConnectionDetails)
            .where(eq(hetznerConnectionDetails.connectionId, connectionId))
            .limit(1)
        )[0]?.values
      : (
          await db
            .select({ values: gcpConnectionDetails.approvedZonesJson })
            .from(gcpConnectionDetails)
            .where(eq(gcpConnectionDetails.connectionId, connectionId))
            .limit(1)
        )[0]?.values;
  if (!configured?.length) throw appError(409, "provider_connection_incomplete", "provider location policy is unavailable");
  if (profile.locations.length === 0) return [...configured];
  const configuredSet = new Set(configured);
  if (profile.locations.some((location) => !configuredSet.has(location))) {
    throw appError(409, "workshop_runtime_location_not_approved", `profile ${profile.id} requests an unapproved location`);
  }
  return [...profile.locations];
}

function normalizeHetznerObservation(
  declaration: AuthoredRuntimeProfileDeclaration,
  locations: string[],
  result: ProviderOperationResult,
): ClaimedRuntimeProfileObservation {
  const data = record(result.data, "Hetzner catalog");
  const machineType = requiredMachineType(declaration);
  const server = array(data.serverTypes, "Hetzner server types")
    .map((value) => record(value, "Hetzner server type"))
    .find((candidate) => candidate.name === machineType);
  const image = array(data.systemImages, "Hetzner system images")
    .map((value) => record(value, "Hetzner image"))
    .find((candidate) => candidate.name === declaration.systemImage);
  if (!server || !image) throw appError(409, "workshop_runtime_profile_unavailable", `profile ${declaration.id} is unavailable`);
  const available = new Set(
    optionalArray(server.locations)
      .map((value) => record(value, "server type location"))
      .filter((entry) => entry.available === true && entry.deprecation == null)
      .map((entry) => text(entry.name, "server type location name")),
  );
  const availableLocations = locations.filter(
    (location) => available.size === 0 || available.has(location),
  );
  return {
    profile_id: declaration.id,
    observation: {
      provider: "hetzner_cloud",
      machine_type: machineType,
      resolved_system_image: String(image.id),
      system_image_is_immutable: true,
      architecture: image.architecture === "x86" && server.architecture === "x86" ? "x86_64" : "arm64",
      cores: integer(server.cores, "Hetzner server cores"),
      memory_mib: positiveNumber(server.memory, "Hetzner server memory") * 1024,
      disk_mib: integer(server.disk, "Hetzner server disk") * 1024,
      deprecated: server.deprecated === true || server.deprecation != null || image.deprecated != null || image.deleted != null || image.status !== "available",
      available_locations: availableLocations,
    },
  };
}

function normalizeGcpObservation(
  declaration: AuthoredRuntimeProfileDeclaration,
  locations: string[],
  result: ProviderOperationResult,
): ClaimedRuntimeProfileObservation {
  const data = record(result.data, "GCP catalog");
  const machines = array(data.machineTypes, "GCP machine types").map((value) => record(value, "GCP machine type"));
  const machineType = requiredMachineType(declaration);
  const machine = machines.find((candidate) => candidate.name === machineType);
  const image = record(data.resolvedImage, "GCP resolved image");
  if (!machine) throw appError(409, "workshop_runtime_profile_unavailable", `profile ${declaration.id} is unavailable`);
  const availableLocations = locations.filter((zone) =>
    machines.some((candidate) => candidate.name === machineType && candidate.zone === zone && candidate.deprecated == null),
  );
  return {
    profile_id: declaration.id,
    observation: {
      provider: "gcp_compute",
      machine_type: machineType,
      resolved_system_image: text(image.selfLink, "GCP image selfLink"),
      system_image_is_immutable: true,
      architecture: machine.architecture === "X86_64" && image.architecture === "X86_64" ? "x86_64" : "arm64",
      cores: integer(machine.guestCpus, "GCP guest CPUs"),
      memory_mib: integer(machine.memoryMib, "GCP memory"),
      disk_mib: declaration.requirements.diskMib,
      deprecated: machine.deprecated != null || image.deprecated != null || image.status !== "READY",
      available_locations: availableLocations,
    },
  };
}

function requiredMachineType(profile: AuthoredRuntimeProfileDeclaration): string {
  if (!profile.machineType) throw appError(400, "workshop_runtime_profile_invalid", `profile ${profile.id} has no machine type`);
  return profile.machineType;
}

function runtimeProviderKind(value: unknown): RuntimeProviderKind {
  if (value === "agent_kvm" || value === "hetzner_cloud" || value === "gcp_compute") return value;
  throw appError(400, "workshop_runtime_profile_invalid", "runtime profile provider is invalid");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw appError(400, "workshop_provider_invalid", `${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw appError(400, "workshop_provider_invalid", `${label} must be an array`);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw appError(400, "workshop_provider_invalid", `${label} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return value == null ? null : text(value, "optional string");
}

function optionalTextArray(value: unknown): string[] {
  if (value == null) return [];
  return array(value, "locations").map((entry) => text(entry, "location"));
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw appError(400, "workshop_provider_invalid", `${label} must be a positive integer`);
  return Number(value);
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw appError(400, "workshop_provider_invalid", `${label} must be positive`);
  return value;
}
