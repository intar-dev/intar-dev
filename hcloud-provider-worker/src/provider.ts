import type {
  CanonicalProviderWrite,
  ConnectProjectRequest,
  ConnectProjectResult,
  HcloudAction,
  HcloudOperationResult,
  ReconcileResult,
  RotateCredentialRequest,
  RotateCredentialResult,
  RunOperationRequest,
} from "./contracts";
import { openCredential, parseKek, sealCredential } from "./crypto";
import {
  HcloudClient,
  labelsMatchOwnership,
  type HcloudClientOptions,
} from "./hcloud-client";
import { ProviderServiceError } from "./redaction";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/u;

export interface ProviderRuntimeOptions {
  client?: HcloudClientOptions;
  now?: () => Date;
}

function assertRequestIdentity(input: {
  requestId: string;
  connectionId: string;
  credentialContext: { connectionId: string };
}): void {
  if (
    !REQUEST_ID_PATTERN.test(input.requestId) ||
    !input.connectionId ||
    input.connectionId !== input.credentialContext.connectionId
  ) {
    throw new ProviderServiceError({
      code: "invalid_provider_request",
      message: "Provider request identity is invalid",
      retryable: false,
    });
  }
}

function observedAt(options: ProviderRuntimeOptions): string {
  return (options.now?.() ?? new Date()).toISOString();
}

function canonicalWrite(
  request: { requestId: string; connectionId: string },
  input: Omit<CanonicalProviderWrite, "requestId" | "connectionId" | "observedAt">,
  options: ProviderRuntimeOptions,
): CanonicalProviderWrite {
  return {
    requestId: request.requestId,
    connectionId: request.connectionId,
    observedAt: observedAt(options),
    ...input,
  };
}

function actionWrite(
  request: { requestId: string; connectionId: string },
  action: HcloudAction,
  options: ProviderRuntimeOptions,
): CanonicalProviderWrite {
  return canonicalWrite(
    request,
    {
      operation: "action_observed",
      resourceKind: "action",
      externalId: action.id,
      actionIds: [action.id],
      state: action.status,
    },
    options,
  );
}

function withKek<T>(secret: string, work: (kek: Uint8Array) => Promise<T>): Promise<T> {
  const kek = parseKek(secret);
  return work(kek).finally(() => kek.fill(0));
}

export async function connectProject(
  request: ConnectProjectRequest,
  kekSecret: string,
  options: ProviderRuntimeOptions = {},
): Promise<ConnectProjectResult> {
  assertRequestIdentity(request);
  const client = new HcloudClient(request.token, options.client);
  const inventory = await client.inventory();
  client.assertDedicatedProject(inventory, {
    name: request.sentinel.name,
    ownership: request.sentinel.ownership,
  });
  const catalog = await client.observeCatalog({
    requiredServerTypes: request.requiredServerTypes,
    permittedLocations: request.permittedLocations,
    systemImage: request.systemImage,
  });
  const sentinelResult = await client.ensureSentinel(request.sentinel);
  const credential = await withKek(kekSecret, (kek) =>
    sealCredential(request.token, kek, request.credentialContext, {
      now: options.now?.() ?? new Date(),
    }),
  );

  const canonicalWrites = [
    canonicalWrite(
      request,
      {
        operation: sentinelResult.created ? "resource_created" : "resource_observed",
        resourceKind: "firewall",
        externalId: sentinelResult.firewall.id,
        name: sentinelResult.firewall.name,
        actionIds: sentinelResult.actions.map((action) => action.id),
        state: "ready",
      },
      options,
    ),
    ...sentinelResult.actions.map((action) => actionWrite(request, action, options)),
  ];
  return {
    credential,
    inventory,
    catalog,
    sentinel: sentinelResult.firewall,
    canonicalWrites,
  };
}

export async function rotateCredential(
  request: RotateCredentialRequest,
  kekSecret: string,
  options: ProviderRuntimeOptions = {},
): Promise<RotateCredentialResult> {
  assertRequestIdentity(request);
  const client = new HcloudClient(request.token, options.client);
  const sentinel = await client.getFirewall(request.sentinelId);
  if (
    !sentinel ||
    sentinel.name !== request.sentinelName ||
    !labelsMatchOwnership(sentinel.labels, request.ownership)
  ) {
    throw new ProviderServiceError({
      code: "hcloud_rotation_project_mismatch",
      message: "New credential cannot see the existing same-project sentinel",
      retryable: false,
    });
  }
  const actions = await client.proveFirewallWriteAccess(sentinel);
  const credential = await withKek(kekSecret, (kek) =>
    sealCredential(request.token, kek, request.credentialContext, {
      now: options.now?.() ?? new Date(),
    }),
  );
  return {
    credential,
    sentinel,
    canonicalWrites: [
      canonicalWrite(
        request,
        {
          operation: "resource_observed",
          resourceKind: "firewall",
          externalId: sentinel.id,
          name: sentinel.name,
          actionIds: actions.map((action) => action.id),
          state: "ready",
        },
        options,
      ),
      ...actions.map((action) => actionWrite(request, action, options)),
    ],
  };
}

