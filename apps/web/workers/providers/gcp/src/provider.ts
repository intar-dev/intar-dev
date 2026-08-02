import type {
  CanonicalProviderWrite,
  ProviderOwnership,
  ProviderOperationResult,
} from "@intar/provider-contracts";
import type {
  ConnectGcpProjectRequest,
  ConnectGcpProjectResult,
  GcpAllocationObservation,
  GcpAsyncOperation,
  GcpCapacityObservation,
  GcpCatalogObservation,
  GcpFoundationObservation,
  GcpOperationalConnectionInspection,
  GcpProjectIdentity,
  GcpProjectInventory,
  GcpProjectValidation,
  GcpProviderOperation,
  RotateGcpCredentialRequest,
  RotateGcpCredentialResult,
  RunGcpOperationRequest,
} from "@intar/provider-contracts/gcp";
import { ProviderServiceError } from "@intar/provider-worker-core";
import {
  GcpCatalogClient,
  requireGcpCatalogApiKey,
  type GcpCatalogOptions,
} from "./catalog";
import {
  openGcpCredential,
  parseServiceAccountKey,
  sealGcpCredential,
} from "./credential";
import {
  classifyOperationalInventory,
  GcpClient,
  ownershipMarker,
} from "./gcp-client";
import { gcpOperationErrorCode, type GcpApiOptions } from "./gcp-api";
import { assertCertifiedProfileInput } from "./profile";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface GcpProviderRuntimeOptions {
  api?: GcpApiOptions;
  catalog?: GcpCatalogOptions;
  now?: () => Date;
}

export interface GcpProviderDeployment {
  mode: string;
  catalogApiKey?: string;
}

type GcpProviderDeploymentMode = "active" | "dormant";

function deploymentMode(deployment: GcpProviderDeployment): GcpProviderDeploymentMode {
  if (deployment.mode === "active" || deployment.mode === "dormant") {
    return deployment.mode;
  }
  throw new ProviderServiceError({
    code: "gcp_provider_mode_invalid",
    message: "GCP provider deployment mode is invalid",
    retryable: false,
  });
}

function requireNewWorkCatalog(deployment: GcpProviderDeployment): string {
  if (deploymentMode(deployment) === "dormant") {
    throw new ProviderServiceError({
      code: "gcp_provider_dormant",
      message: "GCP provider is dormant; new connections and allocations are disabled",
      retryable: false,
    });
  }
  return requireGcpCatalogApiKey(deployment.catalogApiKey);
}

function operationStartsNewWork(kind: GcpProviderOperation["kind"]): boolean {
  switch (kind) {
    case "resolve_profile":
    case "quote":
    case "preflight_capacity":
    case "ensure_foundation":
    case "create_instance":
      return true;
    case "inspect_connection":
    case "observe_operation":
    case "observe_allocation":
    case "reboot_instance":
    case "delete_instance":
    case "delete_disk":
    case "sweep":
      return false;
  }
}

function assertRequestIdentity(input: {
  requestId: string;
  connectionId: string;
  credentialContext: { connectionId: string; provider: string };
}): void {
  if (
    !REQUEST_ID_PATTERN.test(input.requestId) ||
    input.connectionId !== input.credentialContext.connectionId ||
    input.credentialContext.provider !== "gcp_compute"
  ) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Provider request identity is invalid",
      retryable: false,
    });
  }
}

function now(options: GcpProviderRuntimeOptions): Date {
  return options.now?.() ?? new Date();
}

function write(
  request: { requestId: string; connectionId: string },
  options: GcpProviderRuntimeOptions,
  value: Omit<CanonicalProviderWrite, "requestId" | "connectionId" | "observedAt">,
): CanonicalProviderWrite {
  return {
    requestId: request.requestId,
    connectionId: request.connectionId,
    observedAt: now(options).toISOString(),
    ...value,
  };
}

function operationWrite(
  request: { requestId: string; connectionId: string },
  operation: GcpAsyncOperation,
  options: GcpProviderRuntimeOptions,
): CanonicalProviderWrite {
  const errorCode = gcpOperationErrorCode(operation);
  return write(request, options, {
    operation: "operation_observed",
    resourceKind: "operation",
    // The control plane must poll the exact zonal/global operation URL. The
    // numeric ID is retained in operationIds for diagnostics, while the
    // canonical external identity is the immutable selfLink.
    externalId: operation.selfLink,
    name: operation.name,
    operationIds: [operation.id],
    state: operation.status,
    ...(errorCode ? { errorCode } : {}),
  });
}

