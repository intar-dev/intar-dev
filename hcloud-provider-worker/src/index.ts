import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type {
  ConnectProjectRequest,
  ConnectProjectResult,
  HcloudOperationResult,
  ProviderRpcResult,
  ReconcileResult,
  RotateCredentialRequest,
  RotateCredentialResult,
  RunOperationRequest,
  ServiceErrorShape,
} from "./contracts";
import {
  connectProject as connectProjectWithProvider,
  rotateCredential as rotateCredentialWithProvider,
  runOperation as runProviderOperation,
} from "./provider";
import { safeUnknownError } from "./redaction";

export class HcloudConnectionDO extends DurableObject<Env> {
  // External API calls can exceed blockConcurrencyWhile's 30-second ceiling.
  // This per-object chain preserves ordering; D1 reconciliation covers a crash.
  #operationTail: Promise<void> = Promise.resolve();

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #execute<T>(operation: () => Promise<T>): Promise<ProviderRpcResult<T>> {
    try {
      return { ok: true, value: await this.#serialize(operation) };
    } catch (error) {
      return { ok: false, error: safeUnknownError(error) };
    }
  }

  async connectProject(
    request: ConnectProjectRequest,
  ): Promise<ProviderRpcResult<ConnectProjectResult>> {
    return this.#execute(() =>
      connectProjectWithProvider(request, this.env.PROVIDER_CREDENTIAL_KEK_V1),
    );
  }

  async rotateCredential(
    request: RotateCredentialRequest,
  ): Promise<ProviderRpcResult<RotateCredentialResult>> {
    return this.#execute(() =>
      rotateCredentialWithProvider(request, this.env.PROVIDER_CREDENTIAL_KEK_V1),
    );
  }

  async runOperation(
    request: RunOperationRequest,
  ): Promise<ProviderRpcResult<HcloudOperationResult>> {
    return this.#execute(() =>
      runProviderOperation(request, this.env.PROVIDER_CREDENTIAL_KEK_V1),
    );
  }

  async reconcile(request: RunOperationRequest): Promise<ProviderRpcResult<ReconcileResult>> {
    return this.#execute(async () => {
      if (request.operation.kind !== "reconcile") {
        throw new TypeError("Reconcile operation required");
      }
      const result = await runProviderOperation(
        request,
        this.env.PROVIDER_CREDENTIAL_KEK_V1,
      );
      return result.data as ReconcileResult;
    });
  }
}

export class HcloudProviderService extends WorkerEntrypoint<Env> {
  #connection(connectionId: string): DurableObjectStub<HcloudConnectionDO> {
    if (!/^[A-Za-z0-9._-]{8,128}$/u.test(connectionId)) throw new TypeError("Invalid connection id");
    return this.env.HCLOUD_CONNECTIONS.getByName(`hcloud:${connectionId}`);
  }

  async #call<T>(
    connectionId: string,
    call: (
      connection: DurableObjectStub<HcloudConnectionDO>,
    ) => PromiseLike<ProviderRpcResult<T>>,
  ): Promise<ProviderRpcResult<T>> {
    let connection: DurableObjectStub<HcloudConnectionDO>;
    try {
      connection = this.#connection(connectionId);
    } catch (error) {
      return { ok: false, error: safeUnknownError(error) };
    }
    try {
      return await call(connection);
    } catch {
      return { ok: false, error: rpcUnavailableError() };
    }
  }

  async connectProject(
    request: ConnectProjectRequest,
  ): Promise<ProviderRpcResult<ConnectProjectResult>> {
    return this.#call(request.connectionId, (connection) =>
      connection.connectProject(request),
    );
  }

  async rotateCredential(
    request: RotateCredentialRequest,
  ): Promise<ProviderRpcResult<RotateCredentialResult>> {
    return this.#call(request.connectionId, (connection) =>
      connection.rotateCredential(request),
    );
  }

  async runOperation(
    request: RunOperationRequest,
  ): Promise<ProviderRpcResult<HcloudOperationResult>> {
    return this.#call(request.connectionId, (connection) =>
      connection.runOperation(request),
    );
  }

  // The website's minute cron calls this with D1-canonical resource IDs/names.
  // No allocation state is retained in Durable Object storage.
  async reconcile(request: RunOperationRequest): Promise<ProviderRpcResult<ReconcileResult>> {
    return this.#call(request.connectionId, (connection) =>
      connection.reconcile(request),
    );
  }
}

function rpcUnavailableError(): ServiceErrorShape {
  return {
    code: "provider_rpc_unavailable",
    message: "Hetzner provider coordination is temporarily unavailable",
    retryable: true,
  };
}

export default HcloudProviderService;