export async function runOperation(
  request: RunOperationRequest,
  kekSecret: string,
  options: ProviderRuntimeOptions = {},
): Promise<HcloudOperationResult> {
  assertRequestIdentity(request);
  const token = await withKek(kekSecret, (kek) =>
    openCredential(request.credential, kek, request.credentialContext),
  );
  const client = new HcloudClient(token, options.client);
  const operation = request.operation;

  switch (operation.kind) {
    case "inventory": {
      return { data: await client.inventory(), canonicalWrites: [], mustPersistBeforeNextOperation: false };
    }
    case "catalog": {
      return {
        data: await client.observeCatalog(operation),
        canonicalWrites: [],
        mustPersistBeforeNextOperation: false,
      };
    }
    case "ensure_sentinel": {
      const result = await client.ensureSentinel(operation.sentinel);
      const canonicalWrites = [
        canonicalWrite(
          request,
          {
            operation: result.created ? "resource_created" : "resource_observed",
            resourceKind: "firewall",
            externalId: result.firewall.id,
            name: result.firewall.name,
            actionIds: result.actions.map((action) => action.id),
            state: "ready",
          },
          options,
        ),
        ...result.actions.map((action) => actionWrite(request, action, options)),
      ];
      return {
        data: result,
        canonicalWrites,
        mustPersistBeforeNextOperation: canonicalWrites.length > 0,
      };
    }
    case "create_primary_ip": {
      const result = await client.createPrimaryIp(operation);
      const actionIds = result.action ? [result.action.id] : [];
      const canonicalWrites = [
        canonicalWrite(
          request,
          {
            operation: "resource_created",
            resourceKind: "primary_ip",
            externalId: result.primaryIp.id,
            name: result.primaryIp.name,
            actionIds,
            state: result.primaryIp.assignee_id ? "assigned" : "unassigned",
            publicIpv4: result.primaryIp.ip,
            ...(result.resourceCreatedAt
              ? { resourceCreatedAt: result.resourceCreatedAt }
              : {}),
          },
          options,
        ),
        ...(result.action ? [actionWrite(request, result.action, options)] : []),
      ];
      return { data: result, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "create_ssh_key": {
      const result = await client.createSshKey(operation);
      const canonicalWrites = [
        canonicalWrite(
          request,
          {
            operation: "resource_created",
            resourceKind: "ssh_key",
            externalId: result.sshKey.id,
            name: result.sshKey.name,
            actionIds: [],
            state: "ready",
          },
          options,
        ),
      ];
      return { data: result, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "create_server": {
      const result = await client.createServer(operation);
      const allActions = [result.action, ...result.nextActions];
      const canonicalWrites = [
        canonicalWrite(
          request,
          {
            operation: "resource_created",
            resourceKind: "server",
            externalId: result.server.id,
            name: result.server.name,
            actionIds: allActions.map((action) => action.id),
            state: result.server.status,
            publicIpv4: result.server.public_net.ipv4.ip,
            ...(result.resourceCreatedAt
              ? { resourceCreatedAt: result.resourceCreatedAt }
              : {}),
          },
          options,
        ),
        ...allActions.map((action) => actionWrite(request, action, options)),
      ];
      return { data: result, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "delete_resource": {
      const result = await client.deleteResource(operation.resourceKind, operation.externalId);
      const canonicalWrites = [
        canonicalWrite(
          request,
          {
            operation:
              result.action && !result.alreadyMissing
                ? "resource_deletion_requested"
                : "resource_deleted",
            resourceKind: operation.resourceKind,
            externalId: operation.externalId,
            ...(operation.name ? { name: operation.name } : {}),
            actionIds: result.action ? [result.action.id] : [],
            state: result.action ? "deleting" : "deleted",
          },
          options,
        ),
        ...(result.action ? [actionWrite(request, result.action, options)] : []),
      ];
      return { data: result, canonicalWrites, mustPersistBeforeNextOperation: true };
    }
    case "get_action": {
      const action = await client.waitForAction(operation.actionId, operation.maxWaitMs ?? 0);
      return {
        data: action,
        canonicalWrites: [actionWrite(request, action, options)],
        mustPersistBeforeNextOperation: true,
      };
    }
    case "reboot_server": {
      const action = await client.rebootServer(operation.serverId);
      return {
        data: action,
        canonicalWrites: [actionWrite(request, action, options)],
        mustPersistBeforeNextOperation: true,
      };
    }
    case "reconcile": {
      const result = await reconcile(client, request, operation, options);
      return { data: result, canonicalWrites: result.canonicalWrites, mustPersistBeforeNextOperation: true };
    }
  }
}

async function reconcile(
  client: HcloudClient,
  request: RunOperationRequest,
  operation: Extract<RunOperationRequest["operation"], { kind: "reconcile" }>,
  options: ProviderRuntimeOptions,
): Promise<ReconcileResult> {
  const [resources, actions] = await Promise.all([
    Promise.all(operation.resources.map((ref) => client.reconcileResource(ref))),
    Promise.all(operation.actionIds.map((actionId) => client.getAction(actionId))),
  ]);
  const canonicalWrites: CanonicalProviderWrite[] = [];
  for (const resource of resources) {
    // Never project an ambiguous or foreign same-name resource into D1. The
    // caller must stop in cleanup_pending rather than gaining an external ID
    // that a later archive could delete.
    if (
      resource.status === "ambiguous" ||
      resource.status === "ownership_mismatch"
    ) {
      continue;
    }
    const externalId = resource.externalId ?? resource.ref.externalId;
    if (externalId === undefined) continue;
    canonicalWrites.push(
      canonicalWrite(
        request,
        {
          operation: resource.status === "missing" ? "resource_deleted" : "resource_observed",
          resourceKind: resource.ref.resourceKind,
          externalId,
          name: resource.ref.deterministicName,
          actionIds: [],
          state: resource.status === "missing" ? "deleted" : resource.state ?? resource.status,
          ...(resource.publicIpv4 ? { publicIpv4: resource.publicIpv4 } : {}),
          ...(resource.resourceCreatedAt
            ? { resourceCreatedAt: resource.resourceCreatedAt }
            : {}),
        },
        options,
      ),
    );
  }
  canonicalWrites.push(...actions.map((action) => actionWrite(request, action, options)));
  return {
    observedAt: observedAt(options),
    resources,
    actions,
    canonicalWrites,
  };
}