function foundationWrites(
  request: { requestId: string; connectionId: string },
  foundation: GcpFoundationObservation,
  options: GcpProviderRuntimeOptions,
): CanonicalProviderWrite[] {
  const created = new Set(foundation.createdResourceSelfLinks);
  return ([
    ["network", foundation.network],
    ["subnetwork", foundation.subnetwork],
    ["firewall", foundation.firewall],
  ] as const).map(([resourceKind, resource]) =>
    write(request, options, {
      operation: created.has(resource.selfLink) ? "resource_created" : "resource_observed",
      resourceKind,
      externalId: resource.id,
      name: resource.name,
      operationIds: [],
      state: "ready",
      ...(resource.region ? { location: resource.region } : {}),
    }),
  );
}

async function observeCatalog(
  client: GcpClient,
  catalogApiKey: string,
  machineTypes: readonly string[],
  zones: readonly string[],
  imageFamily: string,
  options: GcpProviderRuntimeOptions,
): Promise<GcpCatalogObservation> {
  if (machineTypes.length !== 1) throw new ProviderServiceError({
    code: "gcp_machine_type_unsupported",
    message: "GCP Workshop profiles must pin exactly one machine type",
    retryable: false,
  });
  const machineType = machineTypes[0]!;
  assertCertifiedProfileInput({
    machineType,
    imageFamily,
    zones,
  });
  const [types, resolvedImage, prices] = await Promise.all([
    client.resolveMachineTypes(machineType, zones),
    client.resolveImageFamily(imageFamily),
    new GcpCatalogClient(catalogApiKey, options.catalog).quoteE2Standard4(zones, 32),
  ]);
  if (types.some((type) => type.guestCpus < 4 || type.memoryMib < 16_384)) {
    throw new ProviderServiceError({
      code: "gcp_machine_type_undersized",
      message: "GCP machine type does not satisfy the Workshop requirements",
      retryable: false,
    });
  }
  return {
    observedAt: now(options).toISOString(),
    machineTypes: types,
    resolvedImage,
    prices,
  };
}

async function validateConnectionSetup(
  client: GcpClient,
  foundation?: ConnectGcpProjectRequest["foundation"],
): Promise<{
  identity: GcpProjectIdentity;
  inventory: GcpProjectInventory;
  validation: GcpProjectValidation;
}> {
  const identity = await client.inspectIdentity();
  const [enabledServices, grantedPermissions, quotas] = await Promise.all([
    client.assertRequiredServices(identity.projectNumber),
    client.assertRequiredIamPermissions(),
    client.assertMinimumQuotas(),
  ]);
  const inventory = await client.inventory();
  if (foundation) client.assertDedicatedProject(inventory, foundation);
  const validation: GcpProjectValidation = {
    enabledServices,
    grantedPermissions,
    quotas,
  };
  return { identity, inventory, validation };
}

async function inspectConnectedProject(
  client: GcpClient,
  foundation: ConnectGcpProjectRequest["foundation"],
  runtimeConnectionOwnership: ProviderOwnership,
): Promise<GcpOperationalConnectionInspection> {
  const identity = await client.inspectIdentity();
  const [grantedCleanupPermissions, inventory] = await Promise.all([
    client.assertCleanupIamPermissions(),
    client.inventory(),
  ]);
  return {
    identity,
    inventory,
    validation: { grantedCleanupPermissions },
    classification: classifyOperationalInventory(
      inventory,
      foundation,
      runtimeConnectionOwnership,
    ),
  };
}

export async function connectProject(
  request: ConnectGcpProjectRequest,
  kekSecret: string,
  deployment: GcpProviderDeployment,
  options: GcpProviderRuntimeOptions = {},
): Promise<ConnectGcpProjectResult> {
  assertRequestIdentity(request);
  const catalogApiKey = requireNewWorkCatalog(deployment);
  const key = parseServiceAccountKey(request.serviceAccountKeyJson);
  const client = new GcpClient(key, request.projectId, options.api);
  const { identity, inventory, validation } = await validateConnectionSetup(
    client,
    request.foundation,
  );
  const catalog = await observeCatalog(
    client,
    catalogApiKey,
    request.requiredMachineTypes,
    request.permittedZones,
    request.imageFamily,
    options,
  );
  const foundation = await client.ensureFoundation(request.foundation);
  const credential = await sealGcpCredential(
    request.serviceAccountKeyJson,
    kekSecret,
    request.credentialContext,
    now(options),
  );
  return {
    credential,
    identity,
    inventory,
    validation,
    catalog,
    foundation,
    canonicalWrites: foundationWrites(request, foundation, options),
  };
}

export async function rotateCredential(
  request: RotateGcpCredentialRequest,
  kekSecret: string,
  deployment: GcpProviderDeployment,
  options: GcpProviderRuntimeOptions = {},
): Promise<RotateGcpCredentialResult> {
  assertRequestIdentity(request);
  // Credential rotation is cleanup authority recovery, not issuance. Keep it
  // available in dormant mode, while still rejecting an unknown deployment.
  const mode = deploymentMode(deployment);
  const key = parseServiceAccountKey(request.serviceAccountKeyJson);
  const client = new GcpClient(key, request.projectId, options.api);
  const identity = await client.inspectIdentity();
  if (mode === "active") {
    await Promise.all([
      client.assertRequiredServices(identity.projectNumber),
      client.assertRequiredIamPermissions(),
    ]);
  } else {
    await client.assertCleanupIamPermissions();
  }
  const sentinelNetwork = await client.observeResource(request.sentinelNetworkSelfLink);
  if (
    !sentinelNetwork ||
    sentinelNetwork.description !== ownershipMarker(request.ownership)
  ) {
    throw new ProviderServiceError({
      code: "gcp_rotation_project_mismatch",
      message: "New GCP credential cannot see the same-project Intar sentinel",
      retryable: false,
    });
  }
  const credential = await sealGcpCredential(
    request.serviceAccountKeyJson,
    kekSecret,
    request.credentialContext,
    now(options),
  );
  return {
    credential,
    identity,
    sentinelNetwork,
    authority: mode === "active" ? "active" : "cleanup_only",
  };
}

function allocationWrites(
  request: RunGcpOperationRequest,
  observation: GcpAllocationObservation,
  options: GcpProviderRuntimeOptions,
): CanonicalProviderWrite[] {
  const instanceName = request.operation.kind === "observe_allocation"
    ? request.operation.instanceName
    : request.operation.kind === "create_instance"
      ? request.operation.name
      : observation.instance?.name ?? "missing";
  const bootDiskName = request.operation.kind === "observe_allocation"
    ? request.operation.bootDiskName ?? instanceName
    : instanceName;
  const location = request.operation.kind === "observe_allocation" ||
      request.operation.kind === "create_instance"
    ? request.operation.zone
    : undefined;
  if (observation.status === "ownership_mismatch") return [];
  if (observation.status === "missing") {
    const result = [write(request, options, {
      operation: "resource_deleted",
      resourceKind: "instance",
      externalId: instanceName,
      name: instanceName,
      operationIds: [],
      state: "deleted",
      ...(location ? { location } : {}),
    }), write(request, options, {
      operation: "resource_deleted",
      resourceKind: "ipv4",
      externalId: `${instanceName}:ephemeral-ipv4`,
      name: `${instanceName}-ephemeral-ipv4`,
      operationIds: [],
      state: "deleted",
      ...(location ? { location } : {}),
    })];
    result.push(write(request, options, observation.bootDisk
      ? {
          operation: "resource_observed",
          resourceKind: "boot_disk",
          externalId: observation.bootDisk.id,
          name: observation.bootDisk.name,
          operationIds: [],
          state: observation.bootDisk.status ?? "present",
          ...(observation.bootDisk.zone ? { location: observation.bootDisk.zone } : {}),
        }
      : {
          operation: "resource_deleted",
          resourceKind: "boot_disk",
          externalId: bootDiskName,
          name: bootDiskName,
          operationIds: [],
          state: "deleted",
          ...(location ? { location } : {}),
        }));
    return result;
  }
  if (!observation.instance) return [];
  const result = [write(request, options, {
    operation: "resource_observed",
    resourceKind: "instance",
    externalId: observation.instance.id,
    name: observation.instance.name,
    operationIds: [],
    state: observation.instance.status ?? "present",
    ...(observation.publicIpv4 ? { publicIpv4: observation.publicIpv4 } : {}),
    ...(observation.instance.zone ? { location: observation.instance.zone } : {}),
  })];
  if (observation.bootDisk) {
    result.push(write(request, options, {
      operation: "resource_observed",
      resourceKind: "boot_disk",
      externalId: observation.bootDisk.id,
      name: observation.bootDisk.name,
      operationIds: [],
      state: observation.bootDisk.status ?? "present",
      ...(observation.bootDisk.zone ? { location: observation.bootDisk.zone } : {}),
    }));
  }
  if (observation.publicIpv4) {
    // GCP's ephemeral external IPv4 has no standalone Address resource ID,
    // but it is independently billable. Give the generic harness a stable,
    // instance-scoped identity so cost rounding and deletion are accounted for
    // separately from compute and the auto-delete boot disk.
    result.push(write(request, options, {
      operation: "resource_observed",
      resourceKind: "ipv4",
      externalId: `${observation.instance.id}:ephemeral-ipv4`,
      name: `${observation.instance.name}-ephemeral-ipv4`,
      operationIds: [],
      state: "present",
      publicIpv4: observation.publicIpv4,
      ...(observation.instance.zone ? { location: observation.instance.zone } : {}),
    }));
  }
  return result;
}

export async function runOperation(
  request: RunGcpOperationRequest,
  kekSecret: string,
  deployment: GcpProviderDeployment,
  options: GcpProviderRuntimeOptions = {},
): Promise<ProviderOperationResult> {
  assertRequestIdentity(request);
  const operation: GcpProviderOperation = request.operation;
  let catalogApiKey: string | undefined;
  if (operationStartsNewWork(operation.kind)) {
    catalogApiKey = requireNewWorkCatalog(deployment);
  } else {
    // Existing-allocation reconciliation and cleanup must remain reachable even
    // when production is deliberately returned to dormant mode.
    deploymentMode(deployment);
  }
  const key = await openGcpCredential(request.credential, kekSecret, request.credentialContext);
  const client = new GcpClient(key, request.projectId, options.api);
  switch (operation.kind) {
    case "inspect_connection": {
      return {
        data: await inspectConnectedProject(client, operation.foundation, {
          organizationRef: request.credentialContext.organizationId,
          connectionRef: request.connectionId,
          purpose: "learner_workspace",
        }),
        canonicalWrites: [],
        mustPersistBeforeNextOperation: false,
      };
    }
    case "resolve_profile": {
      assertCertifiedProfileInput({
        machineType: operation.machineType,
        imageFamily: operation.imageFamily,
        zones: operation.zones,
      });
      const [machineTypes, resolvedImage] = await Promise.all([
        client.resolveMachineTypes(operation.machineType, operation.zones),
        client.resolveImageFamily(operation.imageFamily),
      ]);
      return {
        data: { machineTypes, resolvedImage },
        canonicalWrites: [],
        mustPersistBeforeNextOperation: false,
      };
    }
    case "quote": {
      assertCertifiedProfileInput({
        machineType: operation.machineType,
        zones: operation.zones,
      });
      const data = await new GcpCatalogClient(catalogApiKey, options.catalog)
        .quoteE2Standard4(operation.zones, operation.rootDiskGib);
      return { data, canonicalWrites: [], mustPersistBeforeNextOperation: false };
    }
    case "preflight_capacity": {
      assertCertifiedProfileInput({
        machineType: operation.machineType,
        zones: operation.zones,
      });
      if (
        operation.rootDiskType !== "pd-balanced" ||
        !Number.isSafeInteger(operation.rootDiskGib) ||
        operation.rootDiskGib < 1 ||
        !Number.isSafeInteger(operation.requestedSeats) ||
        operation.requestedSeats < 0
      ) {
        throw new ProviderServiceError({
          code: "invalid_provider_request",
          message: "GCP capacity preflight requirements are invalid",
          retryable: false,
        });
      }
      const machineTypes = await client.resolveMachineTypes(
        operation.machineType,
        operation.zones,
      );
      const cpuPerSeat = machineTypes[0]?.guestCpus;
      if (
        !Number.isSafeInteger(cpuPerSeat) ||
        !cpuPerSeat ||
        machineTypes.some((machineType) => machineType.guestCpus !== cpuPerSeat)
      ) {
        throw new ProviderServiceError({
          code: "gcp_machine_type_changed",
          message: "GCP machine type CPU shape is unavailable or inconsistent",
          retryable: false,
        });
      }
      const capacity = await client.observeCapacity({
        requestedSeats: operation.requestedSeats,
        cpuPerSeat,
        instancesPerSeat: 1,
        addressesPerSeat: 1,
        diskGibPerSeat: operation.rootDiskGib,
      });
      const data: GcpCapacityObservation = {
        observedAt: now(options).toISOString(),
        requestedSeats: operation.requestedSeats,
        availableSeats: capacity.availableSeats,
        preferredLocation: operation.zones[0] ?? null,
        availableLocations: [...operation.zones],
        capacityBasis:
          capacity.availableSeats >= operation.requestedSeats
            ? "quantitative_quota"
            : "unavailable",
        reasons: capacity.reasons,
        quotas: capacity.quotas,
        cpuPerSeat,
        instancesPerSeat: 1,
        addressesPerSeat: 1,
        diskGibPerSeat: operation.rootDiskGib,
      };
      return {
        data,
        canonicalWrites: [],
        mustPersistBeforeNextOperation: false,
      };
    }
    case "ensure_foundation": {
      const data = await client.ensureFoundation(operation.foundation);
      const canonicalWrites = foundationWrites(request, data, options);
      return { data, canonicalWrites, mustPersistBeforeNextOperation: canonicalWrites.length > 0 };
    }
    case "create_instance": {
      const data = await client.advanceInstance(operation);
      if (data.outcome === "created" && !data.operation.targetId) {
        throw new ProviderServiceError({
          code: "gcp_operation_target_missing",
          message: "GCP create operation has no stable target identity",
          retryable: true,
        });
      }
      const canonicalWrites = data.outcome === "reconciled"
        ? allocationWrites(request, data.observation, options)
        : [
            write(request, options, {
              operation: "resource_created",
              resourceKind: "instance",
              externalId: data.operation.targetId!,
              name: operation.name,
              operationIds: [data.operation.id],
              state: "provisioning",
              location: operation.zone,
            }),
            operationWrite(request, data.operation, options),
          ];
      return { data, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "observe_operation": {
      const data = await client.observeOperation(operation.operationSelfLink);
      return {
        data,
        canonicalWrites: [operationWrite(request, data, options)],
        mustPersistBeforeNextOperation: true,
      };
    }
    case "observe_allocation": {
      const data = await client.observeAllocation(
        operation.zone,
        operation.instanceName,
        operation.ownership,
        operation.bootDiskName,
      );
      const canonicalWrites = allocationWrites(request, data, options);
      return { data, canonicalWrites, mustPersistBeforeNextOperation: canonicalWrites.length > 0 };
    }
    case "reboot_instance": {
      const data = await client.rebootInstance(
        operation.zone,
        operation.instanceName,
        operation.ownership,
      );
      return {
        data,
        canonicalWrites: [operationWrite(request, data, options)],
        mustPersistBeforeNextOperation: true,
      };
    }
    case "delete_instance": {
      const data = await client.deleteInstance(
        operation.zone,
        operation.instanceName,
        operation.ownership,
      );
      const canonicalWrites = [write(request, options, {
        operation: data ? "resource_deletion_requested" : "resource_deleted",
        resourceKind: "instance",
        externalId: operation.instanceName,
        name: operation.instanceName,
        operationIds: data ? [data.id] : [],
        state: data ? "deleting" : "deleted",
        location: operation.zone,
      }), ...(data ? [operationWrite(request, data, options)] : [])];
      return { data, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "delete_disk": {
      const data = await client.deleteDisk(
        operation.zone,
        operation.diskName,
        operation.ownership,
      );
      const canonicalWrites = [write(request, options, {
        operation: data ? "resource_deletion_requested" : "resource_deleted",
        resourceKind: "boot_disk",
        externalId: operation.diskName,
        name: operation.diskName,
        operationIds: data ? [data.id] : [],
        state: data ? "deleting" : "deleted",
        location: operation.zone,
      }), ...(data ? [operationWrite(request, data, options)] : [])];
      return { data, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "sweep": {
      const data = await client.sweep(operation.ownership);
      return { data, canonicalWrites: [], mustPersistBeforeNextOperation: false };
    }
  }
}
